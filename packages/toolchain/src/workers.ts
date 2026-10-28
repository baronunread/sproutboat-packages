/**
 * Worker processes for a standalone binary (`SB_WORKERS`), patched into Porffor's uWebSockets shim
 * (compiler/uwebsockets.js) by patchWorkers. Only the shim changes: render.js, the prelude and the
 * transport are untouched, so sproutd's compiled apps are byte for byte what they were.
 *
 * The binary's main() becomes a small supervisor when more than one worker is wanted, and the old
 * main() runs in each worker, as the worker's own process, with its own JS heap, event loop and
 * SQLite connections. Each worker listens on the port itself (SO_REUSEPORT, which uWS sets on every
 * listen socket), so the kernel spreads connections. SB_WORKERS=1 never forks and runs the old main()
 * as before.
 *
 * What stays single-instance, and how:
 *  - cron, queue consumers and Durable Object alarms run on timers inside the JS runtime. Workers
 *    after the first install a note hook that swallows the runtime's "hosted" handshake, which makes
 *    the runtime skip those timers (the same path sproutd takes, with nobody to take its notes). They
 *    run in worker 0 only, so cron fires once.
 *  - an app that consumes queues or has Durable Objects runs one worker: the probe worker (index 1)
 *    sees the runtime report "local" while it starts, before it listens, and exits with
 *    EXIT_SINGLE_INSTANCE; the supervisor then runs worker 0 alone.
 *  - SB_LTX_ENABLE=1 (the SQLite backup holds an exclusive lock) runs one worker.
 *  - every other binding keeps its state in SQLite and is safe across processes (see the
 *    sqlite hook below).
 */

/** The marker that makes patchWorkers idempotent. */
export const WORKERS_MARKER = "// sproutboat: worker processes (SB_WORKERS)";

/** What a worker exits with when the app must run as one instance (BSD sysexits EX_CONFIG). */
export const EXIT_SINGLE_INSTANCE = 78;

/** Declared before PendingRequest: the count of requests still being worked on. */
export const WORKERS_INFLIGHT = String.raw`${WORKERS_MARKER}
static long sb_inflight = 0;
struct SbInflight {
  SbInflight() { ++sb_inflight; }
  ~SbInflight() { --sb_inflight; }
  SbInflight(const SbInflight&) = delete;
  SbInflight& operator=(const SbInflight&) = delete;
};
`;

/**
 * [anchor, replacement] edits to the shim as the earlier patches leave it. Every anchor must be
 * found exactly once.
 */
export const WORKERS_EDITS: [string, string][] = [
  // a request whose response is still to come
  ["struct PendingRequest {\n", WORKERS_INFLIGHT + "struct PendingRequest {\n"],
  [
    "struct PendingResponse {\n  uWS::HttpResponse<false>* res = nullptr;\n",
    "struct PendingResponse {\n  SbInflight sb_guard;\n  uWS::HttpResponse<false>* res = nullptr;\n",
  ],
  // a body still arriving: counted from creation to its last chunk (or abort)
  [
    "  if (pending->finished) return false;\n  pending->finished = true;\n",
    "  if (pending->finished) return false;\n  pending->finished = true;\n  --sb_inflight;\n",
  ],
  [
    "  auto pending = std::make_shared<PendingRequest>();\n",
    "  auto pending = std::make_shared<PendingRequest>();\n  ++sb_inflight;\n",
  ],
  // the old main() runs in each worker
  [
    "int main(void) {\n  porf_native_fetch_runtime_init();\n",
    "WORKERS_BLOCK\nstatic int sb_worker_main(void) {\n  sb_worker_setup();\n  porf_native_fetch_runtime_init();\n",
  ],
  [
    "  const int port = (int)porf_native_fetch_get_port();\n  bool listened = false;\n",
    "  sb_worker_after_init();\n  const int port = (int)porf_native_fetch_get_port();\n  bool listened = false;\n",
  ],
  [
    String.raw`    if (token) {
      listened = true;
      std::fprintf(stderr, "Porffor native fetch server listening on http://127.0.0.1:%d\\n", port);
    }`,
    String.raw`    if (token) {
      listened = true;
      sb_worker_listening(token);
      if (sb_worker <= 0) std::fprintf(stderr, "Porffor native fetch server listening on http://127.0.0.1:%d\\n", port);
    }`,
  ],
  // the supervisor and the new main(), after the old one
  [
    String.raw`    std::fprintf(stderr, "Failed to bind native fetch server\\n");
    return 1;
  }

  return 0;
}`,
    String.raw`    std::fprintf(stderr, "Failed to bind native fetch server\\n");
    return 1;
  }

  return 0;
}
WORKERS_SUPERVISOR`,
  ],
];

