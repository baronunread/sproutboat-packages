#!/usr/bin/env bash
source $HOME/.local/share/sproutboat-bench/turso-20261028/common.sh
trap 'sudo systemctl stop bench12; rm -rf /tmp/sbt12' EXIT
for bin in "$@"; do
  serve $bin
  { curl -s localhost:3000/feed; echo; for id in 1 5 77 123456 499999 500000 0 abc 99999999; do curl -s -i localhost:3000/posts/$id | grep -v -i -E '^(date|content-length)'; echo; done; curl -s -i localhost:3000/nope | grep -v -i '^date'; } > /tmp/sbt-verify-$(basename $bin).txt
  md5sum /tmp/sbt-verify-$(basename $bin).txt
done
