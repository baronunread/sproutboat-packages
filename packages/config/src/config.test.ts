import { expect, test } from "bun:test";
import { parseConfig, pinBindingId } from "./config";

const base = `{ "name": "app", "main": "src/index.js", "compatibility_date": "2026-08-26"`;

test("accepts kv_namespaces / secrets / outbound / d1_databases / r2_buckets and passes them through", () => {
  const r = parseConfig(
    `${base}, "kv_namespaces": ["CACHE"], "secrets": ["API_KEY"], "outbound": ["api.example.com"], "d1_databases": ["DB"], "r2_buckets": ["ASSETS"] }`,
  );
  expect(r.ok && r.value).toMatchObject({
    kv_namespaces: ["CACHE"],
    secrets: ["API_KEY"],
    outbound: ["api.example.com"],
    d1_databases: ["DB"],
    r2_buckets: ["ASSETS"],
  });
});

test("binding names must be UPPER_SNAKE_CASE", () => {
  const r = parseConfig(`${base}, "kv_namespaces": ["cache"] }`);
  expect(r.ok).toBe(false);
});

test("outbound entries must look like hostnames", () => {
  expect(parseConfig(`${base}, "outbound": ["https://api.example.com"] }`).ok).toBe(false);
  expect(parseConfig(`${base}, "outbound": ["localhost"] }`).ok).toBe(false);
});

test("a var and a binding may not share a name (any binding kind)", () => {
  expect(parseConfig(`${base}, "vars": { "TOKEN": "x" }, "secrets": ["TOKEN"] }`).ok).toBe(false);
  expect(parseConfig(`${base}, "d1_databases": ["DB"], "r2_buckets": ["DB"] }`).ok).toBe(false);
  const r = parseConfig(`${base}, "kv_namespaces": ["X"], "d1_databases": ["X"] }`);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("must not collide");
});

// #74 — storage bindings accept `{ binding, id }` alongside a bare name.
const id24 = "0123456789abcdef01234567";

test("accepts { binding, id } with a kind-matched id", () => {
  const r = parseConfig(
    `${base}, "kv_namespaces": [{ "binding": "LINKS", "id": "kv_${id24}" }], "d1_databases": ["DB"] }`,
  );
  expect(r.ok && r.value.kv_namespaces).toEqual([{ binding: "LINKS", id: `kv_${id24}` }]);
  expect(r.ok && r.value.d1_databases).toEqual(["DB"]);
});

test("rejects an id whose prefix is the wrong kind", () => {
  const r = parseConfig(`${base}, "kv_namespaces": [{ "binding": "LINKS", "id": "r2_${id24}" }] }`);
  expect(r.ok).toBe(false);
});

test("rejects a malformed id and stray keys in the object", () => {
  expect(parseConfig(`${base}, "queues": [{ "binding": "Q", "id": "queue_short" }] }`).ok).toBe(false);
  expect(parseConfig(`${base}, "queues": [{ "binding": "Q", "id": "queue_${id24}", "extra": 1 }] }`).ok).toBe(false);
});

test("the { binding } name still collides with a var of the same name", () => {
  const r = parseConfig(
    `${base}, "vars": { "LINKS": "x" }, "kv_namespaces": [{ "binding": "LINKS", "id": "kv_${id24}" }] }`,
  );
  expect(r.ok).toBe(false);
});

test("assets: accepts a full block and passes it through", () => {
  const r = parseConfig(
    `${base}, "assets": { "directory": "./public/", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_sprout_first": ["/api/*", "!/api/docs/*"] } }`,
  );
  expect(r.ok && r.value.assets).toEqual({
    directory: "public",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_sprout_first: ["/api/*", "!/api/docs/*"],
  });
});

test("assets: directory required, binding UPPER_SNAKE, enum + pattern checks, no collision", () => {
  expect(parseConfig(`${base}, "assets": { "binding": "ASSETS" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "../etc" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "public", "binding": "assets" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "public", "not_found_handling": "spa" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "public", "run_sprout_first": ["api/*"] } }`).ok).toBe(false);
  const collide = parseConfig(
    `${base}, "kv_namespaces": ["ASSETS"], "assets": { "directory": "public", "binding": "ASSETS" } }`,
  );
  expect(collide.ok).toBe(false);
  if (!collide.ok) expect(collide.errors.join(" ")).toContain("must not collide");
});

test("assets: bare directory (edge-only, no binding) is valid", () => {
  const r = parseConfig(`${base}, "assets": { "directory": "public" } }`);
  expect(r.ok && r.value.assets).toEqual({ directory: "public" });
});

test("omitting the binding fields is still valid", () => {
  const r = parseConfig(`${base} }`);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.kv_namespaces).toBeUndefined();
});

// #74 auto-provision write-back — pinBindingId edits sproutboat.jsonc in place.
test("pinBindingId turns a bare binding into { binding, id } and keeps comments", () => {
  const src = `{
  "name": "app",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26",
  // storage
  "kv_namespaces": ["WAITLIST", "SESSIONS"],
  "d1_databases": ["DB"], // one db
}
`;
  const out = pinBindingId(src, "kv_namespaces", "WAITLIST", "kv_0123456789abcdef01234567");
  expect(out).toContain(`{ "binding": "WAITLIST", "id": "kv_0123456789abcdef01234567" }`);
  expect(out).toContain(`"SESSIONS"`); // sibling untouched
  expect(out).toContain("// storage"); // comment untouched
  expect(out).toContain(`"d1_databases": ["DB"], // one db`); // other field untouched
  // re-parses and normalizes to the pinned ref
  const parsed = parseConfig(out);
  expect(parsed.ok && parsed.value.kv_namespaces).toEqual([
    { binding: "WAITLIST", id: "kv_0123456789abcdef01234567" },
    "SESSIONS",
  ]);
});

test("pinBindingId is a no-op when the binding is already an object or absent", () => {
  const already = `{ "name": "a", "kv_namespaces": [{ "binding": "X", "id": "kv_${"0".repeat(24)}" }] }`;
  expect(pinBindingId(already, "kv_namespaces", "X", "kv_new")).toBe(already);
  const absent = `{ "name": "a", "kv_namespaces": ["Y"] }`;
  expect(pinBindingId(absent, "kv_namespaces", "Z", "kv_z")).toBe(absent);
});

test("services: valid entries parse; bad shapes and collisions are rejected", () => {
  const base = { name: "hello", main: "src/index.js", compatibility_date: "2026-09-06" };
  const ok = parseConfig(JSON.stringify({ ...base, services: [{ binding: "AUTH", service: "auth-api" }] }));
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.value.services).toEqual([{ binding: "AUTH", service: "auth-api" }]);

  const lower = parseConfig(JSON.stringify({ ...base, services: [{ binding: "auth", service: "auth-api" }] }));
  expect(lower.ok).toBe(false);

  const dupe = parseConfig(
    JSON.stringify({
      ...base,
      services: [
        { binding: "A_B", service: "one" },
        { binding: "A_B", service: "two" },
      ],
    }),
  );
  expect(dupe.ok).toBe(false);

  // a service binding occupies a binding slot like any other
  const collide = parseConfig(
    JSON.stringify({ ...base, vars: { AUTH: "x" }, services: [{ binding: "AUTH", service: "auth-api" }] }),
  );
  expect(collide.ok).toBe(false);
});
