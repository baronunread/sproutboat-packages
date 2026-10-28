#!/bin/sh
B=$HOME/.cache/sb-turso-spike
CLI=$HOME/Code/Products/sproutboat-platform/wt-cli-turso/src/main.ts
cd $B/12d/sqlite && lockf -k /tmp/sproutd-mac-build.lock bun $CLI build --standalone && echo SQLITE-OK
for v in turso turso-hint; do
cd $B/12d/$v && lockf -k /tmp/sproutd-mac-build.lock env SB_SQLITE_ENGINE=turso SB_TURSO_LIB=$B/target/x86_64-unknown-linux-musl/release/libturso_sqlite3.a SB_TURSO_SYSLIBS="" bun $CLI build --standalone && echo $v-OK
done
