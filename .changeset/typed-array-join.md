---
"@sproutboat/toolchain": patch
---

`join()` and `toString()` work on typed arrays (baronunread/sproutboat#242). Porffor generates typed-array methods from the Array ones by replacing `any[]` with the array's type, which also retyped `join`'s internal helper array. `new Uint8Array([1,2]).join("-")` returned garbage, and a three-element `Uint16Array.join` crashed. The generator now keeps that helper a plain array.
