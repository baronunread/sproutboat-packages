/*
 * crypto.subtle, native half. Compiled into the embedded transport (standalone binaries and
 * sproutd), where BearSSL 0.6 (MIT) is already linked, and Monocypher 4.0.2 (BSD-2-Clause or
 * CC0) supplies Ed25519 and X25519, which BearSSL does not have. See subtle/README.md.
 *
 * Nothing in this file does primitive math. RSA, ECDSA, hashes, HMAC and HKDF are BearSSL's;
 * Ed25519 and X25519 are Monocypher's. What is here is composition (PKCS#1 PSS encoding,
 * PBKDF2, key framing, DER for the key formats WebCrypto needs) and argument checking.
 *
 * One entry point, sbc_op(), so the JavaScript side marshals once: every argument and result is
 * a byte string. Errors are small integers the JS side maps to DOMException names.
 *
 * No backslash-newline, backtick or dollar-brace here: the file is spliced into a JS template.
 */

#define SBC_OK 0
#define SBC_DATA 1      /* DataError: the key bytes are not what the format says */
#define SBC_OPERATION 2 /* OperationError: the operation failed */
#define SBC_NOTSUP 3    /* NotSupportedError */

typedef unsigned char sbc_u8;

/* ---- randomness: the OS CSPRNG, behind BearSSL's PRNG interface ---------------------------- */

static int sbc_rand(void* out, size_t n) {
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, (sbc_u8*)out + got, n - got);
    if (r <= 0) { close(fd); return 0; }
    got += (size_t)r;
  }
  close(fd);
  return 1;
}
static void sbc_prng_init(const br_prng_class** c, const void* params, const void* seed, size_t len) { (void)c; (void)params; (void)seed; (void)len; }
static void sbc_prng_generate(const br_prng_class** c, void* out, size_t len) {
  (void)c;
  if (!sbc_rand(out, len)) abort(); /* no entropy: never hand back predictable key material */
}
static void sbc_prng_update(const br_prng_class** c, const void* seed, size_t len) { (void)c; (void)seed; (void)len; }
static const br_prng_class sbc_prng_vtable = { sizeof(br_prng_class*), sbc_prng_init, sbc_prng_generate, sbc_prng_update };
static const br_prng_class* sbc_prng = &sbc_prng_vtable;

/* ---- small helpers ------------------------------------------------------------------------- */

static const br_hash_class* sbc_hash(int bits) {
  switch (bits) {
    case 1: return &br_sha1_vtable;
    case 256: return &br_sha256_vtable;
    case 384: return &br_sha384_vtable;
    case 512: return &br_sha512_vtable;
  }
  return 0;
}
static const unsigned char* sbc_hash_oid(int bits) {
  switch (bits) {
    case 1: return BR_HASH_OID_SHA1;
    case 256: return BR_HASH_OID_SHA256;
    case 384: return BR_HASH_OID_SHA384;
    case 512: return BR_HASH_OID_SHA512;
  }
  return 0;
}
static size_t sbc_hlen(int bits) { return bits == 1 ? 20 : (size_t)bits / 8; }

/* One-shot hash: out holds sbc_hlen(bits) bytes. */
static int sbc_digest(int bits, const sbc_u8* m, size_t ml, sbc_u8* out) {
  const br_hash_class* hc = sbc_hash(bits);
  if (!hc) return 0;
  br_hash_compat_context ctx;
  hc->init(&ctx.vtable);
  hc->update(&ctx.vtable, m, ml);
  hc->out(&ctx.vtable, out);
  return 1;
}

/* The parameter string: decimal numbers separated by commas. */
static long sbc_param(const sbc_u8* p, size_t pl, int idx) {
  long v = 0; int cur = 0; int any = 0;
  for (size_t i = 0; i <= pl; i++) {
    if (i == pl || p[i] == ',') {
      if (cur == idx) return any ? v : -1;
      cur++; v = 0; any = 0;
    } else if (p[i] >= '0' && p[i] <= '9') { v = v * 10 + (p[i] - '0'); any = 1; }
  }
  return -1;
}

static int sbc_ct_eq(const sbc_u8* a, const sbc_u8* b, size_t n) {
  sbc_u8 d = 0;
  for (size_t i = 0; i < n; i++) d |= (sbc_u8)(a[i] ^ b[i]);
  return d == 0;
}

/* A growing output buffer. */
typedef struct { sbc_u8* p; size_t n; size_t cap; int bad; } sbc_buf;
static void sbc_put(sbc_buf* b, const void* d, size_t n) {
  if (b->bad) return;
  if (b->n + n > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->n + n) cap *= 2;
    sbc_u8* g = (sbc_u8*)realloc(b->p, cap);
    if (!g) { b->bad = 1; return; }
    b->p = g; b->cap = cap;
  }
  if (n) memcpy(b->p + b->n, d, n);
  b->n += n;
}
static void sbc_put1(sbc_buf* b, sbc_u8 v) { sbc_put(b, &v, 1); }
/* A field: u32 big-endian length, then the bytes. */
static void sbc_field(sbc_buf* b, const void* d, size_t n) {
  sbc_u8 h[4] = { (sbc_u8)(n >> 24), (sbc_u8)(n >> 16), (sbc_u8)(n >> 8), (sbc_u8)n };
  sbc_put(b, h, 4); sbc_put(b, d, n);
}
/* The next field of a framed list, or 0 when the list is malformed. */
static int sbc_next(const sbc_u8** p, size_t* left, const sbc_u8** f, size_t* fl) {
  if (*left < 4) return 0;
  size_t n = ((size_t)(*p)[0] << 24) | ((size_t)(*p)[1] << 16) | ((size_t)(*p)[2] << 8) | (*p)[3];
  if (n > *left - 4) return 0;
  *f = *p + 4; *fl = n; *p += 4 + n; *left -= 4 + n;
  return 1;
}
/* Big-endian integer with leading zeros stripped (a zero stays one zero byte, as DER wants it). */
static void sbc_strip(const sbc_u8** p, size_t* n) {
  while (*n > 1 && **p == 0) { (*p)++; (*n)--; }
}

/* ---- DER ----------------------------------------------------------------------------------- */

static void sbc_der_len(sbc_buf* b, size_t n) {
  if (n < 128) { sbc_put1(b, (sbc_u8)n); }
  else if (n < 256) { sbc_put1(b, 0x81); sbc_put1(b, (sbc_u8)n); }
  else if (n < 65536) { sbc_put1(b, 0x82); sbc_put1(b, (sbc_u8)(n >> 8)); sbc_put1(b, (sbc_u8)n); }
  else { sbc_put1(b, 0x83); sbc_put1(b, (sbc_u8)(n >> 16)); sbc_put1(b, (sbc_u8)(n >> 8)); sbc_put1(b, (sbc_u8)n); }
}
static void sbc_der_tlv(sbc_buf* b, sbc_u8 tag, const void* d, size_t n) {
  sbc_put1(b, tag); sbc_der_len(b, n); sbc_put(b, d, n);
}
/* A positive INTEGER from unsigned big-endian bytes. */
static void sbc_der_uint(sbc_buf* b, const sbc_u8* d, size_t n) {
  sbc_strip(&d, &n);
  sbc_put1(b, 0x02);
  int pad = (d[0] & 0x80) ? 1 : 0;
  sbc_der_len(b, n + (size_t)pad);
  if (pad) sbc_put1(b, 0);
  sbc_put(b, d, n);
}
/* Reads one TLV at *p; the content is [*c, *c + *cl). Definite lengths only. */
static int sbc_der_read(const sbc_u8** p, size_t* left, sbc_u8* tag, const sbc_u8** c, size_t* cl) {
  if (*left < 2) return 0;
  *tag = (*p)[0];
  size_t n = (*p)[1], hl = 2;
  if (n & 0x80) {
    size_t k = n & 0x7f;
    if (k == 0 || k > 3 || *left < 2 + k) return 0;
    n = 0;
    for (size_t i = 0; i < k; i++) n = (n << 8) | (*p)[2 + i];
    hl = 2 + k;
  }
  if (n > *left - hl) return 0;
  *c = *p + hl; *cl = n; *p += hl + n; *left -= hl + n;
  return 1;
}

