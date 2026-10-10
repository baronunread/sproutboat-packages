# Porffor pin scorecard

Pin: alpha-16 (43087d42f0b90d14f04f3cddac034822560aefad). Compatibility report: 2026-10-10T08:51:03.637Z.

| Measure | Result |
| --- | ---: |
| Fixtures compiled | 32/32 |
| Behavior matches | 30/32 |
| Median / p95 compile, ms | 13266 / 33619 |
| Median / p95 binary, bytes | 1082960 / 1099536 |
| Patch markers | 35 |
| Upstream files written | 9 |
| Fresh patch application | pass |

Previous snapshot: alpha-15-72d048d.json. Matches 30/32 to 30/32; patch markers 38 to 35.

## Patch inventory

- `compiler/render.js`: PORT_MARKER, CONSOLE_MARKER, BYTESTRING_MARKER, READ_RAW_MARKER
- `compiler/index.js`: LINK_MARKER, CFLAGS_MARKER, FP_CONTRACT_MARKER, HTTP10_IMPORT_MARKER, HTTP10_CALL_MARKER
- `compiler/builtins/date.ts`: DATE_PARSER_MARKER
- `compiler/builtins/promise.ts`: PROMISE_NULL_MARKER
- `compiler/builtins/string.ts`: REPLACE_ALL_MARKER
- `compiler/codegen.js`: TA_GET_MARKER, TA_SET_BOUNDS_MARKER
- `compiler/parse.js`: CLASS_SELF_MARKER
- `compiler/uwebsockets.js`: HTTP10_SHIM_MARKER, BODY_MARKER, STATUS_SIG_MARKER, STATUS_303_MARKER, STATUS_DEFAULT_MARKER, HDR_SIG_MARKER, HDR_CALL_MARKER, HDR_CAP_MARKER, HDR_SKIP_MARKER, HDR_APPEND_MARKER, READ_RAW_DECL_MARKER, FORBIDDEN_HDR_MARKER, WRITE_RESPONSE_MARKER, R2_TRANSFER_MARKER, R2_TRANSFER_CALL_MARKER, R2_DOWNLOAD_CACHE_MARKER, R2_RANGE_CACHE_MARKER, R2_CONDITIONAL_CACHE_MARKER, R2_STREAMING_CACHE_MARKER, R2_RANGE_HEADER_CACHE_MARKER
- `compiler/builtins_precompiled.js`: regenerated builtin table

Patch source SHA-256: `65a48b098fb6bd355785684774be43524d31491c89be1f6b0dee17f24b9cdd20`.

## Known behavior gaps

- 15-date-iso.js: request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null}
- 16-date-parts.js: request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"}

## Review

Use this scorecard with the full compatibility report and issue #35's build telemetry. If behavior regresses or patch work grows, review the individual patches and measure an alternate backend with the same fixtures.
