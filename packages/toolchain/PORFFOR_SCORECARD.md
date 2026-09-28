# Porffor pin scorecard

Pin: alpha-10 (08ac7ee1077c05da2bec18dcca15197051e87b62). Compatibility report: 2026-09-28T07:08:44.821Z.

| Measure | Result |
| --- | ---: |
| Fixtures compiled | 32/32 |
| Behavior matches | 30/32 |
| Median / p95 compile, ms | 4468 / 7436 |
| Median / p95 binary, bytes | 983392 / 1016464 |
| Patch markers | 27 |
| Upstream files written | 6 |
| Fresh patch application | pass |

Previous snapshot: alpha-9-de4eb58.json. Matches 30/32 to 30/32; patch markers 27 to 27.

## Patch inventory

- `compiler/render.js`: PORT_MARKER, CONSOLE_MARKER, BYTESTRING_MARKER, READ_RAW_MARKER
- `compiler/index.js`: LINK_MARKER, CFLAGS_MARKER
- `compiler/builtins/typedarray.js`: TYPED_ARRAY_FROM_MARKER
- `compiler/builtins/date.ts`: DATE_PARSER_MARKER
- `compiler/uwebsockets.js`: BODY_MARKER, STATUS_SIG_MARKER, STATUS_303_MARKER, STATUS_DEFAULT_MARKER, HDR_SIG_MARKER, HDR_CALL_MARKER, HDR_CAP_MARKER, HDR_SKIP_MARKER, HDR_APPEND_MARKER, READ_RAW_DECL_MARKER, FORBIDDEN_HDR_MARKER, WRITE_RESPONSE_MARKER, R2_TRANSFER_MARKER, R2_TRANSFER_CALL_MARKER, R2_DOWNLOAD_CACHE_MARKER, R2_RANGE_CACHE_MARKER, R2_CONDITIONAL_CACHE_MARKER, R2_STREAMING_CACHE_MARKER, R2_RANGE_HEADER_CACHE_MARKER
- `compiler/builtins_precompiled.js`: regenerated builtin table

Patch source SHA-256: `edf60b7104e2d0b8efb64e38459fd2d5616ccdf24995ad1d4ca07fa232db4eaf`.

## Known behavior gaps

- 15-date-iso.js: request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null}
- 16-date-parts.js: request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"}

## Review

Use this scorecard with the full compatibility report and issue #35's build telemetry. If behavior regresses or patch work grows, review the individual patches and measure an alternate backend with the same fixtures.
