# Porffor pin scorecard

Pin: alpha-9 (de4eb588264885b3a1596f75010e371a2052033f). Compatibility report: 2026-09-24T15:10:02.431Z.

| Measure | Result |
| --- | ---: |
| Fixtures compiled | 32/32 |
| Behavior matches | 29/32 |
| Median / p95 compile, ms | 3150 / 3508 |
| Median / p95 binary, bytes | 983392 / 1016464 |
| Patch markers | 26 |
| Upstream files written | 5 |
| Fresh patch application | pass |

This is the first recorded pin. Compare the next pin against this snapshot.

## Patch inventory

- `compiler/render.js`: PORT_MARKER, CONSOLE_MARKER, BYTESTRING_MARKER, READ_RAW_MARKER
- `compiler/index.js`: LINK_MARKER, CFLAGS_MARKER
- `compiler/builtins/typedarray.js`: TYPED_ARRAY_FROM_MARKER
- `compiler/uwebsockets.js`: BODY_MARKER, STATUS_SIG_MARKER, STATUS_303_MARKER, STATUS_DEFAULT_MARKER, HDR_SIG_MARKER, HDR_CALL_MARKER, HDR_CAP_MARKER, HDR_SKIP_MARKER, HDR_APPEND_MARKER, READ_RAW_DECL_MARKER, FORBIDDEN_HDR_MARKER, WRITE_RESPONSE_MARKER, R2_TRANSFER_MARKER, R2_TRANSFER_CALL_MARKER, R2_DOWNLOAD_CACHE_MARKER, R2_RANGE_CACHE_MARKER, R2_CONDITIONAL_CACHE_MARKER, R2_STREAMING_CACHE_MARKER, R2_RANGE_HEADER_CACHE_MARKER
- `compiler/builtins_precompiled.js`: regenerated builtin table

Patch source SHA-256: `fdb1613910761707b0e65bee035cd43879dc0927cc19cada5dfbfd0e4474af55`.

## Known behavior gaps

- 15-date-iso.js: request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null}
- 16-date-parts.js: request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"}
- 32-date-offset.js: request 1 mismatch: expected {"status":200,"body":"{\"utc\":\"2024-01-02T03:04:05.000Z\",\"plus\":\"2024-01-02T01:04:05.000Z\",\"minus\":\"2024-01-02T08:04:05.000Z\",\"millis\":\"2024-01-02T02:04:05.250Z\"}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"utc\":\"2024-01-02T03:04:05.000Z\",\"plus\":\"2024-01-02T03:04:05.002Z\",\"minus\":\"2024-01-02T03:04:05.005Z\",\"millis\":\"2024-01-02T04:04:05.250Z\"}","content-type":"application/json;charset=utf-8"}

## Review

Use this scorecard with the full compatibility report and issue #35's build telemetry. If behavior regresses or patch work grows, review the individual patches and measure an alternate backend with the same fixtures.
