---
"@sproutboat/toolchain": patch
---

Builds are about 1.3 s faster, and parallel builds no longer fail with `PrecompiledBuiltins.BuiltinFuncs is not a function`. Every compile re-ran the patch chain on the shared compiler cache, and its builtin precompile rewrote `builtins_precompiled.js` in place, so a concurrent build could import a half-written table. A cache entry patched by the same toolchain version is now used as is.
