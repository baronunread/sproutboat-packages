# Native Web Streams

The runtime installs missing Web Streams globals using the MIT-licensed
web-streams-polyfill 4.3.0. The generated implementation is embedded in the
native prelude, so deployed binaries need no JavaScript files or package loader.
Run `bun run gen:streams` from the repository root to regenerate it.

Native regression tests cover default readers, locking, pending reads,
cancellation, source errors, array conversion, writable sinks, pipeTo,
pipeThrough, transforms, tee, pull sources, byte streams and BYOB reads.
This is API support for streams in memory, not progressive HTTP transport.
A ReadableStream response body is streamed by a standalone sprout's native server:
the status and headers go out at once and each chunk is written as it is produced
(chunked encoding), so Server-Sent Events and long responses work. Chunks must be bytes.
Hosts that do not stream yet (sproutd's workers) read the stream to the end and send it
buffered, at most 32 MiB. Request bodies and outbound fetch remain buffered.
TextEncoderStream and TextDecoderStream are included, and CompressionStream and
DecompressionStream ("gzip", "deflate", "deflate-raw") in JavaScript, since the native
runtime links no zlib. Compression writes one fixed-Huffman block per chunk as it arrives
(close to zlib on text: 252 bytes against 221 for 22.5 KB); decompression inflates all
block types once the input ends and checks the CRC-32 or Adler-32. Response and Request
bodies that are ReadableStreams are read by text(), json(), arrayBuffer() and blob(), and
their chunks must be bytes, as in workerd. From compatibility date 2026-10-21, `body` is a
ReadableStream for every body type, as in Fetch: a stream body itself, otherwise a stream made
once over the bytes. Before that date it is the value as given, as apps written for earlier
releases read it (`JSON.parse(request.body)`).
BYOB buffer detachment requires transfer support from the underlying engine;
the polyfill cannot supply that engine primitive. Full Web Platform Tests
conformance has not been established for Porffor.

Porffor Alpha 16 requires controller classes at module scope, rather than inside
an IIFE. The generator also adapts dynamic array iterator lookup to the working
native array values iterator. User handler modules retain their separate scope.

Better Auth 1.7.1 now passes native email/password signup, signed-cookie session
lookup, wrong-password rejection, signin, signout and session revocation with an
explicit memory database adapter. The compiler also needs the local-function
return-type and Uint8Array base64 patches shipped with this upgrade. The default
Better Auth password hashing is retained; credential operations take about
6 to 8 seconds on the development machine with optimized native compilation.
This is a verified integration configuration, not a production database benchmark.

Database-free Better Auth selects encrypted JWE sessions and still fails because
native crypto does not implement AES. Production database adapters, OAuth,
plugins and asymmetric JWT algorithms have not been validated by this probe.