/* OID content bytes. */
static const sbc_u8 sbc_oid_rsa[] = { 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01 };
static const sbc_u8 sbc_oid_ec[] = { 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01 };
static const sbc_u8 sbc_oid_p256[] = { 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07 };
static const sbc_u8 sbc_oid_p384[] = { 0x2b, 0x81, 0x04, 0x00, 0x22 };
static const sbc_u8 sbc_oid_p521[] = { 0x2b, 0x81, 0x04, 0x00, 0x23 };
static const sbc_u8 sbc_oid_ed25519[] = { 0x2b, 0x65, 0x70 };
static const sbc_u8 sbc_oid_x25519[] = { 0x2b, 0x65, 0x6e };

/* Key kinds, as the JS side sees them. */
#define SBC_K_RSA 1
#define SBC_K_EC 2
#define SBC_K_ED25519 3
#define SBC_K_X25519 4

static int sbc_oid_eq(const sbc_u8* a, size_t al, const sbc_u8* b, size_t bl) { return al == bl && memcmp(a, b, al) == 0; }

/* Curve codes used on the wire to JS: 1 = P-256, 2 = P-384, 3 = P-521. */
static int sbc_curve_br(int c) { return c == 1 ? BR_EC_secp256r1 : c == 2 ? BR_EC_secp384r1 : c == 3 ? BR_EC_secp521r1 : 0; }
static int sbc_curve_from_br(int c) { return c == BR_EC_secp256r1 ? 1 : c == BR_EC_secp384r1 ? 2 : c == BR_EC_secp521r1 ? 3 : 0; }
static size_t sbc_curve_size(int c) { return c == 1 ? 32 : c == 2 ? 48 : c == 3 ? 66 : 0; }
static void sbc_curve_oid(int c, const sbc_u8** o, size_t* n) {
  if (c == 1) { *o = sbc_oid_p256; *n = sizeof sbc_oid_p256; }
  else if (c == 2) { *o = sbc_oid_p384; *n = sizeof sbc_oid_p384; }
  else { *o = sbc_oid_p521; *n = sizeof sbc_oid_p521; }
}

/* SubjectPublicKeyInfo -> kind, curve and key bytes. For RSA the bytes are the RSAPublicKey
 * SEQUENCE content; for EC the uncompressed point; for the 25519 keys the 32 bytes. */
static int sbc_spki_parse(const sbc_u8* der, size_t len, int* kind, int* curve, const sbc_u8** key, size_t* keylen) {
  const sbc_u8 *p = der, *c, *alg, *q;
  size_t left = len, cl, algl, ql;
  sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &alg, &algl) || t != 0x30) return 0;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x03 || left != 0 || ql < 1 || q[0] != 0) return 0;
  *key = q + 1; *keylen = ql - 1;
  const sbc_u8 *ap = alg, *oid, *par;
  size_t al = algl, oidl, parl = 0;
  if (!sbc_der_read(&ap, &al, &t, &oid, &oidl) || t != 0x06) return 0;
  if (sbc_oid_eq(oid, oidl, sbc_oid_rsa, sizeof sbc_oid_rsa)) {
    if (al) { if (!sbc_der_read(&ap, &al, &t, &par, &parl) || t != 0x05 || parl != 0 || al != 0) return 0; }
    *kind = SBC_K_RSA; *curve = 0; return 1;
  }
  if (sbc_oid_eq(oid, oidl, sbc_oid_ec, sizeof sbc_oid_ec)) {
    if (!sbc_der_read(&ap, &al, &t, &par, &parl) || t != 0x06 || al != 0) return 0;
    int cv = 0;
    if (sbc_oid_eq(par, parl, sbc_oid_p256, sizeof sbc_oid_p256)) cv = 1;
    else if (sbc_oid_eq(par, parl, sbc_oid_p384, sizeof sbc_oid_p384)) cv = 2;
    else if (sbc_oid_eq(par, parl, sbc_oid_p521, sizeof sbc_oid_p521)) cv = 3;
    if (!cv || *keylen != 1 + 2 * sbc_curve_size(cv) || (*key)[0] != 4) return 0;
    *kind = SBC_K_EC; *curve = cv; return 1;
  }
  if (al == 0 && *keylen == 32) {
    if (sbc_oid_eq(oid, oidl, sbc_oid_ed25519, 3)) { *kind = SBC_K_ED25519; *curve = 0; return 1; }
    if (sbc_oid_eq(oid, oidl, sbc_oid_x25519, 3)) { *kind = SBC_K_X25519; *curve = 0; return 1; }
  }
  return 0;
}

/* Wrap an algorithm identifier body and a key in a SubjectPublicKeyInfo. */
static void sbc_spki_build(sbc_buf* out, const sbc_buf* alg, const sbc_u8* key, size_t keylen) {
  sbc_buf bits = {0}, body = {0};
  sbc_put1(&bits, 0); sbc_put(&bits, key, keylen);
  sbc_der_tlv(&body, 0x30, alg->p, alg->n);
  sbc_der_tlv(&body, 0x03, bits.p, bits.n);
  sbc_der_tlv(out, 0x30, body.p, body.n);
  free(bits.p); free(body.p);
  if (bits.bad || body.bad) out->bad = 1;
}
static void sbc_alg_rsa(sbc_buf* a) { sbc_der_tlv(a, 0x06, sbc_oid_rsa, sizeof sbc_oid_rsa); sbc_der_tlv(a, 0x05, 0, 0); }
static void sbc_alg_ec(sbc_buf* a, int curve) {
  const sbc_u8* o; size_t n;
  sbc_curve_oid(curve, &o, &n);
  sbc_der_tlv(a, 0x06, sbc_oid_ec, sizeof sbc_oid_ec);
  sbc_der_tlv(a, 0x06, o, n);
}

/* ---- key decoding -------------------------------------------------------------------------- */

/* PKCS#8 for Ed25519 and X25519: SEQ { INT 0, SEQ { OID }, OCTET STRING { OCTET STRING seed } }. */
static int sbc_pkcs8_okp(const sbc_u8* der, size_t len, int* kind, const sbc_u8** seed) {
  const sbc_u8 *p = der, *c, *q;
  size_t left = len, cl, ql;
  sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x02 || ql != 1 || q[0] != 0) return 0;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x30) return 0;
  {
    const sbc_u8 *ap = q, *oid; size_t al = ql, oidl;
    if (!sbc_der_read(&ap, &al, &t, &oid, &oidl) || t != 0x06 || al != 0) return 0;
    if (sbc_oid_eq(oid, oidl, sbc_oid_ed25519, 3)) *kind = SBC_K_ED25519;
    else if (sbc_oid_eq(oid, oidl, sbc_oid_x25519, 3)) *kind = SBC_K_X25519;
    else return 0;
  }
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x04) return 0; /* trailing attributes are ignored */
  {
    const sbc_u8 *ip = q, *s; size_t il = ql, sl;
    if (!sbc_der_read(&ip, &il, &t, &s, &sl) || t != 0x04 || sl != 32 || il != 0) return 0;
    *seed = s;
  }
  return 1;
}

/* The exact bit length of an unsigned big-endian integer. */
static uint32_t sbc_bitlen(const sbc_u8* d, size_t n) {
  while (n > 0 && *d == 0) { d++; n--; }
  if (n == 0) return 0;
  uint32_t bits = (uint32_t)(n * 8);
  for (sbc_u8 top = d[0]; !(top & 0x80); top = (sbc_u8)(top << 1)) bits--;
  return bits;
}

/* An RSA private key as PKCS#8 carries it. BearSSL has a decoder for this, but it drops the public
 * exponent and recomputes it, which only works for primes that are 3 mod 4: BoringSSL and OpenSSL
 * keys often are not. So the structure is read here, and BearSSL gets the CRT parts. */