/** Everything the old main() calls before and while it listens. C++ inside a JS template literal: no backticks, no dollar-brace. */
export const WORKERS_BLOCK = String.raw`#include <cerrno>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <vector>
#ifdef __linux__
#include <sys/prctl.h>
#endif

#define SB_EXIT_SINGLE_INSTANCE ${EXIT_SINGLE_INSTANCE}

extern "C" {
// Defined by the prelude's inline C; a weak definition keeps a build without it linking, and
// the prelude's strong one replaces it.
__attribute__((weak)) void (*sb_host_note_hook)(const char* text, size_t length) = 0;
// The same for SQLite, which a build without the embedded transport does not link.
struct sqlite3;
__attribute__((weak)) int sqlite3_auto_extension(void (*init)(void)) { (void)init; return 1; }
__attribute__((weak)) int sqlite3_busy_timeout(struct sqlite3* db, int ms) { (void)db; (void)ms; return 1; }
__attribute__((weak)) const char* sqlite3_db_filename(struct sqlite3* db, const char* name) { (void)db; (void)name; return nullptr; }
}

static int sb_worker = -1;  // -1: one process; else this worker's index (0 is the primary)
static volatile sig_atomic_t sb_stop_flag = 0;
static us_listen_socket_t* sb_listen_token = nullptr;
static bool sb_draining = false;
static bool sb_saw_local = false;
static int sb_ready_fd = -1;
static int sb_init_lock_fd = -1;

static void sb_log(const char* format, ...) {
  char line[512];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  std::fprintf(stderr, "sproutboat: %s\\n", line);
}

// Workers after the first take the runtime's notes: nothing is delivered through them (cron,
// queues and alarms stay with worker 0), but "local" says the app consumes queues or has
// Durable Objects.
static void sb_note_swallow(const char* text, size_t length) {
  if (length == 5 && memcmp(text, "local", 5) == 0) sb_saw_local = true;
}

static bool sb_ends_with(const char* s, const char* suffix) {
  const size_t n = strlen(s), k = strlen(suffix);
  return n >= k && strcmp(s + n - k, suffix) == 0;
}

// Runs on every SQLite connection the runtime opens, before its own pragmas. A connection that waits
// for a lock instead of failing from its first statement matters most when the file is new: the
// first PRAGMA journal_mode=WAL of every worker would otherwise race to convert it, and the loser
// would stop at SQLITE_BUSY before it set busy_timeout. The first connection to the shared store
// also takes a file lock held to the end of that JS turn, so one worker at a time creates the store's
// tables (its ALTER TABLE migrations are not safe to run twice).
static int sb_sqlite_open_hook(struct sqlite3* db, char** error, const void* api) {
  (void)error;
  (void)api;
  sqlite3_busy_timeout(db, 5000);
  const char* file = sqlite3_db_filename(db, "main");
  if (file && sb_init_lock_fd < 0 && sb_ends_with(file, "/store.sqlite")) {
    const std::string lock = std::string(file) + ".init-lock";
    const int fd = open(lock.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd >= 0) {
      if (flock(fd, LOCK_EX) == 0) sb_init_lock_fd = fd;
      else close(fd);
    }
  }
  return 0;
}

static void sb_on_stop(int sig) {
  (void)sig;
  sb_stop_flag = 1;
}

static void sb_worker_setup(void) {
  if (sb_worker < 0) return;
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = sb_on_stop;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, nullptr);
  sigaction(SIGINT, &action, nullptr);
  signal(SIGCHLD, SIG_DFL);
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, nullptr);
#ifdef __linux__
  // The supervisor going away (it was killed) drains the worker instead of orphaning it.
  prctl(PR_SET_PDEATHSIG, SIGTERM);
#endif
  char index[16];
  snprintf(index, sizeof(index), "%d", sb_worker);
  setenv("SB_WORKER_INDEX", index, 1);
  if (sb_worker > 0) sb_host_note_hook = sb_note_swallow;
  sqlite3_auto_extension((void (*)(void))sb_sqlite_open_hook);
}

// After the runtime started (its module code ran), before the worker listens.
static void sb_worker_after_init(void) {
  if (sb_worker < 0) return;
  if (sb_worker > 0 && sb_saw_local) _exit(SB_EXIT_SINGLE_INSTANCE);
  if (sb_ready_fd >= 0) {
    const char ready = 'G';
    if (write(sb_ready_fd, &ready, 1) < 0) {}
    close(sb_ready_fd);
    sb_ready_fd = -1;
  }
  uWS::Loop::get()->addPostHandler(&sb_init_lock_fd, [](uWS::Loop*) {
    if (sb_init_lock_fd >= 0) {
      close(sb_init_lock_fd);
      sb_init_lock_fd = -1;
    }
  });
}

// SIGTERM or SIGINT: stop accepting, let the requests in flight finish (async responses, bodies
// still arriving, streams), then exit. Idle keep-alive connections close with the process.
// Requests a client already has queued on a connection are served until the work is done; a
// direct R2 transfer and an open WebSocket are not waited for.
static void sb_drain_tick(struct us_timer_t* timer) {
  (void)timer;
  if (!sb_stop_flag) return;
  if (!sb_draining) {
    sb_draining = true;
    if (sb_listen_token) {
      us_listen_socket_close(0, sb_listen_token);
      sb_listen_token = nullptr;
    }
  }
  if (sb_inflight <= 0 && sb_streams.empty() && sb_reqbodies.empty()) {
    fflush(nullptr);
    _exit(0);
  }
}

static void sb_worker_listening(us_listen_socket_t* token) {
  if (sb_worker < 0) return;
  sb_listen_token = token;
  struct us_timer_t* timer = us_create_timer((struct us_loop_t*)uWS::Loop::get(), 0, 0);
  us_timer_set(timer, sb_drain_tick, 100, 100);
}
`;

