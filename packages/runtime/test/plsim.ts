// A power-loss simulator for the capture's write path (design 029 stage S1b), after the ALICE/CrashMonkey line of work:
// record the syscalls of a real run (strace), model what a power cut after any of them leaves on disk, rebuild that disk
// state in a scratch directory and let the real code recover from it. Linux only (strace, no dm-flakey needed).
//
// The model is the pessimistic POSIX one, with the one ext4/xfs behaviour SQLite itself relies on:
//   - a file's bytes are durable up to its last fsync/fdatasync; writes after it are volatile;
//   - a namespace change (create, link, unlink, rename, mkdir) is volatile until the DIRECTORY it is in is fsynced; the
//     exception is that fsync of a file also makes the file's own creation (its directory entry as of creation)
//     durable (without it SQLite's own WAL could vanish after its first fsync, which no filesystem we run on does);
//   - "strict" mode (A): the surviving state is exactly the durable one: every volatile byte and entry is lost;
//   - "torn" mode (B, seeded): the worst the filesystem may do on top: a random subset of the volatile writes of each file
//     survives (in any order, so a later write may land while an earlier one is lost) and a random prefix of the volatile
//     namespace changes of each directory survives (a journal commits a prefix, so renames keep their order);
//   - memory-mapped files (the WAL index, -shm) are never durable and are removed from the image: SQLite rebuilds it.
// It is stricter than any one real filesystem; code that survives it needs no assumption about writeback order.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type Op =
  | { k: number; t: "write"; path: string; off: number; data: Uint8Array }
  | { k: number; t: "trunc"; path: string; len: number }
  | { k: number; t: "fsync"; path: string }
  | { k: number; t: "dirsync"; path: string }
  | { k: number; t: "ns"; kind: "create" | "link" | "unlink" | "rename" | "mkdir" | "rmdir"; a: string; b?: string }
  | { k: number; t: "ack"; text: string };

function unhex(s: string): Uint8Array {
  // the body of a "..." string printed by strace -xx: \xHH for every byte
  const out: number[] = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === "\\" && s[i + 1] === "x") {
      out.push(parseInt(s.slice(i + 2, i + 4), 16));
      i += 4;
    } else if (s[i] === "\\") {
      throw new Error("unexpected escape in " + s.slice(i, i + 8));
    } else {
      out.push(s.charCodeAt(i));
      i++;
    }
  }
  return Uint8Array.from(out);
}
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0,
    quoted = false,
    cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      cur += c;
    } else if (c === "[" || c === "{" || c === "(") {
      depth++;
      cur += c;
    } else if (c === "]" || c === "}" || c === ")") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const str = (a: string) => {
  const m = /^"(.*)"(\.\.\.)?$/s.exec(a);
  if (!m) throw new Error("not a string: " + a.slice(0, 50));
  if (m[2]) throw new Error("strace truncated a string: raise -s");
  return m[1];
};
const text = (a: string) => new TextDecoder().decode(unhex(str(a)));

