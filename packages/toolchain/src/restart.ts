/**
 * Standalone only: restart without dropping a connection.
 *
 * The kernel resets every connection waiting in a listening socket's accept queue when the last
 * descriptor for that socket closes. Replacing a binary used to close it (the old process died, or
 * closed its own SO_REUSEPORT listener while a new one came up), so about one request in a few
 * thousand was reset at each swap. The fix is never to let a restart be the last close: the listening
 * socket stays open in something that outlives the process (systemd, or the successor), and the old
 * process serves what it already accepted and leaves.
 *
 * Two ways in, one protocol (systemd's sd_listen_fds):
 *   - systemd socket activation: LISTEN_PID/LISTEN_FDS name the socket in fd 3, and the binary
 *     serves on it instead of binding PORT. `systemctl restart` stops the service and starts it
 *     again while the socket stays open, so connections wait in the queue.
 *   - SIGUSR2, for a box without systemd: the running binary starts the binary now on disk as its
 *     child with the listening socket as fd 3 and the same LISTEN_* variables, stops accepting, drains
 *     and exits. The child waits (SB_RESTART_GATE_FD) until its parent has exited before it initialises
 *     anything, because a standalone binary's SQLite files are locked exclusively and two copies
 *     cannot hold them at once.
 *
 * Draining (SIGTERM, SIGINT, or SIGUSR2): close this process's listener, add `Connection: close` to
 * every response so a keep-alive client stops reusing the connection, and exit once no socket is
 * busy (nothing unread, nothing unsent, no request waiting for its answer, nothing seen in the last
 * SB_DRAIN_QUIET_MS, default 200) or after SB_DRAIN_SECONDS (default 10). A second signal exits at once.
 *
 * It is all in the shim (compiler/uwebsockets.js), never render.js, so sproutd is untouched, and it
 * does nothing in a binary that does not link the embedded transport (the weak sb_standalone_app_name
 * is how it knows), so the broker's sprouts behave as before. uSockets binds through
 * bsd_create_listen_socket; the CLI builds a uSockets whose copy of it first asks
 * sb_inherited_listen_fd (below) for a socket (a weak reference, so an unpatched uSockets just never asks).
 */

/** Inserted before the response-header filter, so write_response_value can see the flag. */
export const RESTART_ANCHOR = "static bool is_forbidden_response_header(std::string_view key) {";
export const RESTART_MARKER = "// sproutboat: restart without dropping a connection";

