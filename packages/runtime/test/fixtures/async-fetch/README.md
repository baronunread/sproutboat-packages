Repro for standalone `fetch()` off the event loop (compatibility date 2026-11-16).

```sh
bun slow.ts 19100 &                                   # /slow?delay=MS, /echo
sproutboat build --standalone --target host .         # compatibility_date 2026-11-16
PORT=19201 SB_EGRESS_ALLOW=127.0.0.1 ./dist/af-fan &
curl 'localhost:19201/fan?n=20&delay=100'             # about 110 ms; 2,040 ms at 2026-11-15
curl 'localhost:19201/order?delay=200' & curl 'localhost:19201/order?delay=200'   # interleave from 11-16
```
