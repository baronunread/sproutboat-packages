# Native bytes ABI v1

Experimental primitives for the trusted offline LTX restore build. This does not
expose a tenant filesystem API or implement a public restore command. The compiler
rejects adapter references unless the builder passes **`--sb-native-bytes-v1`**.
Do not derive that option from tenant source, app config or a binding. It is off
by default, including in sproutd. A string-valued `=false` is not an opt-in.
Only trusted restore source may be compiled with it: do not combine this option
with a tenant module. Tenant modules keep the option off even if a host executable
also contains a separate administrative restore mode.

The build must use the native-fetch backend and an embedded transport containing
the actual `static uint64_t sb_ltx_crc(uint64_t, const void *, size_t)` definition.
The check examines compiled transport text, not a packages path, so vendored
transports are checked too. CRC keeps that existing kernel unchanged. No runtime
or transport source is modified by this feature.

## Supported primitives

- `__Porffor_sproutboat_crc64_v1(state, data, offset, length)` updates the first
  eight bytes of `state` with raw CRC64-ISO state, in big-endian order. Initialize
  those bytes to FF; complement the result for Go-compatible `sum64`. The input
  span may be empty and is limited to 1 MiB per call. `state` must expose at least
  eight bytes. Hash state is caller-owned, so reset and independent hashers do
  not share mutable state. Overlapping input is consumed before state is written.
- `__Porffor_sproutboat_file_io_v1(operation, fd, view, offset, length, position)`
  performs pread (0) or pwrite (1), at most 128 KiB. It retries interrupted I/O,
  returns the byte count at EOF, and returns negative errno on a native failure,
  including after partial progress. Callers must treat errors and unexpected
  short counts as failure. A zero-length request performs no syscall.
- `__Porffor_sproutboat_file_ctl_v1(operation, path, fd, position)` opens read-only
  (0), opens/create-and-truncates writable (1), gets size (2), closes (3), fsyncs
  (4), or truncates to position (5). Success returns fd, size or zero; native
  errors return negative errno. Open uses no-follow/nonblocking/close-on-exec,
  checks regular-file status, and creates mode 0600. Writable open truncates only
  after that check. Paths must be nonempty strings, at most 4095 UTF-8 bytes,
  without NUL. Only open uses path; only truncate uses position.

Views must be Uint8Array over a fixed, non-shared, mutable ArrayBuffer. Detached,
resizable, immutable and other buffer types are refused. Subarray byte offsets
are honored. Bounds, operation codes, fd range and safe integer file positions
are checked before native access; invalid arguments throw TypeError/RangeError.
No JS coercions or callbacks run while a native pointer is in use. Native calls
do not allocate JS heap objects, yield, or retain a view pointer. GC stays on.
The supporting `view`, `fd` and `position` builtins are internal, are not public
entry points, and are subject to the same build gate.

These privileged operations do not enforce quotas or coordinate a live SQLite
connection. The restore controller must enforce stopped/immutable input,
ownership locks, destination protection, checksums, fsync and publication.
Opening/closing the inode of a live captured DB can invalidate POSIX locks; use
these primitives only in the separate offline startup mode.

## Compiler and validation

The compiler owns typed-array representation and checks the pinned layout before
patching. The new source participates in PATCH_FINGERPRINT. The patch is guarded
and idempotent. Helpers are lazy: with no adapter reference, the option changes
neither app C nor server C. This does not replace the host's b10/real-app identity
and generation requalification.

Run `bun run test:native-bytes` for disabled tenant references, the actual-provider
check, unused-option identity, native file operations/errors, bounds, views,
independent hashers/reset, and 300 CRC vectors against an independent BigInt
implementation. The tests compile with Node as a build tool; the executable runs
with Node/Bun excluded from PATH. `bun test packages/toolchain/src/native-bytes.test.ts`
checks patch guards and idempotency. Fingerprint updates use the existing
`UPDATE_FINGERPRINT=1 bun test packages/toolchain/src/fingerprint.test.ts` command.

AI assistance: OpenAI Codex (GPT-6.1).
