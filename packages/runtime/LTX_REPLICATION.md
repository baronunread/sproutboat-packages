# Experimental local LTX replication

AI assistance: OpenAI Codex (GPT-6.1).

This feature is for an embedded D1 database owned by one native executable.
Enable it with compatibility date `2026-10-22` or later, `SB_LTX_ENABLE=1`,
and `SB_LTX_DATABASE=DB` (the exact D1 binding name). Earlier compatibility dates,
unset flags, other bindings and the broker keep their existing behavior.
No Node or Bun runtime is needed by the executable.

## Capture and bounds

SQLite uses WAL, synchronous FULL, no auto-checkpoint, and exclusive locking.
An advisory lock also rejects another copy of the executable using the same
path. Other SQLite connections, including readers, are excluded while it runs.
Do not use this feature with the SO_REUSEPORT multi-process deployment recipe.
The raw page-read descriptor stays open for the SQLite connection's lifetime:
closing any descriptor for the database inode would release process-level POSIX
locks, even if SQLite's own descriptor remained open.

The commit hook validates the WAL header, salts and rolling checksum through the
commit frame. It sorts a bounded array of `(pgno, frame)` entries and emits the
newest version of each page in ascending order. The prior database checksum is
updated using the old page version from the main file or the captured WAL prefix.
Truncation removes the checksums of discarded pages. No full database buffer or
in-memory page-index map is retained.

Each commit creates one LTX v3 file (magic `LTX1`), with a single logical TXID,
pre-apply checksum, committed database size, salts, and WAL frame range. TXIDs
start at one inside each generation; they are backup sequence numbers, not an
application transaction ID. The base contains exact checkpointed live pages
under a read transaction. It does not use VACUUM INTO. Page compression currently
uses interoperable literal-only LZ4 blocks; these are fast and have bounded memory,
but do not reduce file size. The prototype's JS word-based LZ4 compressor is a
separate path, not a claim that this C writer compresses data.

`SB_LTX_MAX_WAL_BYTES` defaults to 16 MiB, with an allowed range of 128 KiB to
1 GiB. A VFS wrapper rejects a WAL write or truncate that would cross the ceiling
with SQLITE_FULL, including inside a single huge transaction. That transaction
rolls back. Reduce transaction size to fit the ceiling; this implementation does
not split a transaction. Frame metadata is bounded by that same ceiling, about
8 bytes per WAL frame. SQLite's normal page cache remains capped at 2 MiB.

After each statement resets, checkpoint TRUNCATE runs. Multi-statement `exec`
steps and finalizes each statement separately under this opt-in, so every commit
gets a checkpoint opportunity. Inside an explicit open transaction, BUSY/LOCKED
can defer checkpointing; the VFS ceiling still applies. SQL that changes the WAL,
locking, synchronization or page-size invariants, or attaches another database,
is rejected by an authorizer. `DB.backup()` uses VACUUM INTO and is not supported
for this opted-in binding. Use the base LTX file for replication.

## Files and durability

Files live under `<database-path>.ltx/epoch-XXXXXX/`. Completed names are
`<minTXID as 16 hex digits>-<maxTXID as 16 hex digits>.ltx`.
The encoder streams one page at a time. It creates its index scratch file with
`mkstemp()` beneath `<database-path>.ltx/`, immediately unlinks the name, and uses
the open descriptor until the writer closes. This needs no access to a global
temporary directory, which a sandboxed worker may not have. The scratch file is
private (0600). A kill between creation and unlink can leave a named index file.
On startup, after acquiring the capture lock and before recovery, the owner removes
only regular root-level files matching the reserved `index-` plus six alphanumeric
characters. It does not follow symlinks or remove directories or unrelated names.
After unlink, process death releases the anonymous scratch space automatically.
Its transient disk usage grows with the index records and is not visible to the
directory-walk storage quota after unlink. Allow disk headroom for that scratch
space as well as the LTX output; the quota is not a hard filesystem limit.

For every LTX file:

1. Write a `.tmp` file, flush it and fsync it.
2. Publish the completed filename with an atomic, no-replace hard link, unlink
   the temporary name, and fsync the generation directory. A finished file is
   never replaced. This has rename-style publication with no overwrite race.
3. Write a versioned, checksummed position record to `position.tmp`, fsync it,
   rename it to `position`, and fsync the root directory. The record includes
   generation, TXID, salts, next WAL byte offset, database checksum, WAL checksum
   state, page size and committed page count.
4. Only then checkpoint the source database. After checkpoint TRUNCATE succeeds,
   atomically persist a second position record marking the database checkpointed.
   The same file/directory fsync sequence applies to that record. A crash between
   checkpoint and publication of the marker retains the conservative fallback.

Capture, fsync and publication failures latch the database closed to subsequent
operations until restart. The SQL commit has already happened when a hook error
is returned. A failed request can therefore represent a committed transaction;
applications must use idempotent transaction identifiers for retries.

## Qualification status

Capture is tested against the exact inline C through `bun run test:native-ltx`,
with global `tmpfile()` access deliberately denied in the driver so the capture
path cannot depend on it. This portable regression does not itself qualify the
Linux Landlock/seccomp sandbox; sproutd's capture-on lifecycle smoke must do that.
The tests cover independent BigInt CRC and index verification, a 102-file chain,
byte-exact restore, integrity checking, oversized transaction rollback, database truncation, explicit rollback and late position-write failure latching.
The workspace prototype additionally tests the compiled Porffor executable,
including external writer exclusion and invariant PRAGMA rejection.
Restart validation now checks the position CRC, completed LTX checksum, WAL
header/salts, commit frame and cumulative frame checksum. A matching prefix
resumes in the same generation; any later complete commits are captured before
serving. Incomplete/torn trailing WAL frames are excluded. An orphan finished
file ahead of position forces a new generation, preserving the old files.
Missing, truncated, reset or mismatched WAL takes a fresh page-exact base when
it contradicts the recorded state. Position format LTXPOS2 distinguishes W
(captured WAL prefix) from C (checkpoint complete, expected absent/empty WAL).
A C record also requires a valid completed LTX, unchanged file size and matching
full database page checksum before the generation is reused. Clean restarts do
not create a base or rewrite the position. Any unexpected nonempty WAL, offline
database modification or record mismatch retains the fresh-base fallback.
Older LTXPOS1 records are conservatively replaced by a new base on first start.
All state and file descriptors are still created lazily on first DB open.

Verification is a bounded streaming read, but it is O(database size), not constant
time. It also checks the last LTX file. Five native restarts each at 4.2 MB and
51.1 MB retained the same generation and unchanged base inode/mtime and position.
The 51.1 MB verification took 399 to 446 ms on macOS arm64 (plus about 13 ms to
health readiness); this is not a 9 ms cold-start claim for large databases.

The regression SIGKILLs at eleven durability boundaries, including the interval
between index creation and unlink and both sides of clean-marker publication,
and verifies scratch cleanup, matching-prefix resume and fallback cases.
It also recovers a committed tail beyond the durable cursor. The full Porffor executable passed 200 seeded random SIGKILL iterations on macOS
arm64: 1,675 acknowledged writes retained, 88 same-generation resumes and 112
fresh-base recoveries. Every finished chain passed file/database CRC verification,
integrity_check, deterministic source comparison at the last durable TXID, and
comparison after restart. The test also recovered commits whose HTTP response
was interrupted. Evidence and the runnable harness are in the linked prototype
workspace; the self-contained durability-boundary regression runs in this repo's
native CI. These are process-crash tests, not power-cut or storage-failure tests.
Linux CI exercises the same C implementation; a randomized full executable Linux
campaign and a power-loss campaign are not yet qualified.

No uploader is included. Finished local files are retained without a retention
policy; disk usage of the backup chain is not bounded by the WAL ceiling.

Format and API references: [SQLite WAL](https://www.sqlite.org/fileformat2.html#walformat),
[commit hook](https://www.sqlite.org/c3ref/wal_hook.html),
[checkpoint](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html).