typedef struct {
  const sbc_u8 *n, *e, *d, *p, *q, *dp, *dq, *qi;
  size_t nl, el, dl, pl, ql, dpl, dql, qil;
} sbc_rsa_fields;
static int sbc_rsa_parse_pkcs8(const sbc_u8* der, size_t len, sbc_rsa_fields* k) {
  const sbc_u8 *p = der, *c, *q;
  size_t left = len, cl, ql;
  sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x02 || ql != 1 || q[0] != 0) return 0;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x30) return 0;
  {
    const sbc_u8 *ap = q, *oid; size_t al = ql, oidl;
    if (!sbc_der_read(&ap, &al, &t, &oid, &oidl) || t != 0x06 || !sbc_oid_eq(oid, oidl, sbc_oid_rsa, sizeof sbc_oid_rsa)) return 0;
  }
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x04) return 0;
  {
    const sbc_u8 *sp = q; size_t sl = ql;
    if (!sbc_der_read(&sp, &sl, &t, &c, &cl) || t != 0x30 || sl != 0) return 0;
    sp = c; sl = cl;
    if (!sbc_der_read(&sp, &sl, &t, &q, &ql) || t != 0x02 || ql != 1 || q[0] != 0) return 0;
    const sbc_u8** f[8] = { &k->n, &k->e, &k->d, &k->p, &k->q, &k->dp, &k->dq, &k->qi };
    size_t* fl[8] = { &k->nl, &k->el, &k->dl, &k->pl, &k->ql, &k->dpl, &k->dql, &k->qil };
    for (int i = 0; i < 8; i++) {
      if (!sbc_der_read(&sp, &sl, &t, f[i], fl[i]) || t != 0x02 || *fl[i] == 0 || ((*f[i])[0] & 0x80)) return 0;
      sbc_strip(f[i], fl[i]);
    }
  }
  if (sbc_bitlen(k->n, k->nl) < 512 || sbc_bitlen(k->n, k->nl) > 4096) return 0;
  return 1;
}
static void sbc_rsa_bear_key(const sbc_rsa_fields* k, br_rsa_private_key* sk) {
  sk->n_bitlen = sbc_bitlen(k->n, k->nl);
  sk->p = (sbc_u8*)k->p; sk->plen = k->pl; sk->q = (sbc_u8*)k->q; sk->qlen = k->ql;
  sk->dp = (sbc_u8*)k->dp; sk->dplen = k->dpl; sk->dq = (sbc_u8*)k->dq; sk->dqlen = k->dql;
  sk->iq = (sbc_u8*)k->qi; sk->iqlen = k->qil;
}

/* Decode a PKCS#8 or SPKI blob into fields JS turns into a JWK.
 * Result: [kind u8][curve u8][u8 is_private] then fields.
 *   RSA public:   n e                 RSA private: n e d p q dp dq qi
 *   EC public:    point               EC private:  point scalar
 *   25519 public: key                 25519 private: key seed */
static int sbc_decode(int pkcs8, const sbc_u8* der, size_t len, sbc_buf* out) {
  int kind = 0, curve = 0;
  if (!pkcs8) {
    const sbc_u8* key; size_t kl;
    if (!sbc_spki_parse(der, len, &kind, &curve, &key, &kl)) return SBC_DATA;
    sbc_put1(out, (sbc_u8)kind); sbc_put1(out, (sbc_u8)curve); sbc_put1(out, 0);
    if (kind == SBC_K_RSA) {
      const sbc_u8 *p = key, *c, *n, *e; size_t left = kl, cl, nl, el; sbc_u8 t;
      if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return SBC_DATA;
      p = c; left = cl;
      if (!sbc_der_read(&p, &left, &t, &n, &nl) || t != 0x02 || !sbc_der_read(&p, &left, &t, &e, &el) || t != 0x02 || left != 0) return SBC_DATA;
      sbc_strip(&n, &nl); sbc_strip(&e, &el);
      if (nl == 0 || el == 0 || (n[0] & 0x80 && 0)) return SBC_DATA;
      sbc_field(out, n, nl); sbc_field(out, e, el);
    } else {
      sbc_field(out, key, kl);
    }
    return SBC_OK;
  }
  {
    const sbc_u8* seed;
    if (sbc_pkcs8_okp(der, len, &kind, &seed)) {
      sbc_u8 sk[64], pk[32], s[32];
      memcpy(s, seed, 32);
      if (kind == SBC_K_ED25519) crypto_ed25519_key_pair(sk, pk, s);
      else crypto_x25519_public_key(pk, seed);
      sbc_put1(out, (sbc_u8)kind); sbc_put1(out, 0); sbc_put1(out, 1);
      sbc_field(out, pk, 32); sbc_field(out, seed, 32);
      return SBC_OK;
    }
  }
  {
    sbc_rsa_fields k;
    if (sbc_rsa_parse_pkcs8(der, len, &k)) {
      sbc_put1(out, SBC_K_RSA); sbc_put1(out, 0); sbc_put1(out, 1);
      sbc_field(out, k.n, k.nl); sbc_field(out, k.e, k.el); sbc_field(out, k.d, k.dl);
      sbc_field(out, k.p, k.pl); sbc_field(out, k.q, k.ql);
      sbc_field(out, k.dp, k.dpl); sbc_field(out, k.dq, k.dql); sbc_field(out, k.qi, k.qil);
      return SBC_OK;
    }
  }
  {
    br_skey_decoder_context* dc = (br_skey_decoder_context*)malloc(sizeof *dc);
    if (!dc) return SBC_OPERATION;
    br_skey_decoder_init(dc);
    br_skey_decoder_push(dc, der, len);
    int ty = br_skey_decoder_key_type(dc);
    int rc = SBC_DATA;
    if (ty == BR_KEYTYPE_EC) {
      const br_ec_private_key* sk = br_skey_decoder_get_ec(dc);
      int cv = sbc_curve_from_br(sk->curve);
      if (cv) {
        sbc_u8 pub[133];
        br_ec_public_key pk;
        if (br_ec_compute_pub(br_ec_get_default(), &pk, pub, sk) != 0) {
          sbc_put1(out, SBC_K_EC); sbc_put1(out, (sbc_u8)cv); sbc_put1(out, 1);
          sbc_field(out, pk.q, pk.qlen);
          /* The scalar, left padded to the field size as JWK d wants it. */
          size_t fs = sbc_curve_size(cv);
          sbc_u8 d[66]; const sbc_u8* xs = sk->x; size_t xl = sk->xlen;
          while (xl > fs && *xs == 0) { xs++; xl--; }
          if (xl <= fs) {
            memset(d, 0, fs - xl); memcpy(d + fs - xl, xs, xl);
            sbc_field(out, d, fs);
            rc = SBC_OK;
          }
        }
      }
    }
    free(dc);
    return rc;
  }
}

/* ---- key encoding -------------------------------------------------------------------------- */

/* The inverse of sbc_decode for the fields JS has after reading a JWK or generating a key.
 * kind, curve in params. fields: see sbc_decode. */
