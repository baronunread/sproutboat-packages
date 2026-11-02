const a = JSON.parse(await Bun.file("workerd-result.json").text()),
  b = JSON.parse(await Bun.file(process.argv[2]).text());
const flat = (o: any, p = "", out: Record<string, string> = {}) => {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const k in o) flat(o[k], p + "." + k, out);
  else out[p] = JSON.stringify(o);
  return out;
};
const fa = flat(a),
  fb = flat(b);
let same = 0,
  diff = 0;
for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
  if (fa[k] === fb[k]) same++;
  else {
    diff++;
    console.log(k, "\n  workerd:", fa[k], "\n  ours:   ", fb[k]);
  }
}
console.log({ same, diff });
