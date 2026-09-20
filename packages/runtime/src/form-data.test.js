// #60 — the FormData parsing helpers live inline in native-fetch-prelude.js
// (the prelude is prepended as text and cannot import), so this test lifts
// that block out and exercises it directly. Bun already provides real
// FormData/Blob/URLSearchParams globals, so the lifted parser functions run
// against those rather than the prelude's own guarded shims (which no-op
// here since Bun already has the globals they'd otherwise install) — the
// parsing logic itself is what's under test, and it's spec surface either way.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
const start = src.indexOf("function __sbParseUrlencodedFormData(");
const end = src.indexOf('if (!("formData" in Request.prototype))');
if (start === -1 || end === -1 || end < start) throw new Error("FormData parsing block not found in prelude");

// oxlint-disable-next-line no-function-constructor -- lifting a pure block out of the text-only prelude for test
const load = new Function(
  `${src.slice(start, end)}\n   return { __sbParseUrlencodedFormData, __sbParseMultipartFormData, __sbFormDataFromBody };`,
);
const { __sbParseUrlencodedFormData, __sbParseMultipartFormData, __sbFormDataFromBody } = load();

const headers = (contentType) => ({ get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) });

test("urlencoded: decodes fields, including repeated keys and +/percent escapes", () => {
  const fd = __sbParseUrlencodedFormData("name=Ren%C3%A9&tag=a&tag=b&note=hi+there");
  expect(fd.get("name")).toBe("René");
  expect(fd.getAll("tag")).toEqual(["a", "b"]);
  expect(fd.get("note")).toBe("hi there");
});

test("urlencoded: empty body yields an empty FormData", () => {
  const fd = __sbParseUrlencodedFormData("");
  expect(fd.get("anything")).toBeNull();
});

test("multipart: parses a text field and a file field from a real boundary", () => {
  const boundary = "----sbTestBoundary123";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="title"\r\n\r\n` +
    `hello world\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="upload"; filename="a.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `file contents\r\n` +
    `--${boundary}--\r\n`;
  const fd = __sbParseMultipartFormData(body, boundary);
  expect(fd.get("title")).toBe("hello world");
  const file = fd.get("upload");
  expect(file instanceof Blob).toBe(true);
});

test("multipart: a part with no name= is skipped rather than throwing", () => {
  const boundary = "B";
  const body = `--B\r\nContent-Disposition: form-data\r\n\r\nignored\r\n--B\r\nContent-Disposition: form-data; name="k"\r\n\r\nv\r\n--B--\r\n`;
  const fd = __sbParseMultipartFormData(body, boundary);
  expect(fd.get("k")).toBe("v");
  expect(fd.has("")).toBe(false);
});

test("__sbFormDataFromBody: dispatches on content-type, quoted or bare boundary", () => {
  const urlencoded = __sbFormDataFromBody(headers("application/x-www-form-urlencoded"), "a=1");
  expect(urlencoded.get("a")).toBe("1");

  const bareBoundary = __sbFormDataFromBody(
    headers("multipart/form-data; boundary=XYZ"),
    `--XYZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XYZ--\r\n`,
  );
  expect(bareBoundary.get("a")).toBe("1");

  const quotedBoundary = __sbFormDataFromBody(
    headers('multipart/form-data; boundary="XYZ"'),
    `--XYZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XYZ--\r\n`,
  );
  expect(quotedBoundary.get("a")).toBe("1");
});

test("__sbFormDataFromBody: multipart with no boundary throws instead of silently misparsing", () => {
  expect(() => __sbFormDataFromBody(headers("multipart/form-data"), "")).toThrow(/boundary/);
});