export const RESTART_SOURCE = String.raw`${RESTART_MARKER}
extern "C" const char* sb_standalone_app_name(void) __attribute__((weak));
#ifdef __linux__
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <cstring>
#include <vector>
#include <string>
extern char** environ;
static int sb_rs_listen_fd = -1;
static bool sb_rs_fd_checked = false;
static int sb_rs_port = 0;
static us_listen_socket_t* sb_rs_listener = nullptr;
static us_timer_t* sb_rs_timer = nullptr;
static volatile sig_atomic_t sb_rs_term = 0, sb_rs_usr2 = 0;
static volatile sig_atomic_t sb_rs_closing = 0;
static volatile sig_atomic_t sb_rs_draining = 0;
static double sb_rs_deadline = 0;
static void sb_rs_tick(struct us_timer_t* timer);
static bool sb_rs_on(void) { return sb_standalone_app_name != nullptr; }
static double sb_rs_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}
static long sb_rs_env(const char* name, long fallback) {
  const char* raw = getenv(name);
  if (!raw || !*raw) return fallback;
  char* end = nullptr;
  long parsed = strtol(raw, &end, 10);
  return end && !*end && parsed >= 0 ? parsed : fallback;
}
static void sb_rs_log(const char* message) { std::fprintf(stderr, "sproutboat: %s\\n", message); }
static int sb_rs_local_port(int fd) {
  struct sockaddr_storage address;
  socklen_t length = sizeof(address);
  if (getsockname(fd, (struct sockaddr*)&address, &length)) return 0;
  if (address.ss_family == AF_INET) return ntohs(((struct sockaddr_in*)&address)->sin_port);
  if (address.ss_family == AF_INET6) return ntohs(((struct sockaddr_in6*)&address)->sin6_port);
  return 0;
}
// A successor started by SIGUSR2 waits here, before the runtime exists, until its parent has exited
// (the write end of the gate pipe closes with it) or the parent's drain limit and some grace is over.
static void __attribute__((constructor)) sb_rs_gate(void) {
  const char* raw = getenv("SB_RESTART_GATE_FD");
  if (!raw || !*raw || !sb_rs_on()) return;
  int fd = atoi(raw);
  unsetenv("SB_RESTART_GATE_FD");
  if (fd < 3) return;
  struct pollfd waiting = { fd, POLLIN, 0 };
  int result;
  do result = poll(&waiting, 1, (int)((sb_rs_env("SB_DRAIN_SECONDS", 10) + 20) * 1000));
  while (result < 0 && errno == EINTR);
  close(fd);
}
// uSockets asks this before it binds: fd 3 when LISTEN_PID names this process, as systemd and the
// SIGUSR2 successor both pass it, else -1 and it binds PORT as before.
extern "C" int sb_inherited_listen_fd(const char* host, int port) {
  (void)host;
  (void)port;
  if (sb_rs_on() && !sb_rs_fd_checked) {
    sb_rs_fd_checked = true;
    const char* pid = getenv("LISTEN_PID");
    const char* count = getenv("LISTEN_FDS");
    if (pid && count) {
      const bool mine = strtol(pid, nullptr, 10) == (long)getpid();
      const long given = strtol(count, nullptr, 10);
      unsetenv("LISTEN_PID");
      unsetenv("LISTEN_FDS");
      unsetenv("LISTEN_FDNAMES");
      int accepting = 0;
      socklen_t length = sizeof(accepting);
      if (mine && given >= 1 && !getsockopt(3, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &length) && accepting) {
        fcntl(3, F_SETFD, FD_CLOEXEC);
        fcntl(3, F_SETFL, fcntl(3, F_GETFL, 0) | O_NONBLOCK);
        sb_rs_log("serving on the listening socket it was given (fd 3)");
        return 3;
      }
    }
  }
  return -1;
}
// Is any socket still doing something? Read from the kernel, so it needs no bookkeeping in the server.
static bool sb_rs_busy(void) {
  const long quiet = sb_rs_env("SB_DRAIN_QUIET_MS", 200);
  DIR* dir = opendir("/proc/self/fd");
  if (!dir) return false;
  const int self = dirfd(dir);
  bool busy = false;
  while (!busy) {
    struct dirent* entry = readdir(dir);
    if (!entry) break;
    const int fd = atoi(entry->d_name);
    if (fd < 3 || fd == self) continue;
    int domain = 0, type = 0, accepting = 0;
    socklen_t length = sizeof(int);
    if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &length) || (domain != AF_INET && domain != AF_INET6)) continue;
    length = sizeof(int);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_STREAM) continue;
    length = sizeof(int);
    if (!getsockopt(fd, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &length) && accepting) continue;
    struct tcp_info info;
    memset(&info, 0, sizeof(info));
    socklen_t info_length = sizeof(info);
    if (getsockopt(fd, IPPROTO_TCP, TCP_INFO, &info, &info_length)) continue;
    if (info.tcpi_state == TCP_SYN_SENT || info.tcpi_state == TCP_SYN_RECV) { busy = true; break; }
    int unread = 0, unsent = 0;
    ioctl(fd, FIONREAD, &unread);
    ioctl(fd, TIOCOUTQ, &unsent);
    if (unread > 0 || unsent > 0) { busy = true; break; }
    const long received = (long)info.tcpi_last_data_recv, sent = (long)info.tcpi_last_data_sent;
    // The last thing on a connection we serve is our answer; on one we opened it is our request.
    if (sb_rs_local_port(fd) == sb_rs_port ? received + 20 < sent : sent + 20 < received) busy = true;
    else if (received < quiet || sent < quiet) busy = true;
  }
  closedir(dir);
  return busy;
}
// Start the binary now on disk as a child that inherits the listening socket. True once it has exec'd.
static bool sb_rs_spawn_successor(void) {
  if (sb_rs_listen_fd < 0) { sb_rs_log("restart: no listening socket to hand over"); return false; }
  char found[4096];
  const char* exe = getenv("SB_EXEC_PATH");
  if (!exe || !*exe) {
    const ssize_t n = readlink("/proc/self/exe", found, sizeof(found) - 1);
    if (n <= 0) { sb_rs_log("restart: cannot find its own executable"); return false; }
    found[n] = 0;
    static const char tail[] = " (deleted)";
    const size_t tail_length = sizeof(tail) - 1;
    if ((size_t)n > tail_length && !strcmp(found + n - tail_length, tail)) found[n - tail_length] = 0;
    exe = found;
  }
  if (access(exe, X_OK)) { std::fprintf(stderr, "sproutboat: restart: cannot execute %s\\n", exe); return false; }
  int gate[2], status[2];
  if (pipe2(gate, O_CLOEXEC)) return false;
  if (pipe2(status, O_CLOEXEC)) { close(gate[0]); close(gate[1]); return false; }
  std::vector<std::string> keep;
  for (char** e = environ; *e; ++e) {
    if (!strncmp(*e, "LISTEN_PID=", 11) || !strncmp(*e, "LISTEN_FDS=", 11) || !strncmp(*e, "LISTEN_FDNAMES=", 15) ||
        !strncmp(*e, "SB_RESTART_GATE_FD=", 19)) continue;
    keep.push_back(*e);
  }
  keep.push_back("LISTEN_FDS=1");
  keep.push_back("SB_RESTART_GATE_FD=4");
  keep.push_back("LISTEN_PID=00000000000000000000");
  std::vector<char*> envp;
  for (auto& entry : keep) envp.push_back(const_cast<char*>(entry.c_str()));
  envp.push_back(nullptr);
  char* const pid_digits = envp[envp.size() - 2] + 11;
  char* argv[] = { const_cast<char*>(exe), nullptr };
  const pid_t child = fork();
  if (child < 0) { close(gate[0]); close(gate[1]); close(status[0]); close(status[1]); return false; }
  if (child == 0) {
    long value = (long)getpid();
    for (int at = 19; at >= 0; at--) { pid_digits[at] = (char)('0' + value % 10); value /= 10; }
    const int staying = fcntl(status[1], F_DUPFD_CLOEXEC, 10);
    const int listener = fcntl(sb_rs_listen_fd, F_DUPFD, 10);
    const int held = fcntl(gate[0], F_DUPFD, 10);
    if (staying < 0 || listener < 0 || held < 0 || dup2(listener, 3) < 0 || dup2(held, 4) < 0 || dup3(staying, 5, O_CLOEXEC) < 0) _exit(126);
    #ifdef SYS_close_range
    if (syscall(SYS_close_range, 6, ~0U, 0))
#endif
    { for (int fd = 6; fd < 4096; fd++) close(fd); }
    execve(exe, argv, envp.data());
    const int failure = errno;
    const ssize_t reported = write(5, &failure, sizeof(failure));
    (void)reported;
    _exit(127);
  }
  close(gate[0]);
  close(status[1]);
  int failure = 0;
  ssize_t got;
  do got = read(status[0], &failure, sizeof(failure));
  while (got < 0 && errno == EINTR);
  close(status[0]);
  if (got > 0) {
    waitpid(child, nullptr, 0);
    close(gate[1]);
    std::fprintf(stderr, "sproutboat: restart: cannot execute %s: %s\\n", exe, strerror(failure));
    return false;
  }
  // gate[1] stays open for as long as this process lives: its closing is the successor's go signal.
  std::fprintf(stderr, "sproutboat: restart: started %s as pid %d\\n", exe, (int)child);
  return true;
}
static void sb_rs_signal(int signal_number) {
  if (signal_number == SIGUSR2) sb_rs_usr2 = 1;
  else {
    if (sb_rs_term) _exit(0);
    sb_rs_term = 1;
  }
  // Once draining, the repeating tick is already running; re-arming it here would end the repeat.
  if (sb_rs_timer && !sb_rs_draining) us_timer_set(sb_rs_timer, sb_rs_tick, 1, 0);
}
static void sb_rs_tick(struct us_timer_t* timer) {
  if (!sb_rs_draining) {
    bool go = false;
    if (sb_rs_term) go = true;
    else if (sb_rs_usr2) { sb_rs_usr2 = 0; go = sb_rs_spawn_successor(); }
    if (!go) {
      us_timer_set(timer, sb_rs_tick, 0, 0);
      if (sb_rs_usr2 || sb_rs_term) us_timer_set(timer, sb_rs_tick, 1, 0);
      return;
    }
    sb_rs_draining = 1;
    sb_rs_closing = 1;
    if (sb_rs_listener) { us_listen_socket_close(0, sb_rs_listener); sb_rs_listener = nullptr; }
    sb_rs_deadline = sb_rs_now() + (double)sb_rs_env("SB_DRAIN_SECONDS", 10) * 1000.0;
    sb_rs_log("draining: no longer accepting");
    us_timer_set(timer, sb_rs_tick, 20, 20);
    return;
  }
  if (sb_rs_now() >= sb_rs_deadline) { sb_rs_log("drain limit reached, exiting"); _exit(0); }
  if (!sb_rs_busy()) { sb_rs_log("drained, exiting"); _exit(0); }
}
// Called from the listen callback, inside the event loop, once the socket is accepting.
static void sb_rs_listening(us_listen_socket_t* token) {
  if (!sb_rs_on() || !token) return;
  sb_rs_listener = token;
  sb_rs_listen_fd = us_poll_fd((struct us_poll_t*)token);
  if (sb_rs_listen_fd >= 0) sb_rs_port = sb_rs_local_port(sb_rs_listen_fd);
  sb_rs_timer = us_create_timer((struct us_loop_t*)uWS::Loop::get(), 1, 0);
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = sb_rs_signal;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  sigaction(SIGTERM, &action, nullptr);
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGUSR2, &action, nullptr);
}
#else
extern "C" int sb_inherited_listen_fd(const char*, int) { return -1; }
static volatile int sb_rs_closing = 0;
static void sb_rs_listening(us_listen_socket_t*) {}
#endif
`;

/** Added to Connection: close while draining, inside write_response_value's cork. */
export const RESTART_HEADER_ANCHOR =
  "      if (stream_id) sb_stream_attach(stream_id, res); // sproutboat B19: the prelude pumps the body\n";
export const RESTART_HEADER_INJECT =
  '      if (sb_rs_closing) res->writeHeader("Connection", "close"); // sproutboat: draining\n';

/** The listen callback tells the restart code its socket is up. */
export const RESTART_LISTEN_ANCHOR = "    if (token) {\n      listened = true;\n";
export const RESTART_LISTEN_INJECT = "      sb_rs_listening(token);\n";
