# Porffor pin scorecard

Pin: alpha-13 (547c7815125b6f02474591950f8b0dd7031a03f0). Compatibility report: 2026-10-01T10:57:31.463Z.

| Measure | Result |
| --- | ---: |
| Fixtures compiled | 32/32 |
| Behavior matches | 30/32 |
| Median / p95 compile, ms | 3212 / 4703 |
| Median / p95 binary, bytes | 966864 / 999936 |
| Patch markers | 28 |
| Upstream files written | 6 |
| Fresh patch application | pass |

Previous snapshot: alpha-10-08ac7ee.json. Matches 30/32 to 30/32; patch markers 27 to 28.

## Patch inventory

- `compiler/render.js`: PORT_MARKER, CONSOLE_MARKER, BYTESTRING_MARKER, READ_RAW_MARKER, CORO_STACK_MARKER
- `compiler/index.js`: LINK_MARKER, CFLAGS_MARKER
- `compiler/builtins/typedarray.js`: TYPED_ARRAY_FROM_MARKER
- `compiler/builtins/date.ts`: DATE_PARSER_MARKER
- `compiler/uwebsockets.js`: BODY_MARKER, STATUS_SIG_MARKER, STATUS_303_MARKER, STATUS_DEFAULT_MARKER, HDR_SIG_MARKER, HDR_CALL_MARKER, HDR_CAP_MARKER, HDR_SKIP_MARKER, HDR_APPEND_MARKER, READ_RAW_DECL_MARKER, FORBIDDEN_HDR_MARKER, WRITE_RESPONSE_MARKER, R2_TRANSFER_MARKER, R2_TRANSFER_CALL_MARKER, R2_DOWNLOAD_CACHE_MARKER, R2_RANGE_CACHE_MARKER, R2_CONDITIONAL_CACHE_MARKER, R2_STREAMING_CACHE_MARKER, R2_RANGE_HEADER_CACHE_MARKER
- `compiler/builtins_precompiled.js`: regenerated builtin table

Patch source SHA-256: `6f607ac6b66fc4a51c2bf9e9525d0ab7f4e9b9dd3f942a820bbad46b7e3dbf56`.

## Known behavior gaps

- 15-date-iso.js: request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null}
- 16-date-parts.js: request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"}

## Review

Use this scorecard with the full compatibility report and issue #35's build telemetry. If behavior regresses or patch work grows, review the individual patches and measure an alternate backend with the same fixtures.
