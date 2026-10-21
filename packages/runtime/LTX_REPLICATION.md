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
The encoder streams one page at a time and spools index records with `tmpfile()`.

For every LTX file:

1. Write a `.tmp` file, flush it and fsync it.
2. Publish the completed filename with an atomic, no-replace hard link, unlink
   the temporary name, and fsync the generation directory. A finished file is
   never replaced. This has rename-style publication with no overwrite race.
3. Write a versioned, checksummed position record to `position.tmp`, fsync it,
   rename it to `position`, and fsync the root directory. The record includes
   generation, TXID, salts, next WAL byte offset, database checksum, WAL checksum
   state, page size and committed page count.
4. Only then checkpoint the source database.

Capture, fsync and publication failures latch the database closed to subsequent
operations until restart. The SQL commit has already happened when a hook error
is returned. A failed request can therefore represent a committed transaction;
applications must use idempotent transaction identifiers for retries.

## Qualification status

Capture is tested against the exact inline C through `bun run test:native-ltx`,
including independent BigInt CRC and index verification, a 102-file chain,
byte-exact restore, integrity checking and oversized transaction rollback.
The workspace prototype additionally tests the compiled Porffor executable,
including external writer exclusion and invariant PRAGMA rejection.
Restart validation and randomized crash qualification are the next step. Do not
interpret this draft as a completed restart-safe backup service.

No uploader is included. Finished local files are retained without a retention
policy; disk usage of the backup chain is not bounded by the WAL ceiling.

Format and API references: [SQLite WAL](https://www.sqlite.org/fileformat2.html#walformat),
[commit hook](https://www.sqlite.org/c3ref/wal_hook.html),
[checkpoint](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html).
