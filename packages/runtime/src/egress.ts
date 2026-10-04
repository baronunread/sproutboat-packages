/**
 * baronunread/sproutboat#174 — `fetch()` never reaches a private or reserved
 * address. A sprout is a real OS process, so without this it could reach the
 * operator's loopback services, their private network, or a cloud metadata
 * endpoint, none of which a Worker can touch.
 *
 * Both backends check the address they are about to connect to, never the
 * hostname: the broker (`@sproutboat/wire`) here in TS, the standalone client
 * in C (`transport-embedded.js`). This table is the one source of truth; the C
 * copy is generated from it (`bun run gen:egress`) and a test fails if the two
 * drift, while another runs the C check against this one on the same vectors.
 *
 * The override belongs to the operator, not the handler: `SB_EGRESS_ALLOW` in
 * the broker's or the binary's environment, either `*` or a comma-separated
 * list of exact addresses.
 * ponytail: exact addresses only, add CIDR entries if an operator needs a subnet.
 */

/** Blocked ranges. IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) and
 *  6to4 (`2002::/16`) addresses are checked by the IPv4 address they embed. */
export const BLOCKED_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001:db8::/32",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
] as const;

/** Parse an IPv4 or IPv6 literal to its bytes; `null` when it is neither. */
export function parseAddress(text: string): Uint8Array | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const bytes = v4.slice(1).map(Number);
    return bytes.every((b) => b <= 255) ? Uint8Array.from(bytes) : null;
  }
  if (!text.includes(":")) return null;
  let tail: number[] = [];
  let body = text;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const embedded = parseAddress(dotted[2]);
    if (!embedded) return null;
    body = `${dotted[1]}0:0`;
    tail = [...embedded];
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(missing).fill("0"), ...rest];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i])) return null;
    const n = parseInt(all[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 255;
  }
  if (tail.length) out.set(tail, 12);
  return out;
}

type Range = { cidr: string; bytes: Uint8Array; bits: number };
const RANGES: Range[] = BLOCKED_RANGES.map((cidr) => {
  const [addr, bits] = cidr.split("/");
  return { cidr, bytes: parseAddress(addr)!, bits: Number(bits) };
});

function inRange(bytes: Uint8Array, range: Range): boolean {
  if (bytes.length !== range.bytes.length) return false;
  const whole = range.bits >> 3;
  for (let i = 0; i < whole; i++) if (bytes[i] !== range.bytes[i]) return false;
  const rem = range.bits & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (bytes[whole] & mask) === (range.bytes[whole] & mask);
}

/** The IPv4 address an IPv6 one carries, for the mapped, NAT64 and 6to4 forms. */
function embeddedV4(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length !== 16) return null;
  const prefix = (p: number[]) => p.every((b, i) => bytes[i] === b);
  if (prefix([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) return bytes.slice(12);
  if (prefix([0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return bytes.slice(12);
  if (prefix([0x20, 0x02])) return bytes.slice(2, 6);
  return null;
}

/** The blocked range `address` falls in, or `null` when it may be reached. */
export function blockedRange(address: string): string | null {
  const parsed = parseAddress(address);
  if (!parsed) return "unparseable address";
  const bytes = embeddedV4(parsed) ?? parsed;
  return RANGES.find((range) => inRange(bytes, range))?.cidr ?? null;
}

/** `SB_EGRESS_ALLOW` split into entries. */
export function egressAllowList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Why `fetch()` may not connect to `address`, or `null` when it may. The
 *  message is identical in the C client; keep the two in step. */
export function egressRefusal(
  host: string,
  address: string,
  allow: readonly string[],
): string | null {
  if (allow.includes("*") || allow.includes(address)) return null;
  const range = blockedRange(address);
  if (range === null) return null;
  return `fetch() refused: ${host} resolves to ${address}, a private or reserved address (${range}). An operator can allow it with SB_EGRESS_ALLOW=${address}`;
}

/** The C range table spliced into transport-embedded.js, inside
 *  sb_egress_blocked: Porffor's header split mangles a file-scope array. */
export function egressRangesC(): string {
  const rows = RANGES.map(({ cidr, bytes, bits }) => {
    const padded = [...bytes, ...Array<number>(16 - bytes.length).fill(0)];
    return `    { ${bytes.length}, ${bits}, { ${padded.join(", ")} }, "${cidr}" },`;
  });
  return ["  static const sb_egress_range sb_egress_ranges[] = {", ...rows, "  };"].join("\n");
}

const TABLE_BEGIN = /( *\/\/ EGRESS-TABLE:BEGIN[^\n]*\n)[\s\S]*?( *\/\/ EGRESS-TABLE:END)/;

/** `source` with the generated table between its EGRESS-TABLE markers replaced. */
export function spliceEgressTable(source: string): string {
  if (!TABLE_BEGIN.test(source)) throw new Error("EGRESS-TABLE markers not found");
  return source.replace(
    TABLE_BEGIN,
    (_, begin: string, end: string) => `${begin}${egressRangesC()}\n${end}`,
  );
}