static int sbc_encode(int pkcs8, int kind, int curve, const sbc_u8* f, size_t fl, sbc_buf* out) {
  const sbc_u8 *a, *b, *c, *d, *e, *g, *h, *i;
  size_t al, bl, cl, dl, el, gl, hl, il;
  const sbc_u8* p = f; size_t left = fl;
  if (kind == SBC_K_RSA) {
    if (!sbc_next(&p, &left, &a, &al) || !sbc_next(&p, &left, &b, &bl)) return SBC_DATA; /* n e */
    sbc_strip(&a, &al); sbc_strip(&b, &bl);
    if (!pkcs8) {
      sbc_buf alg = {0}, key = {0}, seq = {0};
      sbc_alg_rsa(&alg);
      sbc_der_uint(&seq, a, al); sbc_der_uint(&seq, b, bl);
      sbc_der_tlv(&key, 0x30, seq.p, seq.n);
      sbc_spki_build(out, &alg, key.p, key.n);
      free(alg.p); free(key.p); free(seq.p);
      return SBC_OK;
    }
    if (!sbc_next(&p, &left, &c, &cl) || !sbc_next(&p, &left, &d, &dl) || !sbc_next(&p, &left, &e, &el) ||
        !sbc_next(&p, &left, &g, &gl) || !sbc_next(&p, &left, &h, &hl) || !sbc_next(&p, &left, &i, &il)) return SBC_DATA; /* d p q dp dq qi */
    br_rsa_private_key sk; br_rsa_public_key pk;
    sbc_strip(&d, &dl); sbc_strip(&e, &el); sbc_strip(&g, &gl); sbc_strip(&h, &hl); sbc_strip(&i, &il);
    /* BearSSL's encoder wants the modulus bit length to be exact. */
    uint32_t bits = (uint32_t)(al * 8);
    { sbc_u8 top = a[0]; while (!(top & 0x80)) { bits--; top = (sbc_u8)(top << 1); } }
    sk.n_bitlen = bits;
    sk.p = (sbc_u8*)d; sk.plen = dl; sk.q = (sbc_u8*)e; sk.qlen = el;
    sk.dp = (sbc_u8*)g; sk.dplen = gl; sk.dq = (sbc_u8*)h; sk.dqlen = hl; sk.iq = (sbc_u8*)i; sk.iqlen = il;
    pk.n = (sbc_u8*)a; pk.nlen = al; pk.e = (sbc_u8*)b; pk.elen = bl;
    size_t need = br_encode_rsa_pkcs8_der(0, &sk, &pk, c, cl);
    sbc_u8* dst = (sbc_u8*)malloc(need);
    if (!dst) return SBC_OPERATION;
    br_encode_rsa_pkcs8_der(dst, &sk, &pk, c, cl);
    sbc_put(out, dst, need);
    free(dst);
    return SBC_OK;
  }
  if (kind == SBC_K_EC) {
    size_t fs = sbc_curve_size(curve);
    if (!fs || !sbc_next(&p, &left, &a, &al)) return SBC_DATA; /* point */
    if (!pkcs8) {
      if (al != 1 + 2 * fs || a[0] != 4) return SBC_DATA;
      sbc_buf alg = {0};
      sbc_alg_ec(&alg, curve);
      sbc_spki_build(out, &alg, a, al);
      free(alg.p);
      return SBC_OK;
    }
    if (!sbc_next(&p, &left, &b, &bl) || bl != fs) return SBC_DATA; /* scalar */
    br_ec_private_key sk; br_ec_public_key pk;
    sk.curve = sbc_curve_br(curve); sk.x = (sbc_u8*)b; sk.xlen = bl;
    pk.curve = sk.curve; pk.q = (sbc_u8*)a; pk.qlen = al;
    size_t need = br_encode_ec_pkcs8_der(0, &sk, &pk);
    sbc_u8* dst = (sbc_u8*)malloc(need);
    if (!dst) return SBC_OPERATION;
    br_encode_ec_pkcs8_der(dst, &sk, &pk);
    sbc_put(out, dst, need);
    free(dst);
    return SBC_OK;
  }
  if (kind == SBC_K_ED25519 || kind == SBC_K_X25519) {
    const sbc_u8* oid = kind == SBC_K_ED25519 ? sbc_oid_ed25519 : sbc_oid_x25519;
    if (!sbc_next(&p, &left, &a, &al) || al != 32) return SBC_DATA; /* public key */
    sbc_buf alg = {0};
    sbc_der_tlv(&alg, 0x06, oid, 3);
    if (!pkcs8) { sbc_spki_build(out, &alg, a, al); free(alg.p); return SBC_OK; }
    if (!sbc_next(&p, &left, &b, &bl) || bl != 32) { free(alg.p); return SBC_DATA; } /* seed */
    sbc_buf inner = {0}, wrap = {0}, body = {0};
    sbc_der_tlv(&inner, 0x04, b, 32);
    sbc_der_tlv(&wrap, 0x04, inner.p, inner.n);
    sbc_put1(&body, 0x02); sbc_put1(&body, 1); sbc_put1(&body, 0);
    sbc_der_tlv(&body, 0x30, alg.p, alg.n);
    sbc_put(&body, wrap.p, wrap.n);
    sbc_der_tlv(out, 0x30, body.p, body.n);
    free(alg.p); free(inner.p); free(wrap.p); free(body.p);
    return SBC_OK;
  }
  return SBC_NOTSUP;
}

/* ---- HMAC, PBKDF2, HKDF -------------------------------------------------------------------- */

static void sbc_hmac(int bits, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_u8* out) {
  br_hmac_key_context kc; br_hmac_context hc;
  br_hmac_key_init(&kc, sbc_hash(bits), key, kl);
  br_hmac_init(&hc, &kc, 0);
  br_hmac_update(&hc, m, ml);
  br_hmac_out(&hc, out);
}

/* RFC 8018 PBKDF2 over HMAC(bits). */
static int sbc_pbkdf2(int bits, const sbc_u8* pw, size_t pl, const sbc_u8* salt, size_t sl, uint32_t iters, sbc_u8* out, size_t len) {
  size_t hl = sbc_hlen(bits);
  br_hmac_key_context kc;
  br_hmac_key_init(&kc, sbc_hash(bits), pw, pl);
  sbc_u8 u[64], t[64];
  for (uint32_t blk = 1; len > 0; blk++) {
    br_hmac_context hc;
    sbc_u8 be[4] = { (sbc_u8)(blk >> 24), (sbc_u8)(blk >> 16), (sbc_u8)(blk >> 8), (sbc_u8)blk };
    br_hmac_init(&hc, &kc, 0); br_hmac_update(&hc, salt, sl); br_hmac_update(&hc, be, 4); br_hmac_out(&hc, u);
    memcpy(t, u, hl);
    for (uint32_t i = 1; i < iters; i++) {
      br_hmac_init(&hc, &kc, 0); br_hmac_update(&hc, u, hl); br_hmac_out(&hc, u);
      for (size_t j = 0; j < hl; j++) t[j] ^= u[j];
    }
    size_t n = len < hl ? len : hl;
    memcpy(out, t, n); out += n; len -= n;
  }
  return 1;
}

static int sbc_hkdf(int bits, const sbc_u8* ikm, size_t il, const sbc_u8* salt, size_t sl, const sbc_u8* info, size_t nl, sbc_u8* out, size_t len) {
  br_hkdf_context hc;
  br_hkdf_init(&hc, sbc_hash(bits), salt, sl);
  br_hkdf_inject(&hc, ikm, il);
  br_hkdf_flip(&hc);
  br_hkdf_produce(&hc, info, nl, out, len);
  return 1;
}

/* ---- RSA ----------------------------------------------------------------------------------- */

static int sbc_load_rsa_public(const sbc_u8* der, size_t len, br_rsa_public_key* pk) {
  int kind, curve; const sbc_u8* key; size_t kl;
  if (!sbc_spki_parse(der, len, &kind, &curve, &key, &kl) || kind != SBC_K_RSA) return 0;
  const sbc_u8 *p = key, *c, *n, *e; size_t left = kl, cl, nl, el; sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &n, &nl) || t != 0x02 || !sbc_der_read(&p, &left, &t, &e, &el) || t != 0x02) return 0;
  sbc_strip(&n, &nl); sbc_strip(&e, &el);
  pk->n = (sbc_u8*)n; pk->nlen = nl; pk->e = (sbc_u8*)e; pk->elen = el;
  return 1;
}

static int sbc_rsa_pkcs1_sign(int bits, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_buf* out) {
  sbc_rsa_fields kf; br_rsa_private_key skv; const br_rsa_private_key* sk = &skv;
  if (!sbc_rsa_parse_pkcs8(key, kl, &kf)) return SBC_DATA;
  sbc_rsa_bear_key(&kf, &skv);
  sbc_u8 h[64], x[512];
  size_t xl = (sk->n_bitlen + 7) / 8;
  int rc = SBC_OPERATION;
  if (xl <= sizeof x && sbc_digest(bits, m, ml, h) &&
      br_rsa_pkcs1_sign_get_default()(sbc_hash_oid(bits), h, sbc_hlen(bits), sk, x)) {
    sbc_put(out, x, xl); rc = SBC_OK;
  }
  return rc;
}
static int sbc_rsa_pkcs1_verify(int bits, const sbc_u8* key, size_t kl, const sbc_u8* sig, size_t sl, const sbc_u8* m, size_t ml, int* ok) {
  br_rsa_public_key pk;
  *ok = 0;
  if (!sbc_load_rsa_public(key, kl, &pk)) return SBC_DATA;
  sbc_u8 h[64], x[512], got[64];
  if (sl != pk.nlen || sl > sizeof x) return SBC_OK;
  memcpy(x, sig, sl);
  if (!sbc_digest(bits, m, ml, h)) return SBC_NOTSUP;
  if (br_rsa_pkcs1_vrfy_get_default()(x, sl, sbc_hash_oid(bits), sbc_hlen(bits), &pk, got) && sbc_ct_eq(got, h, sbc_hlen(bits))) *ok = 1;
  return SBC_OK;
}

