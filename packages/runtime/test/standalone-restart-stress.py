#!/usr/bin/env python3
"""Restart stress for a standalone binary (docs/standalone.md, "Restarting without dropping a request").

    standalone-restart-stress.py BINARY --mode MODE [--restarts N] [--keepalive N] [--fresh N] [--writes]

Linux. Continuous load against one port while the binary is replaced N times; the count that matters
is how many requests failed. MODE says how the swap is done:

  overlap     the old recipe: start the new copy on the same port (SO_REUSEPORT), SIGTERM the old one.
              Closing the old listener resets whatever sits in its accept queue.
  stop-start  SIGTERM the old copy, wait for it, start the new one. Nothing listens in between.
  systemd     a socket + service pair of user units under `systemd --user`; each swap is
              `systemctl --user restart`. The socket stays open, so connections queue.
  usr2        run the binary directly; each swap replaces the file on disk (install + rename) and sends
              SIGUSR2. The running copy starts the new one on its listening socket and drains.

The load is FRESH threads (a connection per request) and KEEPALIVE threads (one connection reused,
as a proxy's pool does). A reused connection the server closes in the same instant is retried once on
a new connection, as every client retries an idempotent request, and counted separately. With --writes
half the requests are POST /w against a D1 table (the app's /n route returns the row count), and the
run ends by checking that every acknowledged write is in the table, so a swap that loses or doubles one
shows up. The app is expected to answer GET /x with 200 and, for --writes, POST /w with the new row id.

Prints one JSON line; exit status 1 on any failed request or lost write.
"""
import argparse, http.client, json, os, shutil, signal, socket, subprocess, sys, tempfile, threading, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("binary")
ap.add_argument("--mode", required=True, choices=["overlap", "stop-start", "systemd", "usr2"])
ap.add_argument("--restarts", type=int, default=30)
ap.add_argument("--keepalive", type=int, default=3)
ap.add_argument("--fresh", type=int, default=3)
ap.add_argument("--writes", action="store_true")
ap.add_argument("--fresh-delay-ms", type=float, default=3, help="pause between a fresh loader's requests (conntrack: every connection leaves a TIME_WAIT entry, and a full nf_conntrack table silently drops SYNs)")
ap.add_argument("--settle-ms", type=int, default=250, help="pause between swaps")
ap.add_argument("--env", action="append", default=[], help="KEY=value for the binary")
args = ap.parse_args()

binary = Path(args.binary).resolve()
scratch = Path(tempfile.mkdtemp(prefix="sb-restart-"))
installed = scratch / "app"
shutil.copy(binary, installed)
installed.chmod(0o755)
data = scratch / "data"
data.mkdir()
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
env = dict(os.environ, PORT=str(port), SB_DATA_DIR=str(data))
for item in args.env:
    k, _, v = item.partition("=")
    env[k] = v

stop = [False]
lock = threading.Lock()
stats = {"ok": 0, "retried": 0, "writes_acked": 0}
failures = []
latencies = []
t_start = time.time()


def note_failure(kind, err):
    with lock:
        failures.append({"t": round(time.time() - t_start, 3), "kind": kind, "error": err})


def one_request(conn, write):
    t0 = time.time()
    if write:
        conn.request("POST", "/w", body=b"x")
    else:
        conn.request("GET", "/x")
    r = conn.getresponse()
    body = r.read()
    dt = time.time() - t0
    with lock:
        latencies.append(dt)
    return r.status, body.decode(errors="replace"), r.will_close


def record(status, body, write, kind):
    if status == 200 or (write and status in (200, 201)):
        with lock:
            stats["ok"] += 1
            if write:
                stats["writes_acked"] += 1
    else:
        note_failure(kind, f"status {status} {body[:40]}")


def fresh_loader(index):
    n = 0
    while not stop[0]:
        time.sleep(args.fresh_delay_ms / 1000)
        n += 1
        write = args.writes and (n + index) % 2 == 0
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
        try:
            status, body, _ = one_request(c, write)
            record(status, body, write, "fresh")
        except Exception as e:
            note_failure("fresh", type(e).__name__ + ": " + str(e)[:80])
        finally:
            c.close()


