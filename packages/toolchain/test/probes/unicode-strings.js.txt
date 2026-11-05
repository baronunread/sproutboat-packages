console.log("é😀 ÉΩ");
const s = "é😀"; console.log(s.length, s.codePointAt(1), s.charCodeAt(1), encodeURIComponent(s));
console.log(JSON.stringify("é😀"), JSON.stringify("é"), JSON.stringify("😀"));
console.log(new TextEncoder().encode("é😀").length, Buffer.from("é😀").length);
console.log("ÉΩ".toLowerCase(), "éω".toUpperCase());
