// usage: bun imports.ts <entry> -> lists node builtins the bundle reaches
import { builtinModules } from "node:module";
const entry = process.argv[2];
const seen = new Map<string, string[]>();
const b = new Set(builtinModules.flatMap((m) => [m, "node:" + m]));
const r = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "esm",
  minify: false,
  plugins: [
    {
      name: "rec",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (a) => {
          if (b.has(a.path)) {
            const l = seen.get(a.path) ?? [];
            l.push(a.importer.replace(/.*node_modules\//, ""));
            seen.set(a.path, l);
            return { path: a.path, namespace: "stub" };
          }
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {};", loader: "js" }));
      },
    },
  ],
});
console.log("success", r.success, r.logs.map((l) => l.message).slice(0, 5));
for (const [k, v] of seen) console.log(k.padEnd(14), [...new Set(v)].join(", "));
if (r.success) {
  const t = await r.outputs[0].text();
  await Bun.write(process.argv[3] ?? "/tmp/spike-tcp/out.js", t);
  for (const re of [/\bBuffer\b/g, /\bprocess\.\w+/g, /\brequire\(/g, /\beval\(/g, /new Function/g])
    console.log(re.source, (t.match(re) ?? []).length, [...new Set(t.match(re) ?? [])].slice(0, 8));
}
