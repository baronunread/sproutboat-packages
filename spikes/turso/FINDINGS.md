# Spike: Turso as a D1 engine in the standalone binary

Status: spike, findings only. Not a product change. Turso = github.com/tursodatabase/turso
(`bindings/c`, crate `turso_sqlite3` 0.9.0-pre.1, HEAD 017ea18 of 2026-10-28).

## Build switch

`SB_SQLITE_ENGINE=turso SB_TURSO_LIB=<libturso_sqlite3.a> SB_TURSO_SYSLIBS="" sproutboat build --standalone`

The toolchain (`patch.ts`) drops the SQLite object the CLI adds to `SB_EXTRA_LINK`, links Turso's static
library in its place and passes `-DSB_ENGINE_TURSO=1` to the C compile. The CLI itself is unchanged.
Without the variable nothing changes. `build-turso.sh` builds the library (macOS arm64, and
linux-x86_64 via `x86_64-unknown-linux-musl` with zig cc).

## Workarounds (all of them)

1. LTX / replication compiled out: Turso has no `sqlite3_wal_hook`, no `sqlite3_vfs_find/_register`,
   and `sqlite3_set_authorizer` is a stub. The LTX block is replaced by inert stubs; `SB_LTX_ENABLE=1`
   on a database that would be captured refuses to open it (so no silent loss of backup).
2. `sqlite3_error_offset` does not exist: stubbed to return -1 ("no offset"). Errors lose the
   "at offset N" text.
3. Pragmas are sent one statement per `sqlite3_exec`: Turso stops a multi-statement exec at the first
   pragma it rejects.
4. Library link: Rust static library, 19.8 MB binary vs 6.3 MB with SQLite; the zig `-mtune=native`
   problem is worked around by dropping `-mtune=*` in the `zcc` shim; aegis's build.rs hardcodes `clang`
   so a clang -> zcc shim leads PATH.
5. Query planner: the API challenge's feed query (`posts JOIN users` + correlated `count(*)`,
   `ORDER BY created_at DESC LIMIT 20`) picks a bad join order in Turso and never completes on a
   500k-post database. Rewriting `JOIN` as `CROSS JOIN ... ON` (a join-order pin) fixes it. Table
   "turso-hint" below. This is an app-side change, i.e. a parity gap.

Not needed in this codebase (the brief's guesses): there is no `sb_sql_budget`, no progress-handler
or interrupt use and no read-only open flag in `transport-embedded.js` at this commit, so no
workaround exists for them. Turso does have `progress_handler` and `interrupt` per its COMPAT.md,
so a budget could be added later. Other Turso gaps (COMPAT.md): `sqlite3_create_function`, FTS3/4/5,
extensions, `foreign_key_check`, INSTEAD OF triggers; MVCC / `BEGIN CONCURRENT` is experimental.

## D1 parity suite (the "D1 57/64" suite, run on macOS arm64 builds)

SQLite 57 pass / 1 code-only / 6 fail. Turso 52 pass / 5 code-only / 7 fail. The six shared fails
(allEmpty, runUpdate, runDelete, batch, execPartial, pragmaUserVersion) and execError are identical
under both engines, i.e. not engine related. Differences:

| case | SQLite | Turso | why |
|---|---|---|---|
| syntaxError | pass | code | message `near "SELEC": syntax error` has no `at offset 0` (no `sqlite3_error_offset`) |
| missingTable | pass | code | Turso prefixes `Parse error: ` to `no such table` |
| uniqueViolation | pass | code | no extended code (`SQLITE_CONSTRAINT_PRIMARYKEY`), only `SQLITE_CONSTRAINT` |
| notNullViolation | pass | code | no extended code (`..._NOTNULL`) |
| batchRollback | pass | fail | the error string inside the batch result lacks the extended code |

"code" = error code matches, message text differs from workerd. Raw rows:
`results/score-*-mac.json`.

## API-challenge benchmark

The per-endpoint A/B first ran on instabox-romeo (4 vCPU EPYC); romeo then went offline, so the
mix rate runs and RSS are from othello (below), where a first A/B had also been done.

### On instabox-romeo

Server pinned to CPU 1 (systemd unit, MemoryMax 1536M), loadgen on CPUs 2-3, a copy of the 250 MB
feed.db per run, interleaved, 3 trials. CPU = user+sys µs per request from the unit's cpu.stat,
median of 3 (see `romeo/cmp-1.out`). Rates 300-500 req/s. Responses of all three binaries are
byte-identical on the verify script (on both boxes).

| endpoint | SQLite µs | Turso µs | Turso + CROSS JOIN hint µs |
|---|---|---|---|
| feed | 148 | does not complete (100% errors) | 170 |
| post read | 87 | 101 | 100 |
| like | 132 | 190 | 171 |
| create | 190 | 203 | 200 |

RSS after the run: SQLite 7-10 MiB, Turso 22-29 MiB.

### On othello (the box the earlier numbers came from; CPU-pinned, both locks held)

CPU µs per request (user+sys, median of 3, rates 1000-2000 req/s; `results/othello/all1.out`, `all2.out`):

| endpoint | SQLite | Turso | Turso + CROSS JOIN hint |
|---|---|---|---|
| feed | 483 | does not complete (100% errors) | 606 |
| post read | 245 | 271 | 285 |
| like | 419 | 505 | not run (romeo: 171 vs 132 SQLite) |
| create | 580 | 514 | not run (romeo: 200 vs 190 SQLite) |

Like and create are within the run-to-run noise of each other on othello (SQLite 414-480 and 572-720).

Mix (the challenge loadgen, bar p95<500ms, p99<1s, errors<1%), 30 s per rate, RSS at the end:

| engine | rate that holds the bar | first rate that fails | RSS |
|---|---|---|---|
| SQLite | 4000 req/s (p95 202 ms, p99 214 ms; 3600 also passes with p95 441 ms) | 4400 (saturates at ~2.9k, p95 13.7 s) | 11 MiB |
| Turso + hint | 2600 req/s (p95 70 ms, p99 177 ms) | 2700 (p95 1.47 s) | 43-46 MiB |
| Turso, no hint | none: every feed request times out | | |

Turso holds about 65% of SQLite's rate (2600 vs 4000) with 4x the memory. The feed query on the
unhinted build burns ~10 s of CPU per 20-row page (diag.out: the planner scans users and sorts all
500k posts; SQLite walks `posts_created_at_id_idx`). The written database was copied out after the write endpoints ran (`integ.sh`) but no integrity check was run on it.

## Not done

- `BEGIN CONCURRENT` on the write endpoints: skipped. The standalone binary is one single-threaded
  process per CPU, so there is no intra-process write concurrency to gain, and the mode is experimental.

## Recommendation

DROP for now, revisit in about 6 months. Reasons: LTX backup/replication cannot work (no WAL hook),
error parity regresses (5 more parity cases), a planner regression made the main read endpoint
unusable without rewriting the query, per-request CPU is 15-45% higher on every endpoint, RSS is 3x,
and the binary is 3x larger. Turso gives nothing the standalone needs today. Re-check when it ships
`sqlite3_wal_hook`, extended error codes and a stable MVCC.
