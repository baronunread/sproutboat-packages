#!/usr/bin/env bash
source /data/home/sb-bench/turso/common.sh
trap 'stopall' EXIT
for bin in "$@"; do
  serve $bin
  { curl -s localhost:3000/feed; echo; for id in 1 5 77 123456 499999 500000 0 abc 99999999; do curl -s -i localhost:3000/posts/$id | grep -v -i -E '^(date|content-length)'; echo; done; curl -s -i localhost:3000/nope | grep -v -i '^date'; } > /data/home/sb-bench/turso/verify-$(basename $bin).txt
  md5sum /data/home/sb-bench/turso/verify-$(basename $bin).txt
done