def keepalive_loader(index):
    conn = None
    n = 0
    while not stop[0]:
        n += 1
        write = args.writes and (n + index) % 2 == 0
        reused = conn is not None
        if conn is None:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
        try:
            status, body, closing = one_request(conn, write)
            if closing:
                conn.close()
                conn = None
            record(status, body, write, "keepalive")
        except Exception as e:
            conn.close()
            conn = None
            if not reused or write:
                # A write is not retried: it may have been applied, and the point is to see it fail.
                note_failure("keepalive", ("new connection: " if not reused else "write on reused connection: ") + type(e).__name__ + ": " + str(e)[:80])
                continue
            c2 = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
            try:
                status, body, _ = one_request(c2, False)
                with lock:
                    stats["retried"] += 1
                record(status, body, False, "keepalive")
            except Exception as e2:
                note_failure("keepalive", "retry failed: " + type(e2).__name__ + ": " + str(e2)[:80])
            finally:
                c2.close()


def conntrack():
    try:
        return int(Path("/proc/sys/net/netfilter/nf_conntrack_count").read_text())
    except OSError:
        return 0


def wait_ready(timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            c.request("GET", "/x")
            if c.getresponse().status == 200:
                c.close()
                return True
        except Exception:
            pass
        time.sleep(0.05)
    return False


procs = []
unit = f"sbrs-{os.getpid()}"
unit_dir = Path.home() / ".config/systemd/user"
log_n = [0]


def spawn(extra_env=None):
    log_n[0] += 1
    log = open(scratch / f"run{log_n[0]}.log", "w")
    p = subprocess.Popen([str(installed)], cwd=scratch, env=dict(env, **(extra_env or {})), stdout=log, stderr=log, start_new_session=True)
    procs.append(p)
    return p


def exited(p, limit):
    try:
        p.wait(limit)
        return True
    except subprocess.TimeoutExpired:
        return False


def alive(pid, child=None):
    """Is pid still running? A zombie nobody reaped (the container case) is gone, and our own child is reaped here."""
    if child is not None:
        return child.poll() is None
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def replace_binary():
    tmp = scratch / "app.new"
    shutil.copy(binary, tmp)
    tmp.chmod(0o755)
    os.replace(tmp, installed)


def sctl(*a):
    return subprocess.run(["systemctl", "--user", *a], capture_output=True, text=True)


summary = {"mode": args.mode, "binary": str(binary), "port": port}
threads = []
try:
    while conntrack() > 20000:
        time.sleep(5)
    summary["conntrack_at_start"] = conntrack()
    swap_ms = []
    if args.mode == "systemd":
        # Real unit files, not systemd-run: a transient service is garbage-collected when it stops,
        # which takes its socket with it. These are the units docs/standalone.md describes.
        unit_dir.mkdir(parents=True, exist_ok=True)
        (unit_dir / f"{unit}.socket").write_text(f"[Socket]\nListenStream=127.0.0.1:{port}\nBacklog=4096\nTriggerLimitIntervalSec=0\n")
        (unit_dir / f"{unit}.service").write_text(
            f"[Unit]\nRequires={unit}.socket\n# A stress run restarts several times a second; the default limit (5 starts in 10 s) would fail the unit.\nStartLimitIntervalSec=0\n\n[Service]\nExecStart={installed}\nWorkingDirectory={scratch}\n"
            f"Environment=PORT={port} SB_DATA_DIR={data}\n"
            + "".join(f"Environment={item}\n" for item in args.env)
            + "KillSignal=SIGTERM\nTimeoutStopSec=30\nMemoryMax=256M\nMemorySwapMax=0\n"
        )
        for step in (["daemon-reload"], ["start", f"{unit}.socket"]):
            r = sctl(*step)
            if r.returncode:
                raise SystemExit("systemctl " + " ".join(step) + " failed: " + r.stderr)
    else:
        current = spawn()
        newest_pid = current.pid
    if not wait_ready():
        raise SystemExit("the binary did not answer GET /x")
    t_start = time.time()
    for i in range(args.fresh):
        threads.append(threading.Thread(target=fresh_loader, args=(i,), daemon=True))
    for i in range(args.keepalive):
        threads.append(threading.Thread(target=keepalive_loader, args=(i,), daemon=True))
    for t in threads:
        t.start()
    time.sleep(1)
    seen_logs = set()
    for i in range(args.restarts):
        t0 = time.time()
        if args.mode == "overlap":
            nxt = spawn()
            time.sleep(0.4)  # up and accepting beside the old one
            current.send_signal(signal.SIGTERM)
            if not exited(current, 15):
                note_failure("restart", "old copy did not exit in 15 s")
                current.kill()
            current = nxt
        elif args.mode == "stop-start":
            current.send_signal(signal.SIGTERM)
            if not exited(current, 15):
                note_failure("restart", "old copy did not exit in 15 s")
                current.kill()
            current = spawn()
        elif args.mode == "systemd":
            replace_binary()
            r = sctl("restart", f"{unit}.service")
            if r.returncode:
                note_failure("restart", "systemctl restart: " + r.stderr[:80])
        elif args.mode == "usr2":
            replace_binary()
            pid = newest_pid
            os.kill(pid, signal.SIGUSR2)
            # The successor is the old copy's child; it logs its pid into the old copy's log file.
            deadline = time.time() + 15
            newest_pid = None
            logfile = scratch / f"run1.log"
            while time.time() < deadline and newest_pid is None:
                for line in logfile.read_text().splitlines():
                    if "restart: started" in line and line not in seen_logs:
                        seen_logs.add(line)
                        newest_pid = int(line.rsplit(" ", 1)[1])
                if newest_pid is None:
                    time.sleep(0.05)
            if newest_pid is None:
                note_failure("restart", "no successor started")
                break
            # wait for the old pid to be gone
            while time.time() < deadline and alive(pid, current if i == 0 else None):
                time.sleep(0.02)
            if not wait_ready(10):
                note_failure("restart", "successor never answered")
        swap_ms.append(round((time.time() - t0) * 1000))
        time.sleep(args.settle_ms / 1000)
    time.sleep(1)
    stop[0] = True
    for t in threads:
        t.join(30)
    lost = None
    if args.writes:
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
            c.request("GET", "/n")
            rows = int(c.getresponse().read().decode().strip())
            lost = stats["writes_acked"] - rows
            summary["rows_in_table"] = rows
        except Exception as e:
            lost = f"could not read /n: {e}"
    lat = sorted(latencies)
    summary.update({
        "restarts": args.restarts,
        "swap_ms_median": sorted(swap_ms)[len(swap_ms) // 2] if swap_ms else 0,
        "swap_ms_max": max(swap_ms or [0]),
        "requests_ok": stats["ok"],
        "reused_retried": stats["retried"],
        "writes_acked": stats["writes_acked"],
        "writes_unaccounted": lost,
        "failed": len(failures),
        "failures": failures[:12],
        "latency_ms": {"p50": round(lat[len(lat) // 2] * 1000, 2) if lat else 0, "p99": round(lat[int(len(lat) * 0.99)] * 1000, 1) if lat else 0, "max": round(lat[-1] * 1000, 1) if lat else 0},
        "seconds": round(time.time() - t_start, 1),
        "conntrack_at_end": conntrack(),
        "loaders": {"fresh": args.fresh, "keepalive": args.keepalive},
    })
finally:
    stop[0] = True
    for p in procs:
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    if args.mode == "usr2":
        # successors are not our children: stop each by the pid it logged
        for log in scratch.glob("run*.log"):
            for line in log.read_text().splitlines():
                if "restart: started" in line:
                    try:
                        os.kill(int(line.rsplit(" ", 1)[1]), signal.SIGKILL)
                    except (ProcessLookupError, ValueError):
                        pass
    if args.mode == "systemd":
        sctl("stop", f"{unit}.service", f"{unit}.socket")
        for ext in ("socket", "service"):
            (unit_dir / f"{unit}.{ext}").unlink(missing_ok=True)
        sctl("daemon-reload")
    time.sleep(0.5)
    if not os.environ.get("KEEP_SCRATCH"):
        shutil.rmtree(scratch, ignore_errors=True)
    print(json.dumps(summary))
bad = summary.get("failed", 1) or (summary.get("writes_unaccounted") not in (None, 0))
sys.exit(1 if bad else 0)