/* MGF1 (RFC 8017 B.2.1): XOR the mask for seed into out. */
static void sbc_mgf1_xor(int bits, const sbc_u8* seed, size_t sl, sbc_u8* out, size_t len) {
  sbc_u8 h[64];
  size_t hl = sbc_hlen(bits);
  const br_hash_class* hc = sbc_hash(bits);
  for (uint32_t ctr = 0; len > 0; ctr++) {
    br_hash_compat_context ctx;
    sbc_u8 be[4] = { (sbc_u8)(ctr >> 24), (sbc_u8)(ctr >> 16), (sbc_u8)(ctr >> 8), (sbc_u8)ctr };
    hc->init(&ctx.vtable); hc->update(&ctx.vtable, seed, sl); hc->update(&ctx.vtable, be, 4); hc->out(&ctx.vtable, h);
    size_t n = len < hl ? len : hl;
    for (size_t i = 0; i < n; i++) out[i] ^= h[i];
    out += n; len -= n;
  }
}

/* H(0x00*8 || mHash || salt) */
static void sbc_pss_h(int bits, const sbc_u8* mh, const sbc_u8* salt, size_t saltlen, sbc_u8* out) {
  const br_hash_class* hc = sbc_hash(bits);
  br_hash_compat_context ctx;
  sbc_u8 zero[8] = {0};
  hc->init(&ctx.vtable); hc->update(&ctx.vtable, zero, 8); hc->update(&ctx.vtable, mh, sbc_hlen(bits)); hc->update(&ctx.vtable, salt, saltlen); hc->out(&ctx.vtable, out);
}

/* RSASSA-PSS with MGF1 over the same hash (RFC 8017 9.1). */
static int sbc_rsa_pss_sign(int bits, size_t saltlen, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_buf* out) {
  sbc_rsa_fields kf; br_rsa_private_key skv; const br_rsa_private_key* sk = &skv;
  if (!sbc_rsa_parse_pkcs8(key, kl, &kf)) return SBC_DATA;
  sbc_rsa_bear_key(&kf, &skv);
  int rc = SBC_OPERATION;
  size_t k = (sk->n_bitlen + 7) / 8, emBits = sk->n_bitlen - 1, emLen = (emBits + 7) / 8, hl = sbc_hlen(bits);
  sbc_u8 x[512], mh[64], salt[512], hh[64];
  if (k <= sizeof x && saltlen <= sizeof salt && emLen >= hl + saltlen + 2 && sbc_digest(bits, m, ml, mh) &&
      (saltlen == 0 || sbc_rand(salt, saltlen))) {
    memset(x, 0, sizeof x);
    sbc_u8* em = x + (k - emLen);
    size_t dbl = emLen - hl - 1;
    sbc_pss_h(bits, mh, salt, saltlen, hh);
    em[dbl - saltlen - 1] = 1;
    memcpy(em + dbl - saltlen, salt, saltlen);
    sbc_mgf1_xor(bits, hh, hl, em, dbl);
    em[0] &= (sbc_u8)(0xff >> (8 * emLen - emBits));
    memcpy(em + dbl, hh, hl);
    em[emLen - 1] = 0xbc;
    if (br_rsa_private_get_default()(x, sk)) { sbc_put(out, x, k); rc = SBC_OK; }
  }
  return rc;
}
static int sbc_rsa_pss_verify(int bits, size_t saltlen, const sbc_u8* key, size_t kl, const sbc_u8* sig, size_t sl, const sbc_u8* m, size_t ml, int* ok) {
  br_rsa_public_key pk;
  *ok = 0;
  if (!sbc_load_rsa_public(key, kl, &pk)) return SBC_DATA;
  size_t k = pk.nlen, hl = sbc_hlen(bits);
  sbc_u8 x[512], mh[64], hh[64], db[512];
  if (sl != k || k > sizeof x) return SBC_OK;
  /* Exact modulus bit length. */
  uint32_t nbits = (uint32_t)(k * 8);
  { sbc_u8 top = pk.n[0]; while (top && !(top & 0x80)) { nbits--; top = (sbc_u8)(top << 1); } }
  size_t emBits = nbits - 1, emLen = (emBits + 7) / 8;
  memcpy(x, sig, sl);
  if (!br_rsa_public_get_default()(x, k, &pk)) return SBC_OK;
  if (!sbc_digest(bits, m, ml, mh)) return SBC_NOTSUP;
  if (emLen < hl + saltlen + 2) return SBC_OK;
  const sbc_u8* em = x + (k - emLen);
  if (k > emLen && x[0] != 0) return SBC_OK;
  if (em[emLen - 1] != 0xbc) return SBC_OK;
  size_t dbl = emLen - hl - 1;
  if (dbl > sizeof db) return SBC_OK;
  memcpy(db, em, dbl);
  if (db[0] & (sbc_u8)~(0xff >> (8 * emLen - emBits))) return SBC_OK;
  sbc_mgf1_xor(bits, em + dbl, hl, db, dbl);
  db[0] &= (sbc_u8)(0xff >> (8 * emLen - emBits));
  size_t ps = dbl - saltlen - 1;
  for (size_t i = 0; i < ps; i++) if (db[i] != 0) return SBC_OK;
  if (db[ps] != 1) return SBC_OK;
  sbc_pss_h(bits, mh, db + ps + 1, saltlen, hh);
  if (sbc_ct_eq(hh, em + dbl, hl)) *ok = 1;
  return SBC_OK;
}

static int sbc_rsa_keygen(unsigned modbits, uint32_t pubexp, sbc_buf* out) {
  if (modbits < 512 || modbits > 4096 || (pubexp != 3 && pubexp != 65537)) return SBC_NOTSUP;
  br_rsa_private_key sk; br_rsa_public_key pk;
  sbc_u8 kpriv[BR_RSA_KBUF_PRIV_SIZE(4096)], kpub[BR_RSA_KBUF_PUB_SIZE(4096)];
  br_rsa_keygen kg = br_rsa_keygen_get_default();
  if (!kg(&sbc_prng, &sk, kpriv, &pk, kpub, modbits, pubexp)) return SBC_OPERATION;
  size_t dl = br_rsa_compute_privexp_get_default()(0, &sk, pubexp);
  sbc_u8* d = (sbc_u8*)malloc(dl ? dl : 1);
  if (!d) return SBC_OPERATION;
  br_rsa_compute_privexp_get_default()(d, &sk, pubexp);
  size_t need = br_encode_rsa_pkcs8_der(0, &sk, &pk, d, dl);
  sbc_u8* dst = (sbc_u8*)malloc(need);
  if (dst) { br_encode_rsa_pkcs8_der(dst, &sk, &pk, d, dl); sbc_put(out, dst, need); }
  free(dst); free(d);
  memset(kpriv, 0, sizeof kpriv);
  return dst ? SBC_OK : SBC_OPERATION;
}

/* ---- ECDSA --------------------------------------------------------------------------------- */

