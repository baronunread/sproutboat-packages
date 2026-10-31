---
"@sproutboat/toolchain": minor
---

A standalone binary can be replaced without resetting a connection. The kernel resets every connection waiting in a listening socket's accept queue when the last descriptor for that socket closes, and a restart used to close it (the old process died, or closed its own `SO_REUSEPORT` listener while the new one came up): about one request in a few thousand was reset at each swap. The native server now keeps the socket alive across a restart and drains the old process:

- It serves on the listening socket it is given when `LISTEN_PID` and `LISTEN_FDS` name it (systemd socket activation, fd 3), instead of binding `$PORT`. `systemctl restart` then stops and starts the service while the socket stays open, so connections wait in the queue.
- `SIGUSR2` starts the binary now on disk (the running file's path, or `SB_EXEC_PATH`) as a child with the listening socket as fd 3, then drains. The successor waits until its parent has exited before it initialises anything, because a standalone binary holds its SQLite files exclusively. Without systemd this is the same swap.
- `SIGTERM` and `SIGINT` drain: stop accepting, add `Connection: close` to every response so a keep-alive client stops reusing the connection, and exit once no socket is busy (nothing unread or unsent, no request waiting for its answer, nothing seen in the last `SB_DRAIN_QUIET_MS`, default 200) or after `SB_DRAIN_SECONDS` (default 10). A second signal exits at once. Before, `SIGTERM` killed the process with requests in flight.

uSockets binds through `bsd_create_listen_socket`, which the CLI's standalone build now patches to ask the binary for an inherited socket first (a weak reference, so an unpatched uSockets just never asks). The change is in the native shim only, never `render.js`, so sproutd is untouched, and it does nothing in a binary without the embedded transport, so the broker's sprouts behave as before. Nothing an app can see changes, so there is no new compatibility date.

`SB_MUSL_TARGET` (for example `aarch64-linux-musl`) and `SB_UWS_VARIANT` let the CLI build a musl binary for another architecture and keep a separate uWebSockets tree for it; both are inert when unset. `packages/runtime/test/standalone-restart-stress.py` is the load test: it replaces a binary N times under load and counts failed requests.
