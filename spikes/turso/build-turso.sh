#!/bin/sh
# Spike: build Turso's sqlite3-compatible C API as a static library.
#   build-turso.sh <turso-checkout> <target-dir> [mac|musl]
# macOS arm64 builds with the host toolchain (AR must be llvm-ar: Apple's ar has no -D, which the
# cc crate passes). linux-x86_64 is cross-built to x86_64-unknown-linux-musl with zig cc (zcc beside
# this file); aegis's build.rs hardcodes `clang`, so a clang -> zcc shim must lead PATH.
# Then build a sprout with:
#   SB_SQLITE_ENGINE=turso SB_TURSO_LIB=<target-dir>/<..>/libturso_sqlite3.a \
#   SB_TURSO_SYSLIBS="-framework CoreFoundation -liconv"   (macOS; empty for musl) \
#   sproutboat build --standalone
set -e
SRC=$1; OUT=$2; KIND=${3:-mac}; HERE=$(cd "$(dirname "$0")" && pwd)
cd "$SRC"
if [ "$KIND" = mac ]; then
  AR=/opt/homebrew/opt/llvm/bin/llvm-ar cargo build --release -p turso_sqlite3 --target-dir "$OUT"
else
  SHIM=$(mktemp -d); cp "$HERE/zcc" "$SHIM/clang"; cp "$HERE/zcc" "$SHIM/zcc"; chmod +x "$SHIM"/*
  printf '#!/bin/sh\nexec zig ar "$@"\n' > "$SHIM/zar"; chmod +x "$SHIM/zar"
  PATH="$SHIM:$PATH" CC_x86_64_unknown_linux_musl="$SHIM/zcc" AR_x86_64_unknown_linux_musl="$SHIM/zar" \
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$SHIM/zcc" \
    cargo build --release -p turso_sqlite3 --target x86_64-unknown-linux-musl --target-dir "$OUT"
  rm -rf "$SHIM"
fi