static int sbc_ec_load_private(const sbc_u8* der, size_t len, br_skey_decoder_context** dcp, const br_ec_private_key** sk) {
  br_skey_decoder_context* dc = (br_skey_decoder_context*)malloc(sizeof *dc);
  if (!dc) return SBC_OPERATION;
  br_skey_decoder_init(dc);
  br_skey_decoder_push(dc, der, len);
  *sk = br_skey_decoder_get_ec(dc);
  if (!*sk || !sbc_curve_from_br((*sk)->curve)) { free(dc); return SBC_DATA; }
  *dcp = dc;
  return SBC_OK;
}
static int sbc_ecdsa_sign(int bits, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_buf* out) {
  br_skey_decoder_context* dc; const br_ec_private_key* sk;
  int rc = sbc_ec_load_private(key, kl, &dc, &sk);
  if (rc != SBC_OK) return rc;
  sbc_u8 h[64], sig[132];
  rc = SBC_OPERATION;
  if (sbc_digest(bits, m, ml, h)) {
    size_t n = br_ecdsa_sign_raw_get_default()(br_ec_get_default(), sbc_hash(bits), h, sk, sig);
    if (n) { sbc_put(out, sig, n); rc = SBC_OK; }
  }
  free(dc);
  return rc;
}
static int sbc_ecdsa_verify(int bits, int curve, const sbc_u8* point, size_t pl, const sbc_u8* sig, size_t sl, const sbc_u8* m, size_t ml, int* ok) {
  *ok = 0;
  size_t fs = sbc_curve_size(curve);
  if (!fs || pl != 1 + 2 * fs || point[0] != 4) return SBC_DATA;
  sbc_u8 h[64];
  if (!sbc_digest(bits, m, ml, h)) return SBC_NOTSUP;
  if (sl != 2 * fs) return SBC_OK;
  br_ec_public_key pk;
  pk.curve = sbc_curve_br(curve); pk.q = (sbc_u8*)point; pk.qlen = pl;
  if (br_ecdsa_vrfy_raw_get_default()(br_ec_get_default(), h, sbc_hlen(bits), &pk, sig, sl)) *ok = 1;
  return SBC_OK;
}
/* A public point is valid when it is on the curve (the group is prime order, cofactor 1). */
static int sbc_ec_point_ok(int curve, const sbc_u8* point, size_t pl) {
  size_t fs = sbc_curve_size(curve);
  if (!fs || pl != 1 + 2 * fs || point[0] != 4) return 0;
  sbc_u8 q[133];
  memcpy(q, point, pl);
  sbc_u8 one[1] = { 1 };
  return br_ec_get_default()->mul(q, pl, one, 1, sbc_curve_br(curve)) != 0;
}
static int sbc_ec_keygen(int curve, sbc_buf* out) {
  br_ec_private_key sk; br_ec_public_key pk;
  sbc_u8 kb[BR_EC_KBUF_PRIV_MAX_SIZE], pb[BR_EC_KBUF_PUB_MAX_SIZE];
  const br_ec_impl* impl = br_ec_get_default();
  if (!br_ec_keygen(&sbc_prng, impl, &sk, kb, sbc_curve_br(curve))) return SBC_OPERATION;
  if (!br_ec_compute_pub(impl, &pk, pb, &sk)) return SBC_OPERATION;
  size_t need = br_encode_ec_pkcs8_der(0, &sk, &pk);
  sbc_u8* dst = (sbc_u8*)malloc(need);
  if (!dst) return SBC_OPERATION;
  br_encode_ec_pkcs8_der(dst, &sk, &pk);
  sbc_put(out, dst, need);
  free(dst);
  memset(kb, 0, sizeof kb);
  return SBC_OK;
}

/* ---- AES: GCM, CBC, CTR, KW ---------------------------------------------------------------- */

static int sbc_aes_key_ok(size_t kl) { return kl == 16 || kl == 24 || kl == 32; }

/* One block through AES, encrypt or decrypt (a one-block CBC with a zero IV is ECB). */
static void sbc_aes_block(int enc, const sbc_u8* key, size_t kl, const sbc_u8* in, sbc_u8* out) {
  sbc_u8 iv[16] = {0};
  memcpy(out, in, 16);
  if (enc) { br_aes_ct_cbcenc_keys c; br_aes_ct_cbcenc_init(&c, key, kl); br_aes_ct_cbcenc_run(&c, iv, out, 16); }
  else { br_aes_ct_cbcdec_keys c; br_aes_ct_cbcdec_init(&c, key, kl); br_aes_ct_cbcdec_run(&c, iv, out, 16); }
}

/* AES-GCM with a tag of tagbits (a multiple of 8, 32 to 128). Encryption appends the tag;
 * decryption expects it at the end of the input and fails, with nothing output, on a bad tag. */
static int sbc_gcm(int enc, size_t tagbits, const sbc_u8* key, size_t kl, const sbc_u8* iv, size_t ivl,
                   const sbc_u8* in, size_t il, const sbc_u8* aad, size_t al, sbc_buf* out) {
  size_t tl = tagbits / 8;
  if (!sbc_aes_key_ok(kl) || ivl == 0 || tagbits < 32 || tagbits > 128 || tagbits % 8) return SBC_OPERATION;
  size_t dl = il;
  if (!enc) { if (il < tl) return SBC_OPERATION; dl = il - tl; }
  sbc_u8* buf = (sbc_u8*)malloc(dl ? dl : 1);
  if (!buf) return SBC_OPERATION;
  memcpy(buf, in, dl);
  br_aes_ct_ctr_keys bc; br_gcm_context gc;
  br_aes_ct_ctr_init(&bc, key, kl);
  br_gcm_init(&gc, &bc.vtable, br_ghash_ctmul);
  br_gcm_reset(&gc, iv, ivl);
  br_gcm_aad_inject(&gc, aad, al);
  br_gcm_flip(&gc);
  br_gcm_run(&gc, enc, buf, dl);
  int rc = SBC_OK;
  if (enc) {
    sbc_u8 tag[16];
    br_gcm_get_tag(&gc, tag);
    sbc_put(out, buf, dl); sbc_put(out, tag, tl);
  } else if (br_gcm_check_tag_trunc(&gc, in + dl, tl)) {
    sbc_put(out, buf, dl);
  } else rc = SBC_OPERATION;
  memset(buf, 0, dl);
  free(buf);
  return rc;
}

/* AES-CBC with PKCS#7 padding. */
static int sbc_cbc(int enc, const sbc_u8* key, size_t kl, const sbc_u8* iv, size_t ivl, const sbc_u8* in, size_t il, sbc_buf* out) {
  if (!sbc_aes_key_ok(kl) || ivl != 16) return SBC_OPERATION;
  sbc_u8 v[16];
  memcpy(v, iv, 16);
  if (enc) {
    size_t pad = 16 - il % 16, total = il + pad;
    sbc_u8* buf = (sbc_u8*)malloc(total);
    if (!buf) return SBC_OPERATION;
    memcpy(buf, in, il); memset(buf + il, (int)pad, pad);
    br_aes_ct_cbcenc_keys c;
    br_aes_ct_cbcenc_init(&c, key, kl); br_aes_ct_cbcenc_run(&c, v, buf, total);
    sbc_put(out, buf, total); free(buf);
    return SBC_OK;
  }
  if (il == 0 || il % 16) return SBC_OPERATION;
  sbc_u8* buf = (sbc_u8*)malloc(il);
  if (!buf) return SBC_OPERATION;
  memcpy(buf, in, il);
  br_aes_ct_cbcdec_keys c;
  br_aes_ct_cbcdec_init(&c, key, kl); br_aes_ct_cbcdec_run(&c, v, buf, il);
  /* Padding check without branching on the pad byte value beyond its validity. */
  sbc_u8 pad = buf[il - 1];
  unsigned bad = (pad == 0) | (pad > 16);
  for (size_t i = 0; i < 16 && i < il; i++) bad |= (i < pad) & (buf[il - 1 - i] != pad);
  int rc = SBC_OPERATION;
  if (!bad) { sbc_put(out, buf, il - pad); rc = SBC_OK; }
  memset(buf, 0, il);
  free(buf);
  return rc;
}

/* Increment the low "bits" bits of a 16-byte big-endian counter, wrapping inside them. */
static void sbc_ctr_inc(sbc_u8* ctr, unsigned bits) {
  unsigned carry = 1, left = bits;
  for (int i = 15; i >= 0 && left > 0; i--) {
    unsigned take = left >= 8 ? 8 : left;
    unsigned m = (1u << take) - 1;
    unsigned v = (ctr[i] & m) + carry;
    carry = v > m;
    ctr[i] = (sbc_u8)((ctr[i] & ~m) | (v & m));
    left -= take;
  }
}
/* AES-CTR as WebCrypto has it: the low "bits" bits of the counter block count, and the input
 * may not be longer than that counter can number. */
