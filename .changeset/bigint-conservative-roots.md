---
"@sproutboat/toolchain": patch
---

Keep heap-backed BigInts alive during conservative garbage collection. The native scanner now recognizes the encoded floating-point pointer used by BigInt arithmetic, preventing crashes and incorrect checksums in workloads such as CRC64 and LTX encoding.
