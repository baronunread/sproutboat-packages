import { expect, test } from "bun:test";
import { GUARDED_GLOBALS_DATE, validateHttpSyncSource } from "./source";

const wrap = (body: string) => `var d={fetch(){${body}return new Response("ok");}};export{d as default};`;

const GUARDED = [
  // a bundled `buffer` polyfill declares its own Buffer
  `function Buffer(a){return a;}Buffer.isBuffer=function(b){return b instanceof Buffer;};`,
  // upstash: a polyfill behind a test for another global
  `if(typeof atob==="undefined"){global.atob=(b)=>Buffer.from(b,"base64").toString("utf8");}`,
  // supabase-js: a Node branch behind a feature test
  `function b64(d){if(typeof Buffer!=="undefined")return Buffer.from(d).toString("base64");return btoa(d);}`,
  `if(typeof Deno!=="undefined"&&typeof Deno.unrefTimer==="function"){Deno.unrefTimer(t);}`,
  // @neondatabase/serverless: the feature test names the member itself
  `var B=typeof globalThis.Buffer=="function"&&typeof globalThis.Buffer.allocUnsafe=="function"?globalThis.Buffer:null;`,
  // an error message that mentions an API
  `throw new Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");`,
  `// process.env is read here in Node\n`,
];

test("before the guarded-globals date every Node global match fails, as it always did", () => {
  for (const body of GUARDED) {
    expect(validateHttpSyncSource(wrap(body), "2026-10-22").ok).toBe(false);
    expect(validateHttpSyncSource(wrap(body)).ok).toBe(false);
  }
});

test("from the guarded-globals date a feature-tested use, a string and a comment pass", () => {
  for (const body of GUARDED) expect(validateHttpSyncSource(wrap(body), GUARDED_GLOBALS_DATE).ok).toBe(true);
});

test("from the guarded-globals date an unguarded use still fails", () => {
  for (const body of [
    `var x=process.env.TOKEN;`,
    `var b=Buffer.from("a");`,
    `var b=new Buffer(4);`,
    `var x=Bun.file("a");`,
    // a feature test far above does not guard this one
    `if(typeof Deno!=="undefined"){}${" ".repeat(700)}var x=process.env.TOKEN;`,
  ]) {
    const result = validateHttpSyncSource(wrap(body), GUARDED_GLOBALS_DATE);
    expect(result.ok).toBe(false);
  }
});