static int sbc_ctr(const sbc_u8* key, size_t kl, const sbc_u8* ctr, size_t cl, unsigned bits, const sbc_u8* in, size_t il, sbc_buf* out) {
  if (!sbc_aes_key_ok(kl) || cl != 16 || bits < 1 || bits > 128) return SBC_OPERATION;
  size_t blocks = (il + 15) / 16;
  if (bits < 64 && blocks > ((size_t)1 << bits)) return SBC_OPERATION;
  sbc_u8 c[16], ks[16];
  memcpy(c, ctr, 16);
  br_aes_ct_cbcenc_keys ek;
  br_aes_ct_cbcenc_init(&ek, key, kl);
  for (size_t off = 0; off < il; off += 16) {
    sbc_u8 iv[16] = {0};
    memcpy(ks, c, 16);
    br_aes_ct_cbcenc_run(&ek, iv, ks, 16);
    size_t n = il - off < 16 ? il - off : 16;
    for (size_t j = 0; j < n; j++) sbc_put1(out, (sbc_u8)(in[off + j] ^ ks[j]));
    sbc_ctr_inc(c, bits);
  }
  return SBC_OK;
}

/* AES Key Wrap, RFC 3394. */
static int sbc_kw(int wrap, const sbc_u8* key, size_t kl, const sbc_u8* in, size_t il, sbc_buf* out) {
  if (!sbc_aes_key_ok(kl)) return SBC_OPERATION;
  size_t n;
  sbc_u8 a[8], b[16];
  if (wrap) {
    if (il < 16 || il % 8) return SBC_OPERATION;
    n = il / 8;
    sbc_u8* r = (sbc_u8*)malloc(il);
    if (!r) return SBC_OPERATION;
    memcpy(r, in, il);
    memset(a, 0xa6, 8);
    for (unsigned j = 0; j < 6; j++)
      for (size_t i = 0; i < n; i++) {
        memcpy(b, a, 8); memcpy(b + 8, r + 8 * i, 8);
        sbc_aes_block(1, key, kl, b, b);
        uint64_t t = (uint64_t)n * j + i + 1;
        memcpy(a, b, 8);
        for (int k = 0; k < 8; k++) a[7 - k] ^= (sbc_u8)(t >> (8 * k));
        memcpy(r + 8 * i, b + 8, 8);
      }
    sbc_put(out, a, 8); sbc_put(out, r, il);
    free(r);
    return SBC_OK;
  }
  if (il < 24 || il % 8) return SBC_OPERATION;
  n = il / 8 - 1;
  sbc_u8* r = (sbc_u8*)malloc(il);
  if (!r) return SBC_OPERATION;
  memcpy(a, in, 8); memcpy(r, in + 8, il - 8);
  for (int j = 5; j >= 0; j--)
    for (size_t i = n; i >= 1; i--) {
      uint64_t t = (uint64_t)n * (unsigned)j + i;
      memcpy(b, a, 8);
      for (int k = 0; k < 8; k++) b[7 - k] ^= (sbc_u8)(t >> (8 * k));
      memcpy(b + 8, r + 8 * (i - 1), 8);
      sbc_aes_block(0, key, kl, b, b);
      memcpy(a, b, 8); memcpy(r + 8 * (i - 1), b + 8, 8);
    }
  sbc_u8 iv[8]; memset(iv, 0xa6, 8);
  int rc = SBC_OPERATION;
  if (sbc_ct_eq(a, iv, 8)) { sbc_put(out, r, il - 8); rc = SBC_OK; }
  free(r);
  return rc;
}

/* ---- key agreement ------------------------------------------------------------------------- */

static int sbc_ecdh(int curve, const sbc_u8* pkcs8, size_t kl, const sbc_u8* peer, size_t pl, sbc_buf* out) {
  br_skey_decoder_context* dc; const br_ec_private_key* sk;
  int rc = sbc_ec_load_private(pkcs8, kl, &dc, &sk);
  if (rc != SBC_OK) return rc;
  size_t fs = sbc_curve_size(curve);
  rc = SBC_OPERATION;
  if (sk->curve == sbc_curve_br(curve) && fs && pl == 1 + 2 * fs && peer[0] == 4) {
    sbc_u8 pt[133];
    memcpy(pt, peer, pl);
    if (br_ec_get_default()->mul(pt, pl, sk->x, sk->xlen, sk->curve)) {
      size_t xl; size_t xo = br_ec_get_default()->xoff(sk->curve, &xl);
      sbc_put(out, pt + xo, xl); rc = SBC_OK;
    }
  }
  free(dc);
  return rc;
}
static int sbc_x25519(const sbc_u8* seed, size_t sl, const sbc_u8* peer, size_t pl, sbc_buf* out) {
  if (sl != 32 || pl != 32) return SBC_OPERATION;
  sbc_u8 shared[32], zero[32] = {0};
  crypto_x25519(shared, seed, peer);
  /* A low-order peer point gives all zeros: WebCrypto calls that an OperationError. */
  if (sbc_ct_eq(shared, zero, 32)) return SBC_OPERATION;
  sbc_put(out, shared, 32);
  return SBC_OK;
}

/* ---- RSA-OAEP ------------------------------------------------------------------------------ */

static int sbc_oaep(int enc, int bits, const sbc_u8* key, size_t kl, const sbc_u8* label, size_t ll, const sbc_u8* in, size_t il, sbc_buf* out) {
  const br_hash_class* hc = sbc_hash(bits);
  if (!hc) return SBC_NOTSUP;
  if (enc) {
    br_rsa_public_key pk;
    if (!sbc_load_rsa_public(key, kl, &pk)) return SBC_DATA;
    sbc_u8 buf[512];
    if (pk.nlen > sizeof buf) return SBC_OPERATION;
    size_t n = br_rsa_oaep_encrypt_get_default()(&sbc_prng, hc, label, ll, &pk, buf, sizeof buf, in, il);
    if (!n) return SBC_OPERATION;
    sbc_put(out, buf, n);
    return SBC_OK;
  }
  sbc_rsa_fields kf; br_rsa_private_key sk;
  if (!sbc_rsa_parse_pkcs8(key, kl, &kf)) return SBC_DATA;
  sbc_rsa_bear_key(&kf, &sk);
  sbc_u8 buf[512];
  size_t k = (sk.n_bitlen + 7) / 8;
  if (il != k || k > sizeof buf) return SBC_OPERATION;
  memcpy(buf, in, il);
  size_t len = il;
  if (!br_rsa_oaep_decrypt_get_default()(hc, label, ll, &sk, buf, &len)) return SBC_OPERATION;
  sbc_put(out, buf, len);
  memset(buf, 0, sizeof buf);
  return SBC_OK;
}

/* ---- the dispatcher ------------------------------------------------------------------------ */

#define SBC_OP_RSA_PKCS1_SIGN 1
#define SBC_OP_RSA_PKCS1_VERIFY 2
#define SBC_OP_RSA_PSS_SIGN 3
#define SBC_OP_RSA_PSS_VERIFY 4
#define SBC_OP_ECDSA_SIGN 5
#define SBC_OP_ECDSA_VERIFY 6
#define SBC_OP_ED_SIGN 7
#define SBC_OP_ED_VERIFY 8
#define SBC_OP_PBKDF2 9
#define SBC_OP_HKDF 10
#define SBC_OP_AES_GCM_ENC 11
#define SBC_OP_AES_GCM_DEC 12
#define SBC_OP_AES_CBC_ENC 13
#define SBC_OP_AES_CBC_DEC 14
#define SBC_OP_AES_CTR 15
#define SBC_OP_AES_KW_WRAP 16
#define SBC_OP_AES_KW_UNWRAP 17
#define SBC_OP_ECDH 18
#define SBC_OP_X25519 19
#define SBC_OP_DECODE_SPKI 20
#define SBC_OP_DECODE_PKCS8 21
#define SBC_OP_ENCODE_SPKI 22
#define SBC_OP_ENCODE_PKCS8 23
#define SBC_OP_OAEP_ENC 24
#define SBC_OP_OAEP_DEC 25
#define SBC_OP_RSA_KEYGEN 26
#define SBC_OP_EC_KEYGEN 27
#define SBC_OP_ED_KEYGEN 28
#define SBC_OP_ED_PUB 29
#define SBC_OP_EC_POINT_OK 30
#define SBC_OP_X25519_PUB 31