// Turn the text of `strace -f -qq -xx -s N -e trace=...` into the ordered operations on files under `root`, with the
// acknowledgements (writes to descriptor 1) in the same order. Directories are named without a trailing slash.
export function parseTrace(trace: string, root: string): Op[] {
  const ops: Op[] = [];
  const fds = new Map<number, { path: string; dir: boolean; off: number; append: boolean }>();
  const inRoot = (p: string) => p === root || p.startsWith(root + "/");
  let k = 0;
  for (const raw of trace.split("\n")) {
    if (!raw) continue;
    const m = /^(?:\[pid\s+\d+\]\s+|\d+\s+)?(\w+)\((.*)\)\s+=\s+(-?\d+|\?)(?:\s.*)?$/s.exec(raw);
    if (!m) continue;
    const [, name, argText, retText] = m;
    const ret = Number(retText);
    if (Number.isNaN(ret) || ret < 0) continue; // a failed call changed nothing
    const a = splitArgs(argText);
    const absolute = (p: string) => (p.startsWith("/") ? p : "");
    switch (name) {
      case "open":
      case "openat":
      case "creat": {
        const pathArg = name === "openat" ? a[1] : a[0];
        const flagsArg = name === "openat" ? a[2] : name === "creat" ? "O_CREAT|O_WRONLY|O_TRUNC" : a[1];
        const path = text(pathArg);
        if (!inRoot(absolute(path))) {
          fds.set(ret, { path: "", dir: false, off: 0, append: false });
          break;
        }
        const dir = flagsArg.includes("O_DIRECTORY");
        const append = flagsArg.includes("O_APPEND");
        if (!dir && flagsArg.includes("O_CREAT")) ops.push({ k: ++k, t: "ns", kind: "create", a: path });
        if (!dir && flagsArg.includes("O_TRUNC")) ops.push({ k: ++k, t: "trunc", path, len: 0 });
        fds.set(ret, { path, dir, off: 0, append });
        break;
      }
      case "close":
        fds.delete(Number(a[0]));
        break;
      case "lseek": {
        const f = fds.get(Number(a[0]));
        if (f) f.off = ret;
        break;
      }
      case "write":
      case "pwrite64": {
        const fd = Number(a[0]);
        const data = unhex(str(a[1]));
        if (fd === 1 && name === "write") {
          ops.push({ k: ++k, t: "ack", text: new TextDecoder().decode(data) });
          break;
        }
        const f = fds.get(fd);
        if (!f || !f.path || f.dir) break;
        const written = data.subarray(0, ret);
        const off = name === "pwrite64" ? Number(a[3]) : f.append ? -1 : f.off;
        ops.push({ k: ++k, t: "write", path: f.path, off, data: written });
        if (name === "write" && !f.append) f.off += ret;
        break;
      }
      case "ftruncate": {
        const f = fds.get(Number(a[0]));
        if (f?.path) ops.push({ k: ++k, t: "trunc", path: f.path, len: Number(a[1]) });
        break;
      }
      case "truncate": {
        const p = text(a[0]);
        if (inRoot(p)) ops.push({ k: ++k, t: "trunc", path: p, len: Number(a[1]) });
        break;
      }
      case "fsync":
      case "fdatasync": {
        const f = fds.get(Number(a[0]));
        if (f?.path) ops.push({ k: ++k, t: f.dir ? "dirsync" : "fsync", path: f.path });
        break;
      }
      case "rename":
      case "renameat":
      case "renameat2": {
        const from = name === "rename" ? text(a[0]) : text(a[1]);
        const to = name === "rename" ? text(a[1]) : text(a[3]);
        if (inRoot(from) || inRoot(to)) ops.push({ k: ++k, t: "ns", kind: "rename", a: from, b: to });
        break;
      }
      case "link":
      case "linkat": {
        const from = name === "link" ? text(a[0]) : text(a[1]);
        const to = name === "link" ? text(a[1]) : text(a[3]);
        if (inRoot(to)) ops.push({ k: ++k, t: "ns", kind: "link", a: from, b: to });
        break;
      }
      case "unlink":
      case "unlinkat": {
        const p = text(name === "unlink" ? a[0] : a[1]);
        const isDir = name === "unlinkat" && a[2]?.includes("AT_REMOVEDIR");
        if (inRoot(p)) ops.push({ k: ++k, t: "ns", kind: isDir ? "rmdir" : "unlink", a: p });
        break;
      }
      case "rmdir": {
        const p = text(a[0]);
        if (inRoot(p)) ops.push({ k: ++k, t: "ns", kind: "rmdir", a: p });
        break;
      }
      case "mkdir":
      case "mkdirat": {
        const p = text(name === "mkdir" ? a[0] : a[1]);
        if (inRoot(p)) ops.push({ k: ++k, t: "ns", kind: "mkdir", a: p });
        break;
      }
    }
  }
  return ops;
}

