# Porffor Alpha 17 evaluation

Verified on 2026-10-11. Released 2026-10-10:
https://github.com/CanadaHonk/porffor/releases/tag/alpha-17

Pinned commit: `731f1b2a150d441ed22da3d14f8b1e0daaae8ee4`.
Vendored archive SHA256:
`8eb65a3e77d58a23bfd2a1a60328672ad50e1ced7931f8d0ca3108e29d6cf846`.

## Changes since Alpha 16

- Number conversion moves to C, covering Number, parseInt, parseFloat and
  formatting methods, including nondecimal radix conversion.
- Math.round implements JavaScript tie behavior and preserves negative zero.
- Console prints full number precision and signed zero.
- Class-field initializers ignore captures local to the initializer.
- Test262 history is updated. No new Proxy or Web Streams implementation ships.

The native regression compares dynamic numeric conversion, rounding, signed
zero, formatting and class-field captures against Bun. Existing stream,
base64 and lexical model-resolver regressions also run on the new pin.

## Downstream fixes retained

Web Streams still need the embedded ponyfill and compiler adaptations.
Better Auth's local model resolver needs lexical function registration and
correct return-type inference. Uint8Array base64 needs option string tag and
complete-chunk corrections. Alpha 17 does not contain these fixes.

Upstream main is one commit ahead at
`0342e06d1c893c15eb9d22c5fc2bfe2c5965c81b`:
https://github.com/CanadaHonk/porffor/commit/0342e06d1c893c15eb9d22c5fc2bfe2c5965c81b
It fixes TextEncoder astral and lone-surrogate encoding and encodeInto's short
buffer behavior. This overlaps our Unicode encoder patch and may let us remove
that patch after the change ships. Its unpatched encoder already passes our
native Unicode, lone-surrogate and short-buffer regression in an isolated copy. We keep the released pin and our verified patch for now.

## Better Auth

Version 1.7.1 passes native signup, signed-cookie sessions, wrong-password
rejection, signin, signout and session revocation using an explicit memory
adapter and its default password hashing. Optimized credential operations take
about 6 to 8 seconds on the development machine. The memory adapter is a probe,
not persistent storage. Production adapters and OAuth/plugins remain untested.
Database-free sessions select JWE and require AES, which native crypto does not
support. See the runtime's WEB_STREAMS.md for the stream transport limits.

## Verification

The development branches pass 183 package tests and 114 CLI tests; broker kitchen
sink passes 37 checks, standalone kitchen sink passes 40 checks, and all 21
small examples pass. The isolated package release passes 177 tests. Native
crypto, Unicode, live iterators, streams, base64,
model resolution and global timer checks pass. Native timer functions are also
exposed on globalThis for libraries using host-task yields.

The stream ponyfill IIFE still fails with a prototype TypeError on Alpha 17;
its module-scope adaptation remains necessary. The saved standalone auth probe
also passes with fresh noble hashes 2.4 and zod 4.6.5 dependencies.
