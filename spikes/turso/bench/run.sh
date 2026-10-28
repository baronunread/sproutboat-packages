#!/usr/bin/env bash
# run.sh <out> <script args...> : under both locks, bench12 must be idle
cd ~/.local/share/sproutboat-bench
out=$1; shift
( flock -w 7200 9; flock -w 7200 8; systemctl is-active bench12 | grep -q '^active' && { echo "bench12 busy"; exit 1; }; turso-20261028/"$@" ) 9>othello.lock 8>12dollar-20261026/othello.lock 2>&1 | tee turso-20261028/$out