/** The supervisor and the new main(). */
export const WORKERS_SUPERVISOR = String.raw`
// ---- the supervisor ----

static int sb_sigpipe[2] = { -1, -1 };
static void sb_forward_signal(int sig) {
  const int saved = errno;
  const char note = sig == SIGCHLD ? 'C' : 'T';
  if (write(sb_sigpipe[1], &note, 1) < 0) {}
  errno = saved;
}

static double sb_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static long sb_env_long(const char* name, long fallback) {
  const char* raw = getenv(name);
  if (!raw || !*raw) return fallback;
  char* end = nullptr;
  const long value = strtol(raw, &end, 10);
  return (*end || value < 0) ? fallback : value;
}

// CPUs this process may use: the affinity mask, lowered by a cgroup quota.
static int sb_cpu_count(void) {
#ifdef __linux__
  int cpus = 1;
  cpu_set_t set;
  CPU_ZERO(&set);
  if (sched_getaffinity(0, sizeof(set), &set) == 0) cpus = CPU_COUNT(&set);
  if (cpus < 1) cpus = 1;
  long quota = -1, period = 0;
  if (FILE* f = fopen("/sys/fs/cgroup/cpu.max", "r")) {
    char first[32] = {0};
    if (fscanf(f, "%31s %ld", first, &period) == 2 && strcmp(first, "max") != 0) quota = strtol(first, nullptr, 10);
    fclose(f);
  } else {
    if (FILE* q = fopen("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "r")) {
      if (fscanf(q, "%ld", &quota) != 1) quota = -1;
      fclose(q);
    }
    if (FILE* p = fopen("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "r")) {
      if (fscanf(p, "%ld", &period) != 1) period = 0;
      fclose(p);
    }
  }
  if (quota > 0 && period > 0) {
    const int limit = (int)((quota + period - 1) / period);
    if (limit >= 1 && limit < cpus) cpus = limit;
  }
  return cpus;
#else
  return 1;
#endif
}

// SB_WORKERS: a count, or unset / "auto" for one worker per CPU this process may use. Off Linux the
// default is one: SO_REUSEPORT does not spread connections there.
static int sb_worker_count(void) {
  const char* raw = getenv("SB_WORKERS");
  int count = sb_cpu_count();
  if (raw && *raw && strcmp(raw, "auto") != 0) {
    char* end = nullptr;
    const long value = strtol(raw, &end, 10);
    if (*end || value < 1 || value > 256) sb_log("SB_WORKERS=%s is not a count from 1 to 256; using %d", raw, count);
    else count = (int)value;
  }
  if (count > 256) count = 256;
  const char* ltx = getenv("SB_LTX_ENABLE");
  if (count > 1 && ltx && !strcmp(ltx, "1")) {
    sb_log("SB_LTX_ENABLE=1 holds the database exclusively: running one worker");
    count = 1;
  }
  return count;
}

struct SbWorkerSlot {
  pid_t pid = 0;
  double started = 0;
  double respawn_at = 0;
  int quick_exits = 0;
};

static pid_t sb_fork_worker(int index, int ready_write) {
  sigset_t blocked, saved;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGTERM);
  sigaddset(&blocked, SIGINT);
  sigaddset(&blocked, SIGCHLD);
  sigprocmask(SIG_BLOCK, &blocked, &saved);
  fflush(nullptr);
  const pid_t pid = fork();
  if (pid == 0) {
    close(sb_sigpipe[0]);
    close(sb_sigpipe[1]);
    sb_worker = index;
    sb_ready_fd = ready_write;
    const int code = sb_worker_main();
    fflush(nullptr);
    _exit(code);
  }
  sigprocmask(SIG_SETMASK, &saved, nullptr);
  return pid;
}

static int sb_supervise(int count) {
  if (pipe(sb_sigpipe) != 0) {
    sb_log("could not start: %s", strerror(errno));
    return 1;
  }
  for (int i = 0; i < 2; i++) {
    fcntl(sb_sigpipe[i], F_SETFL, fcntl(sb_sigpipe[i], F_GETFL) | O_NONBLOCK);
    fcntl(sb_sigpipe[i], F_SETFD, FD_CLOEXEC);
  }
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = sb_forward_signal;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  sigaction(SIGTERM, &action, nullptr);
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGCHLD, &action, nullptr);

  const long grace_ms = sb_env_long("SB_SHUTDOWN_GRACE_MS", 30000);
  std::vector<SbWorkerSlot> slots((size_t)count);
  std::vector<bool> wanted((size_t)count, true);
  std::vector<double> crashes;  // when workers died unexpectedly, recent ones
  bool stopping = false, probing = true, announced = false;
  int exit_code = 0, probe_fd = -1;
  double stop_deadline = 0;

  auto start_worker = [&](int index) {
    int ready_write = -1;
    if (index == 1 && probing) {
      if (probe_fd >= 0) close(probe_fd);
      int ends[2];
      if (pipe(ends) == 0) {
        fcntl(ends[0], F_SETFD, FD_CLOEXEC);
        probe_fd = ends[0];
        ready_write = ends[1];
      }
    }
    slots[(size_t)index].pid = sb_fork_worker(index, ready_write);
    slots[(size_t)index].started = sb_now_ms();
    if (ready_write >= 0) close(ready_write);
    if (slots[(size_t)index].pid < 0) {
      slots[(size_t)index].pid = 0;
      slots[(size_t)index].respawn_at = sb_now_ms() + 1000;
    }
  };
  auto signal_workers = [&](int sig) {
    for (auto& slot : slots) if (slot.pid > 0) kill(slot.pid, sig);
  };
  auto begin_stop = [&](int code) {
    if (stopping) return;
    stopping = true;
    exit_code = code;
    stop_deadline = sb_now_ms() + (double)grace_ms;
    signal_workers(SIGTERM);
  };
  auto announce = [&]() {
    if (announced) return;
    announced = true;
    int live = 0;
    for (size_t i = 0; i < slots.size(); i++) if (wanted[i]) live++;
    if (live > 1) sb_log("%d workers (SB_WORKERS=1 runs a single process; module-level state is per worker)", live);
  };

  start_worker(0);
  if (count > 1) start_worker(1);
  else { probing = false; announce(); }

  while (true) {
    const double now = sb_now_ms();
    if (!stopping) {
      for (int i = 0; i < count; i++) {
        SbWorkerSlot& slot = slots[(size_t)i];
        if (wanted[(size_t)i] && slot.pid == 0 && now >= slot.respawn_at && !(i > 1 && probing)) start_worker(i);
      }
    } else {
      bool alive = false;
      for (auto& slot : slots) if (slot.pid > 0) alive = true;
      if (!alive) break;
      if (now >= stop_deadline) {
        sb_log("workers did not finish in %ld ms; killing them", grace_ms);
        for (auto& slot : slots) if (slot.pid > 0) kill(slot.pid, SIGKILL);
        stop_deadline = now + 5000;
      }
    }

    double wait_ms = 1000;
    if (stopping) wait_ms = 100;
    else for (int i = 0; i < count; i++) {
      const SbWorkerSlot& slot = slots[(size_t)i];
      if (wanted[(size_t)i] && slot.pid == 0 && !(i > 1 && probing) && slot.respawn_at - now < wait_ms) wait_ms = slot.respawn_at - now > 0 ? slot.respawn_at - now : 0;
    }
    struct pollfd fds[2] = { { sb_sigpipe[0], POLLIN, 0 }, { probe_fd, POLLIN, 0 } };
    poll(fds, probe_fd >= 0 ? 2 : 1, (int)wait_ms + 1);

    char notes[64];
    for (ssize_t n; (n = read(sb_sigpipe[0], notes, sizeof(notes))) > 0;) {
      for (ssize_t i = 0; i < n; i++) {
        if (notes[i] == 'T') begin_stop(0);
        else continue;
      }
    }
    if (probe_fd >= 0 && (fds[1].revents & (POLLIN | POLLHUP))) {
      char ready = 0;
      const ssize_t n = read(probe_fd, &ready, 1);
      if (n == 1 && ready == 'G') {
        // The probe got through its start without the app asking to be one instance.
        close(probe_fd);
        probe_fd = -1;
        probing = false;
        announce();
      } else if (n <= 0) {
        close(probe_fd);
        probe_fd = -1;
      }
    }
    int status = 0;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
      int index = -1;
      for (int i = 0; i < count; i++) if (slots[(size_t)i].pid == pid) index = i;
      if (index < 0) continue;
      SbWorkerSlot& slot = slots[(size_t)index];
      slot.pid = 0;
      if (stopping) continue;
      if (index > 0 && WIFEXITED(status) && WEXITSTATUS(status) == SB_EXIT_SINGLE_INSTANCE) {
        // Queues consumed, or Durable Objects: these run in one process, as before.
        if (probe_fd >= 0) { close(probe_fd); probe_fd = -1; }
        probing = false;
        for (int i = 1; i < count; i++) wanted[(size_t)i] = false;
        for (int i = 1; i < count; i++) if (slots[(size_t)i].pid > 0) kill(slots[(size_t)i].pid, SIGTERM);
        sb_log("this app consumes queues or has Durable Objects, which run in one process: running 1 worker");
        announced = true;
        continue;
      }
      const double at = sb_now_ms();
      if (WIFSIGNALED(status)) sb_log("worker %d (pid %d) died on signal %d; restarting it", index, (int)pid, WTERMSIG(status));
      else sb_log("worker %d (pid %d) exited with status %d; restarting it", index, (int)pid, WEXITSTATUS(status));
      slot.quick_exits = at - slot.started < 10000 ? slot.quick_exits + 1 : 0;
      long delay = 100L << (slot.quick_exits < 5 ? slot.quick_exits : 5);
      if (delay > 3000) delay = 3000;
      slot.respawn_at = at + (double)delay;
      crashes.push_back(at);
      while (!crashes.empty() && at - crashes.front() > 30000) crashes.erase(crashes.begin());
      if (crashes.size() >= 8) {
        sb_log("workers are crash-looping (%d exits in 30 s); giving up", (int)crashes.size());
        begin_stop(1);
      }
    }
  }
  if (probe_fd >= 0) close(probe_fd);
  return exit_code;
}

int main(void) {
  const int count = sb_worker_count();
  if (count <= 1) return sb_worker_main();
  return sb_supervise(count);
}`;
