const names = process.argv.slice(2);
let tot = 0,
  bad = 0;
for (const n of names) {
  const a = JSON.parse(await Bun.file(`ref/${n}.json`).text()),
    b = JSON.parse(await Bun.file(`out/${n}.json`).text());
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k.startsWith("us_")) continue;
    tot++;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      bad++;
      console.log(n, k, "\n  workerd:", JSON.stringify(a[k]), "\n  ours:   ", JSON.stringify(b[k]));
    }
  }
}
console.log({ observations: tot, differ: bad });