type Node = { id: number; dir: boolean };
type Pending = { kind: "set"; name: string; node: Node } | { kind: "del"; name: string };
const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// The two views of the disk as operations are applied: what a reader sees now (volatile) and what a power cut keeps
// (durable), plus what is in between (pending), kept so the torn mode can pick from it.
export class Disk {
  private nextId = 1;
  // namespace: directory path -> name -> node
  vol = new Map<string, Map<string, Node>>();
  dur = new Map<string, Map<string, Node>>();
  pendingNs = new Map<string, Pending[]>();
  // contents by node id
  volData = new Map<number, Uint8Array>();
  durData = new Map<number, Uint8Array>();
  pendingData = new Map<number, ({ off: number; data: Uint8Array } | { len: number })[]>();
  // creation not yet covered by an fsync of the file: id -> (dir, name) it was created under
  createdAs = new Map<number, { dir: string; name: string }>();
  private root: string;
  constructor(root: string) {
    this.root = root;
    this.vol.set(root, new Map());
    this.dur.set(root, new Map());
  }
  // The files that exist before the traced process starts are durable, as they would be after a sync. `src` is a copy of
  // the tree as it was; the names are registered under the traced run's root.
  loadInitial(src: string, dst = this.root) {
    for (const name of readdirSync(src)) {
      const from = join(src, name),
        to = join(dst, name);
      if (statSync(from).isDirectory()) {
        this.mk(true, dst, name, true);
        this.vol.set(to, new Map());
        this.dur.set(to, new Map());
        this.loadInitial(from, to);
      } else {
        const node = this.mk(false, dst, name, true);
        const data = new Uint8Array(readFileSync(from));
        this.volData.set(node.id, data);
        this.durData.set(node.id, data);
      }
    }
  }
  private mk(dir: boolean, parent: string, name: string, durable: boolean): Node {
    const node = { id: this.nextId++, dir };
    this.vol.get(parent)!.set(name, node);
    if (durable) this.dur.get(parent)!.set(name, node);
    return node;
  }
  private lookup(path: string): Node | undefined {
    return this.vol.get(dirname(path))?.get(basename(path));
  }
  private ns(dir: string, p: Pending) {
    const list = this.pendingNs.get(dir) ?? [];
    list.push(p);
    this.pendingNs.set(dir, list);
  }
  apply(op: Op) {
    switch (op.t) {
      case "ack":
        return;
      case "ns": {
        if (op.kind === "create") {
          if (this.lookup(op.a)) return; // opening an existing file
          const dir = dirname(op.a);
          if (!this.vol.has(dir)) return;
          const node = this.mk(false, dir, basename(op.a), false);
          this.volData.set(node.id, new Uint8Array(0));
          this.durData.set(node.id, new Uint8Array(0));
          this.createdAs.set(node.id, { dir, name: basename(op.a) });
          this.ns(dir, { kind: "set", name: basename(op.a), node });
        } else if (op.kind === "mkdir") {
          const dir = dirname(op.a);
          if (this.lookup(op.a) || !this.vol.has(dir)) return;
          const node = this.mk(true, dir, basename(op.a), false);
          this.vol.set(op.a, new Map());
          this.dur.set(op.a, new Map());
          this.ns(dir, { kind: "set", name: basename(op.a), node });
        } else if (op.kind === "link") {
          const node = this.lookup(op.a);
          if (!node) return;
          const dir = dirname(op.b!);
          this.vol.get(dir)!.set(basename(op.b!), node);
          this.ns(dir, { kind: "set", name: basename(op.b!), node });
        } else if (op.kind === "unlink" || op.kind === "rmdir") {
          const dir = dirname(op.a);
          this.vol.get(dir)?.delete(basename(op.a));
          this.ns(dir, { kind: "del", name: basename(op.a) });
        } else if (op.kind === "rename") {
          const node = this.lookup(op.a);
          if (!node) return;
          const from = dirname(op.a),
            to = dirname(op.b!);
          this.vol.get(from)!.delete(basename(op.a));
          this.vol.get(to)!.set(basename(op.b!), node);
          this.ns(from, { kind: "del", name: basename(op.a) });
          this.ns(to, { kind: "set", name: basename(op.b!), node });
          if (node.dir && this.vol.has(op.a)) {
            // a moved directory keeps its contents under the new path (not used by the capture; kept honest)
            this.vol.set(op.b!, this.vol.get(op.a)!);
            this.vol.delete(op.a);
            this.dur.set(op.b!, this.dur.get(op.a) ?? new Map());
          }
        }
        return;
      }
      case "write": {
        const node = this.lookup(op.path);
        if (!node) return;
        const cur = this.volData.get(node.id) ?? new Uint8Array(0);
        const off = op.off < 0 ? cur.length : op.off;
        const next = new Uint8Array(Math.max(cur.length, off + op.data.length));
        next.set(cur);
        next.set(op.data, off);
        this.volData.set(node.id, next);
        const list = this.pendingData.get(node.id) ?? [];
        list.push({ off, data: op.data });
        this.pendingData.set(node.id, list);
        return;
      }
      case "trunc": {
        const node = this.lookup(op.path);
        if (!node) return;
        const cur = this.volData.get(node.id) ?? new Uint8Array(0);
        const next = new Uint8Array(op.len);
        next.set(cur.subarray(0, Math.min(cur.length, op.len)));
        this.volData.set(node.id, next);
        const list = this.pendingData.get(node.id) ?? [];
        list.push({ len: op.len });
        this.pendingData.set(node.id, list);
        return;
      }
      case "fsync": {
        const node = this.lookup(op.path);
        if (!node) return;
        this.durData.set(node.id, this.volData.get(node.id) ?? new Uint8Array(0));
        this.pendingData.delete(node.id);
        const made = this.createdAs.get(node.id);
        if (made) {
          // the file's own creation becomes durable with its first fsync
          this.dur.get(made.dir)?.set(made.name, node);
          const list = this.pendingNs.get(made.dir);
          if (list) {
            const i = list.findIndex((p) => p.kind === "set" && p.name === made.name && p.node === node);
            if (i >= 0) list.splice(i, 1);
          }
          this.createdAs.delete(node.id);
        }
        return;
      }
      case "dirsync": {
        const list = this.pendingNs.get(op.path) ?? [];
        const target = this.dur.get(op.path) ?? new Map();
        for (const p of list) {
          if (p.kind === "set") target.set(p.name, p.node);
          else target.delete(p.name);
        }
        this.dur.set(op.path, target);
        this.pendingNs.delete(op.path);
        return;
      }
    }
  }
  // Write the state a power cut right now leaves, into `out`. mode "strict": the durable state. mode "torn": the durable
  // state plus a seeded random choice of what was volatile (see the header).
  materialize(out: string, mode: "strict" | "torn", seed = 1) {
    let s = seed >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    rmSync(out, { recursive: true, force: true });
    // the namespace the cut leaves: the durable one, plus (torn) a random prefix of each directory's pending changes
    const ns = new Map<string, Map<string, Node>>();
    for (const [dir, m] of this.dur) ns.set(dir, new Map(m));
    if (mode === "torn") {
      for (const [dir, list] of this.pendingNs) {
        const keep = Math.floor(rnd() * (list.length + 1));
        const target = ns.get(dir) ?? new Map();
        for (const p of list.slice(0, keep)) {
          if (p.kind === "set") target.set(p.name, p.node);
          else target.delete(p.name);
        }
        ns.set(dir, target);
        for (const p of list.slice(0, keep))
          if (p.kind === "set" && p.node.dir && !ns.has(join(dir, p.name))) ns.set(join(dir, p.name), new Map());
      }
    }
    const content = (node: Node): Uint8Array => {
      let data = this.durData.get(node.id) ?? new Uint8Array(0);
      if (mode === "torn") {
        const pending = this.pendingData.get(node.id) ?? [];
        for (const w of pending) {
          if (rnd() < 0.5) continue; // this write did not reach the disk
          if ("len" in w) {
            const next = new Uint8Array(w.len);
            next.set(data.subarray(0, Math.min(data.length, w.len)));
            data = next;
          } else {
            const next = new Uint8Array(Math.max(data.length, w.off + w.data.length));
            next.set(data);
            next.set(w.data, w.off);
            data = next;
          }
        }
      }
      return data;
    };
    // the traced run's root becomes `out`: paths inside were absolute under root, the image is the same tree under out
    const dest = (p: string) => out + p.slice(this.root.length);
    const walk = (dir: string) => {
      mkdirSync(dest(dir), { recursive: true });
      const entries = ns.get(dir);
      if (!entries) return;
      for (const [name, node] of entries) {
        const full = join(dir, name);
        if (node.dir) walk(full);
        else if (!name.endsWith("-shm")) writeFileSync(dest(full), content(node));
      }
    };
    walk(this.root);
  }
}
