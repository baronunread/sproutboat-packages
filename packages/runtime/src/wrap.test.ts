import { expect, test } from "bun:test";
import { IMPORT_META_URL, inlineImportMeta } from "./wrap";

const META = "const __sbImportMeta = ";

test("a body without import.meta is returned as it was", () => {
  const body = "const a = 1;\nconst b = 'import.meta.env';";
  expect(inlineImportMeta(body)).toBe(body);
});

test("every use of import.meta reads one object with url, main and resolve", () => {
  for (const use of [
    "import.meta.url",
    "import.meta.env",
    "import.meta.env?.MODE",
    "import.meta?.env",
    "{ ...import.meta.env }",
    "{ ...import.meta }",
    "import.meta.resolve('./x')",
    "import.meta['env']",
    "(import.meta)",
  ]) {
    const out = inlineImportMeta(`const v = ${use};`);
    expect(out.startsWith(META)).toBe(true);
    expect(out).toContain(`url: "${IMPORT_META_URL}"`);
    expect(out).not.toMatch(/\bimport\.meta\b/);
    expect(out.endsWith(`const v = ${use.replaceAll("import.meta", "__sbImportMeta")};`)).toBe(true);
  }
});

test("import.meta in a string, a comment or a member name is not touched", () => {
  const body = [
    "const a = 'import.meta.env';",
    'const b = "see import.meta.url";',
    "// import.meta.env here",
    "/* import.meta.env */",
    "const c = x.import.meta;",
    "const d = `import.meta.env`;",
    "const e = `<${'a'}> import.meta`;",
  ].join("\n");
  expect(inlineImportMeta(body)).toBe(body);
});

test("a template interpolation is code, so its import.meta is rewritten", () => {
  const out = inlineImportMeta("const s = `${import.meta.url} import.meta`;");
  expect(out).toContain("const s = `${__sbImportMeta.url} import.meta`;");
});

test("the object is declared once, ahead of the first use", () => {
  const out = inlineImportMeta("a(import.meta.url);\nb(import.meta.env);");
  expect(out.split(META).length).toBe(2);
  expect(out.indexOf(META)).toBe(0);
});

test("repeated calls behave the same (no regex state is kept)", () => {
  for (let i = 0; i < 3; i++) expect(inlineImportMeta("x(import.meta.env)").startsWith(META)).toBe(true);
});
