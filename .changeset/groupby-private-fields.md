---
"@sproutboat/toolchain": patch
---

`Map.groupBy` works (it threw a TypeError), and private class fields (`#x`) no longer show up in `Object.keys`, `Object.entries`, `for...in` or `JSON.stringify`. Porffor stores a private field as an ordinary property named `__#x`; it is now installed non-enumerable, like a method, so `Object.getOwnPropertyNames` still lists the internal name (baronunread/sproutboat#286).
