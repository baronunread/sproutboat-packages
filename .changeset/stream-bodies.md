---
"@sproutboat/runtime": patch
---

A `ReadableStream` response body is sent. The stream is read to the end and the body sent buffered (at most 32 MiB). Before, the client received the text `[object ReadableStream]`. As in workerd, chunks must be bytes, and a stream of strings answers 500. Streamed (progressive) delivery is a separate step.
