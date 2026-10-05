# Porffor pin scorecard

Pin: alpha-15 (72d048d73d49e217631ac8a1bc4fa9070d22fbc9). Compatibility report: 2026-10-05T00:30:02.525Z.

| Measure | Result |
| --- | ---: |
| Fixtures compiled | 32/32 |
| Behavior matches | 30/32 |
| Median / p95 compile, ms | 420 / 822 |
| Median / p95 binary, bytes | 1033344 / 1049904 |
| Patch markers | 38 |
| Upstream files written | 10 |
| Fresh patch application | pass |

Previous snapshot: alpha-13-547c781.json. Matches 30/32 to 30/32; patch markers 28 to 38.

## Patch inventory

- `compiler/render.js`: PORT_MARKER, CONSOLE_MARKER, BYTESTRING_MARKER, READ_RAW_MARKER
- `compiler/index.js`: LINK_MARKER, CFLAGS_MARKER, FP_CONTRACT_MARKER, HTTP10_IMPORT_MARKER, HTTP10_CALL_MARKER
- `compiler/builtins/typedarray.js`: TYPED_ARRAY_FROM_MARKER, TA_SET_OFFSET_MARKER, TA_JOIN_MARKER
- `compiler/builtins/date.ts`: DATE_PARSER_MARKER
- `compiler/builtins/promise.ts`: PROMISE_NULL_MARKER
- `compiler/builtins/string.ts`: REPLACE_ALL_MARKER
- `compiler/codegen.js`: TA_GET_MARKER, TA_SET_BOUNDS_MARKER
- `compiler/parse.js`: CLASS_SELF_MARKER
- `compiler/uwebsockets.js`: HTTP10_SHIM_MARKER, BODY_MARKER, STATUS_SIG_MARKER, STATUS_303_MARKER, STATUS_DEFAULT_MARKER, HDR_SIG_MARKER, HDR_CALL_MARKER, HDR_CAP_MARKER, HDR_SKIP_MARKER, HDR_APPEND_MARKER, READ_RAW_DECL_MARKER, FORBIDDEN_HDR_MARKER, WRITE_RESPONSE_MARKER, R2_TRANSFER_MARKER, R2_TRANSFER_CALL_MARKER, R2_DOWNLOAD_CACHE_MARKER, R2_RANGE_CACHE_MARKER, R2_CONDITIONAL_CACHE_MARKER, R2_STREAMING_CACHE_MARKER, R2_RANGE_HEADER_CACHE_MARKER
- `compiler/builtins_precompiled.js`: regenerated builtin table

Patch source SHA-256: `849997ab545a760019941886780b3fc70c89b67581cc9acf2b51ca6ff8a37d17`.

## Known behavior gaps

- 15-date-iso.js: request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null}
- 16-date-parts.js: request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"}

## Review

Use this scorecard with the full compatibility report and issue #35's build telemetry. If behavior regresses or patch work grows, review the individual patches and measure an alternate backend with the same fixtures.
