---
"@sproutboat/toolchain": minor
---

Porffor alpha 24 (`1b8225e`, npm `0.0.0-alpha.24`) joins the alpha 21 line as a fourth pin, selectable with `SPROUTBOAT_PORFFOR_CHANNEL=alpha-24`; standalone builds still default to alpha 23. Alpha 24 adds TypeScript lowering (namespaces, enums, parameter properties) and decorators. 23 of the 25 patch passes apply unchanged; P5 (stable class computed-key names) and P11 (a reassigned class declaration) were re-anchored for alpha 24's class codegen, and `channelOfTree` tells alpha 24 by `compiler/typescript.js`. No pass is dropped: the repros for #454 to #457, #461 and #463 still fail on stock alpha 24.
