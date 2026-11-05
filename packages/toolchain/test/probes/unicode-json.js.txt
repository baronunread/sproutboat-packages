const a = "x y"; console.log(a.length, a.charCodeAt(1));
console.log(JSON.stringify("é "));
console.log(JSON.stringify({a:"é😀"}));
console.log(JSON.stringify({a:"é😀 "}));
console.log(JSON.stringify({a:" "}), JSON.stringify(["éĀ"]));
const parsed = JSON.parse('{"k":"é😀 Ā"}'); console.log(parsed.k.length, parsed.k.charCodeAt(0), parsed.k.charCodeAt(4));
