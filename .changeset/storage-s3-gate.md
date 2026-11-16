---
"@sproutboat/runtime": minor
---

Storage stage S3 (design 029), the runtime half of the acknowledgement gate, dark like S1 and S1b: nothing changes unless the host sets `SB_LTX_GATE=1` and the app's compatibility date is 2026-11-20 or later. (The date is a placeholder for the generation that ships the gate; move it when that is known.)

- **A commit position.** The runtime counts the commits it captured (`sb_commit_seq`, exported; the host reads it and stamps every frame that leaves the worker). The host holds a reply, a WebSocket message or a stream chunk until the store has what the worker committed up to that position durable on two replicas (or in R2). The runtime reads back what was confirmed (`sb_commit_confirmed`, written by the host).
- **Outgoing calls wait.** `fetch()` and service-binding calls made after a commit that is not confirmed yet wait for the confirmation (30 s at most, then they reject and are not made). The wait asks the host to have the store confirm now (a note, \`gate N\`) and polls the confirmed word every millisecond. A call with nothing unconfirmed behind it is not delayed.
- **\`allowUnconfirmed\`** on a Durable Object storage write (\`put\`, \`delete\`, \`deleteAll\`, \`setAlarm\`, \`deleteAlarm\`) is honoured: the commit is replicated, and nothing waits for it.
- **\`storage.sync()\`** resolves when what was committed before the call has reached the quorum (or R2). With the gate off it resolves at once, as before.
- Off for the standalone binary and the broker (no host to confirm), and for apps on older compatibility dates. \`SB_GATE_TEST_CONFIRM_MS\` stands in for the host in compiled-app tests.

Generation impact: the inline C (two exported words, a counter bump after a capture) and the prelude (outgoing-call wait, storage options, \`sync()\`): a runtime generation, tier \`prelude\` requalification. The host needs a build for the frame change (every reply, stream and WebSocket frame from a worker carries two more numbers), so the two ship together.
