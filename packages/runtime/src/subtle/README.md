# crypto.subtle, native half

`crypto.subtle` follows workerd's surface from compatibility date `__SB_SUBTLE_DATE` (a
placeholder constant at the top of the new block in `native-fetch-prelude.js`). The JavaScript
side (key objects, algorithm and usage checks, JWK, DOMException names) lives in the prelude;
this directory is the C it calls.

## Where the primitives come from

Nothing here implements a primitive. The rule is that anything with a vetted C implementation
uses it.

| Need | Source | Licence |
| --- | --- | --- |
| SHA-1/256/384/512, HMAC, HKDF | BearSSL (master 7bea48e) | MIT |
| RSA (private and public operations, key generation, PKCS#1 v1.5 padding), RSA-OAEP | BearSSL (master 7bea48e) | MIT |
| ECDSA and ECDH on P-256, P-384, P-521, EC key generation | BearSSL (master 7bea48e) | MIT |
| AES (constant-time), CBC, CTR, GCM | BearSSL (master 7bea48e) | MIT |
| Ed25519, X25519 | Monocypher 4.0.2, vendored in `vendor/` | BSD-2-Clause or CC0-1.0 |

BearSSL is already linked into every embedded sprout (standalone binaries and sproutd) for
TLS, so this adds no dependency there. It has no Ed25519 or X25519 signing, which is why
Monocypher is vendored: one small library, audited (Cure53, 2017), written for constant time,
public domain or BSD. The two `.c` files and two headers are verbatim from the 4.0.2 release
(sha256 of the tarball `38d07179738c0c90677dba3ceb7a7b8496bcfea758ba1a53e803fed30ae0879c`);
`assemble.ts` wraps each in preprocessor aliases so none of its short names (`u8`, `fe`, `FOR`,
`MIN`) leak into the shared translation unit.

What is written here is composition and checking, each of it tested against BoringSSL (Bun's
WebCrypto) in `subtle.test.ts`:

- RSASSA-PSS encoding and verification (EMSA-PSS with MGF1), since BearSSL has the RSA
  primitive but no PSS.
- PBKDF2 (RFC 8018) over BearSSL's HMAC.
- The DER for SPKI and PKCS#8, and the PKCS#8 RSA reader. BearSSL's own PKCS#8 decoder
  recomputes the public exponent and fails for primes that are 1 mod 4, which OpenSSL and
  BoringSSL keys often have, so the structure is read directly and BearSSL gets the CRT parts.
- Argument and point validation (an EC public point is accepted only if it is on the curve).

## Constant time

Secret-dependent work is BearSSL's (RSA private exponentiation, ECDSA signing, AES) and
Monocypher's (Ed25519 signing, X25519), which are written for constant time. Comparisons of
MACs and signatures use a constant-time compare. Verification of public data (RSA, ECDSA,
PSS check) is not secret-dependent. ECDSA signatures are deterministic (RFC 6979, BearSSL's
HMAC-DRBG), which WebCrypto permits.

## Layout

- `subtle.c`: the C; one entry point, `sbc_op`.
- `vendor/`: Monocypher, verbatim, with its licence.
- `assemble.ts`: builds the block that is spliced into `transport-embedded.js` between the
  `SUBTLE:BEGIN` and `SUBTLE:END` markers. Run `bun run gen:subtle` in `packages/runtime` after
  editing `subtle.c`.
- `driver.c`, `subtle.test.ts`: compile the same C with the host `cc` and BearSSL from the CLI
  cache, and compare with Bun's WebCrypto.

## Transports

Only the embedded transport has BearSSL and Monocypher. On the broker transport
`__sbSubtleRaw` returns an empty string and the prelude throws `NotSupportedError` for
anything that needs the native half (HMAC and digest never do).
