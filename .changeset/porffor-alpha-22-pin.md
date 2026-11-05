---
"@sproutboat/toolchain": patch
---

toolchain a21: the Porffor alpha 22 pin (`PORFFOR_A21_PINS["alpha-22"]`, commit a081ebd7, codeload tarball sha256 b32ed03a…) runs through the same chain; the pin a tree is on is read from the tree (`channelOfTree`), so alpha 21 stays reproducible from its archive. Every alpha 21 pass anchors unchanged on alpha 22; one pass is new and alpha 22 only, P8: the shared dispatch functions alpha 22's codegen generates for calls and indexed reads on untyped receivers (135fda29) belong to the unit that asked for them and are named by method and arity, instead of landing in `main` as `#anonymous_1`, `_1_`, … in creation order, which put every app's first use of a method into the shared prefix. Nothing changes for the alpha 19 channel or for alpha 21 trees.
