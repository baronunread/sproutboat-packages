#!/usr/bin/env bash
# w.sh <out> <script> args... : takes the romeo lock, runs, tees to out
cd /data/home/sb-bench/turso
out=$1; shift
( flock -w 20000 9; /data/home/sb-bench/turso/"$@" ) 9>/data/home/sb-bench/romeo.lock 2>&1 | tee /data/home/sb-bench/turso/$out
