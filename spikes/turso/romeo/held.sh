#!/usr/bin/env bash
# held.sh <rates,comma> bin... : the mix at each rate, with RSS at the end of each run
source /data/home/sb-bench/turso/common.sh
rates=$1; shift
trap 'stopall' EXIT
for bin in "$@"; do for r in ${rates//,/ }; do
  serve $bin; mix -rate 500 -dur 8s >/dev/null
  out=$(mix -rate $r -dur 30s)
  pid=$(systemctl show sbt12 -p MainPID --value); rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status 2>/dev/null)
  echo "$(basename $bin) $r rss_kb=$rss $out"
done; done
