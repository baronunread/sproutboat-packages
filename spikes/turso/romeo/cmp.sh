#!/usr/bin/env bash
# cmp.sh <trials> <ep:rate>,... bin... : interleaved trials, us/req (user+sys), + RSS after the run
source /data/home/sb-bench/turso/common.sh
trials=$1; eps=$2; shift 2
trap 'stopall' EXIT
for t in $(seq $trials); do for bin in "$@"; do for er in ${eps//,/ }; do
  ep=${er%%:*}; rate=${er##*:}
  serve $bin
  run -only $ep -rate 500 -dur 5s >/dev/null
  u0=$(stat_us user_usec); s0=$(stat_us system_usec)
  out=$(run -only $ep -rate $rate -dur 15s)
  u1=$(stat_us user_usec); s1=$(stat_us system_usec)
  pid=$(systemctl show sbt12 -p MainPID --value); rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status 2>/dev/null)
  n=$((rate*15))
  echo "$t $(basename $bin) $ep user=$(( (u1-u0)*10/n ))e-1 sys=$(( (s1-s0)*10/n ))e-1 total=$(( (u1-u0+s1-s0)*10/n ))e-1 rss_kb=$rss $(echo "$out" | sed -E 's/.*(achieved=[0-9]+).*(errors=[0-9.]+%).*(p95=[0-9.]+ms).*/\1 \2 \3/')"
done; done; done
