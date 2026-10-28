D=/data/home/sb-bench/turso
UNIT=sbt12
CG=/sys/fs/cgroup/system.slice/$UNIT.service
RUN=$D/run
run() { GOMAXPROCS=2 taskset -c 2,3 $D/loadgen-only -addr 127.0.0.1:3000 -tokens $D/tokens.json -conns 512 "$@"; }
mix() { GOMAXPROCS=2 taskset -c 2,3 $D/loadgen -addr 127.0.0.1:3000 -tokens $D/tokens.json -conns 512 "$@"; }
serve() {
  sudo systemctl stop $UNIT 2>/dev/null || true
  sudo systemctl reset-failed $UNIT 2>/dev/null || true
  rm -rf $RUN && mkdir -p $RUN/data/d1 && cp "$D/feed.db" $RUN/feed.db
  ln -s $RUN/feed.db $RUN/data/d1/DB.sqlite
  sudo systemd-run --unit=$UNIT --uid="$(id -u)" --gid="$(id -g)" \
    -p AllowedCPUs=1 -p MemoryMax=1536M -p MemorySwapMax=0 -p LimitNOFILE=65535 -p CPUAccounting=yes \
    -E SQLITE_PATH=$RUN/feed.db -E JWT_SECRET=twelve-dollar-challenge -E HOST=0.0.0.0 -E PORT=3000 \
    -E SB_DATA_DIR=$RUN/data "$1" >/dev/null 2>&1
  for _ in $(seq 60); do curl -sf localhost:3000/health >/dev/null && break; sleep 0.5; done
  sleep 1
}
stat_us() { awk -v k=$1 '$1==k{print $2}' $CG/cpu.stat; }
stopall() { sudo systemctl stop $UNIT 2>/dev/null; rm -rf $RUN; }
