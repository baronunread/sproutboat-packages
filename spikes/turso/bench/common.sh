B=$HOME/.local/share/sproutboat-bench
D0=$B/12dollar-20261026         # loadgen binary only (read only)
P=$B/perendpoint-20261027       # per-endpoint loadgen (read only)
D=$B/turso-20261028             # our copy of feed.db + tokens
CG=/sys/fs/cgroup/system.slice/bench12.service
run() { GOMAXPROCS=1 taskset -c 0 $P/loadgen-only -addr 127.0.0.1:3000 -tokens $D/tokens.json -conns 512 "$@"; }
mix() { GOMAXPROCS=1 taskset -c 0 $D0/loadgen -addr 127.0.0.1:3000 -tokens $D/tokens.json -conns 512 "$@"; }
serve() {
  sudo systemctl stop bench12 2>/dev/null || true
  sudo systemctl reset-failed bench12 2>/dev/null || true
  rm -rf /tmp/sbt12 && mkdir -p /tmp/sbt12/data/d1 && cp "$D/feed.db" /tmp/sbt12/feed.db
  ln -s /tmp/sbt12/feed.db /tmp/sbt12/data/d1/DB.sqlite
  sudo systemd-run --unit=bench12 --uid="$(id -u)" --gid="$(id -g)" \
    -p AllowedCPUs=1 -p MemoryMax=1536M -p MemorySwapMax=0 -p LimitNOFILE=65535 -p CPUAccounting=yes \
    -E SQLITE_PATH=/tmp/sbt12/feed.db -E JWT_SECRET=twelve-dollar-challenge -E HOST=0.0.0.0 -E PORT=3000 \
    -E SB_DATA_DIR=/tmp/sbt12/data "$1" >/dev/null 2>&1
  for _ in $(seq 60); do curl -sf localhost:3000/health >/dev/null && break; sleep 0.5; done
  sleep 1
}
stat_us() { awk -v k=$1 '$1==k{print $2}' $CG/cpu.stat; }