/* a: parameters ("n,n,..."), b, c, d: byte strings. On success *out is malloc'd (may be NULL for
 * an empty result). Returns SBC_OK or an error code. */
static int sbc_op(int op, const sbc_u8* a, size_t al, const sbc_u8* b, size_t bl, const sbc_u8* c, size_t cl,
                  const sbc_u8* d, size_t dl, sbc_u8** result, size_t* resultlen) {
  sbc_buf out = {0};
  int rc = SBC_NOTSUP, ok = 0;
  long p0 = sbc_param(a, al, 0), p1 = sbc_param(a, al, 1), p2 = sbc_param(a, al, 2);
  switch (op) {
    case SBC_OP_RSA_PKCS1_SIGN: rc = sbc_hash((int)p0) ? sbc_rsa_pkcs1_sign((int)p0, b, bl, c, cl, &out) : SBC_NOTSUP; break;
    case SBC_OP_RSA_PKCS1_VERIFY:
      rc = sbc_hash((int)p0) ? sbc_rsa_pkcs1_verify((int)p0, b, bl, c, cl, d, dl, &ok) : SBC_NOTSUP;
      if (rc == SBC_OK) sbc_put1(&out, (sbc_u8)ok);
      break;
    case SBC_OP_RSA_PSS_SIGN: rc = sbc_hash((int)p0) && p1 >= 0 ? sbc_rsa_pss_sign((int)p0, (size_t)p1, b, bl, c, cl, &out) : SBC_NOTSUP; break;
    case SBC_OP_RSA_PSS_VERIFY:
      rc = sbc_hash((int)p0) && p1 >= 0 ? sbc_rsa_pss_verify((int)p0, (size_t)p1, b, bl, c, cl, d, dl, &ok) : SBC_NOTSUP;
      if (rc == SBC_OK) sbc_put1(&out, (sbc_u8)ok);
      break;
    case SBC_OP_ECDSA_SIGN: rc = sbc_hash((int)p0) ? sbc_ecdsa_sign((int)p0, b, bl, c, cl, &out) : SBC_NOTSUP; break;
    case SBC_OP_ECDSA_VERIFY:
      rc = sbc_hash((int)p0) ? sbc_ecdsa_verify((int)p0, (int)p1, b, bl, c, cl, d, dl, &ok) : SBC_NOTSUP;
      if (rc == SBC_OK) sbc_put1(&out, (sbc_u8)ok);
      break;
    case SBC_OP_ED_SIGN: {
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_u8 sk[64], pk[32], seed[32], sig[64];
      memcpy(seed, b, 32);
      crypto_ed25519_key_pair(sk, pk, seed);
      crypto_ed25519_sign(sig, sk, c, cl);
      sbc_put(&out, sig, 64); rc = SBC_OK;
      break;
    }
    case SBC_OP_ED_VERIFY:
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_put1(&out, (sbc_u8)(cl == 64 && crypto_ed25519_check(c, b, d, dl) == 0));
      rc = SBC_OK;
      break;
    case SBC_OP_PBKDF2:
      if (!sbc_hash((int)p0) || p1 < 1 || p2 < 0 || p2 > 1048576) break;
      { sbc_u8* o = (sbc_u8*)malloc(p2 ? (size_t)p2 : 1);
        if (!o) { rc = SBC_OPERATION; break; }
        sbc_pbkdf2((int)p0, b, bl, c, cl, (uint32_t)p1, o, (size_t)p2);
        sbc_put(&out, o, (size_t)p2); free(o); rc = SBC_OK; }
      break;
    case SBC_OP_HKDF:
      if (!sbc_hash((int)p0) || p1 < 0 || p1 > 255 * (long)sbc_hlen((int)p0)) break;
      { sbc_u8* o = (sbc_u8*)malloc(p1 ? (size_t)p1 : 1);
        if (!o) { rc = SBC_OPERATION; break; }
        sbc_hkdf((int)p0, b, bl, c, cl, d, dl, o, (size_t)p1);
        sbc_put(&out, o, (size_t)p1); free(o); rc = SBC_OK; }
      break;
    case SBC_OP_AES_GCM_ENC:
    case SBC_OP_AES_GCM_DEC: {
      /* d is framed: data, additional data. */
      const sbc_u8 *dp = d, *data, *aad; size_t dleft = dl, datal, aadl;
      if (p0 < 0 || !sbc_next(&dp, &dleft, &data, &datal) || !sbc_next(&dp, &dleft, &aad, &aadl)) break;
      rc = sbc_gcm(op == SBC_OP_AES_GCM_ENC, (size_t)p0, b, bl, c, cl, data, datal, aad, aadl, &out);
      break;
    }
    case SBC_OP_AES_CBC_ENC: rc = sbc_cbc(1, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_AES_CBC_DEC: rc = sbc_cbc(0, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_AES_CTR: rc = p0 > 0 ? sbc_ctr(b, bl, c, cl, (unsigned)p0, d, dl, &out) : SBC_NOTSUP; break;
    case SBC_OP_AES_KW_WRAP: rc = sbc_kw(1, b, bl, d, dl, &out); break;
    case SBC_OP_AES_KW_UNWRAP: rc = sbc_kw(0, b, bl, d, dl, &out); break;
    case SBC_OP_ECDH: rc = sbc_ecdh((int)p0, b, bl, c, cl, &out); break;
    case SBC_OP_X25519: rc = sbc_x25519(b, bl, c, cl, &out); break;
    case SBC_OP_X25519_PUB: {
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_u8 pk[32];
      crypto_x25519_public_key(pk, b);
      sbc_put(&out, pk, 32); rc = SBC_OK;
      break;
    }
    case SBC_OP_OAEP_ENC: rc = sbc_oaep(1, (int)p0, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_OAEP_DEC: rc = sbc_oaep(0, (int)p0, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_DECODE_SPKI: rc = sbc_decode(0, b, bl, &out); break;
    case SBC_OP_DECODE_PKCS8: rc = sbc_decode(1, b, bl, &out); break;
    case SBC_OP_ENCODE_SPKI: rc = sbc_encode(0, (int)p0, (int)p1, b, bl, &out); break;
    case SBC_OP_ENCODE_PKCS8: rc = sbc_encode(1, (int)p0, (int)p1, b, bl, &out); break;
    case SBC_OP_RSA_KEYGEN: rc = p0 > 0 && p1 > 0 ? sbc_rsa_keygen((unsigned)p0, (uint32_t)p1, &out) : SBC_NOTSUP; break;
    case SBC_OP_EC_KEYGEN: rc = sbc_curve_br((int)p0) ? sbc_ec_keygen((int)p0, &out) : SBC_NOTSUP; break;
    case SBC_OP_ED_KEYGEN: {
      sbc_u8 seed[32];
      if (!sbc_rand(seed, 32)) { rc = SBC_OPERATION; break; }
      sbc_put(&out, seed, 32); memset(seed, 0, 32); rc = SBC_OK;
      break;
    }
    case SBC_OP_ED_PUB: {
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_u8 sk[64], pk[32], seed[32];
      memcpy(seed, b, 32);
      crypto_ed25519_key_pair(sk, pk, seed);
      sbc_put(&out, pk, 32); rc = SBC_OK;
      break;
    }
    case SBC_OP_EC_POINT_OK:
      sbc_put1(&out, (sbc_u8)sbc_ec_point_ok((int)p0, b, bl)); rc = SBC_OK;
      break;
  }
  if (out.bad) rc = SBC_OPERATION;
  if (rc != SBC_OK) { free(out.p); out.p = 0; out.n = 0; }
  *result = out.p; *resultlen = out.n;
  return rc;
}
