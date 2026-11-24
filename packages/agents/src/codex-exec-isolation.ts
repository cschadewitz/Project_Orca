/**
 * The executor behind ORCA's gate, in namespaces ORCA makes (#1026).
 *
 * The gate (`codex-exec-gate.ts`) decides each request Codex's executor is sent. Two things it
 * cannot do by deciding: end everything the executor started, and keep ORCA's own directories
 * out of the executor's reach under a name the decision never saw. This backend does both by
 * where it runs the executor: through the system's bubblewrap, in a user, pid and mount
 * namespace of its own. The user, the network and the rest of the file system stay as they
 * are.
 *
 * **The executor's processes are ORCA's to end.** The first process of the pid namespace is a
 * small program of ORCA's (the holder), and the executor is its child. Everything the
 * executor starts, and every descendant, is in that namespace and cannot leave it. When the
 * holder ends, the kernel kills the rest, and it does not let the holder be reaped until
 * they are gone. The holder ends when the executor exits and when ORCA's channel to it
 * closes, so ORCA ending ends them too.
 *
 * **ORCA says the tree ended only when the kernel showed it.** The pid bubblewrap names is a
 * claim. ORCA opens the kernel's directory of the process that pid means, verifies through
 * that descriptor that the process is the first of namespaces that are not ORCA's, and from
 * then on knows it by the descriptor, which never comes to mean another process. `nothingLeft`
 * is said when the kernel answers through it that the process was reaped, or lists it
 * finished with no thread left. A reading that fails or cannot be understood is not an
 * ending, and neither is an exit ORCA heard before it had verified a first process: ORCA
 * then says it did not see the tree end. Bubblewrap's exit status is not what is believed.
 *
 * **A directory is held where the executor can reach it.** ORCA's own descriptors cannot be
 * opened from another user namespace, which is also what keeps a command from reading them
 * or tracing ORCA. So the holder opens the directory ORCA decided, ORCA compares the two
 * from outside (`/proc/<holder>/fd/<n>` against its own descriptor: one device, one inode),
 * and the executor is given `/proc/1/fd/<n>`. Process 1 of a pid namespace is never another
 * process, so that name means the holder's descriptor or nothing, and it ends with the
 * namespace. Nothing stays held in ORCA.
 *
 * **ORCA's directories are masked in the executor's mount namespace.** A hidden directory is
 * covered by an empty read-only one; a read-only directory is bound read-only, with the
 * directories listed as writable bound over it again. A mask sits on the directory itself,
 * not on its name: it follows a rename of any parent, a link to it leads to the mask, and
 * nothing inside the namespace can lift it (processes there hold no capabilities over it,
 * and a user namespace made inside gets a locked copy). Only directories are masked. A mask
 * on a single file lasts until the file is replaced from outside, which is how ORCA writes
 * its own files, so a protected file in a directory the agent can write stays the gate's to
 * refuse by path.
 *
 * **Nothing is sent to the executor until ORCA has seen all of that for itself.** From
 * outside: the holder is process 1 of a pid, mount and user namespace that are not ORCA's;
 * its mount table shows each mask, and each hidden directory is empty through its root. From
 * inside, by the holder: each mask refuses a write, each hidden directory lists nothing.
 * Then the executor is started, and seen to be the holder's child in the same namespaces
 * without the holder's channel. A check that fails ends the namespace, and the gate's
 * connection with it. So does the deadline for all of it: when it passes, ORCA closes its
 * channel and signals bubblewrap then, and waits for nothing bubblewrap might still do or say.
 *
 * Limits, said plainly. A command ORCA allowed runs as the user and can ask a service outside
 * the namespace to act for it (a user service manager, a container daemon's socket, a login
 * to the same machine): what that service starts is not in the namespace and does not see
 * the masks. Where the system lets one process trace an unrelated process of the same user
 * (`ptrace_scope` 0), such a command can also alter the executor and the holder beside it.
 * A file that had a second name before the session is reached by that name whatever is
 * masked; the gate refuses a file request for any file with more than one. A directory that
 * does not exist cannot be masked. The holder ends the namespace but does not tidy it: a
 * process that outlives its parent stays listed, finished, until the namespace ends. Linux
 * only, with unprivileged user namespaces and a bubblewrap the system installed; anything
 * else is refused before an executor is started.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, sep } from "node:path";
import type { Readable } from "node:stream";
import {
  codexExecServerEnv,
  codexExecServerOver,
  type CodexExecBackend,
  type CodexExecGateHeldDirectory,
  type CodexExecServerSpawn,
} from "./codex-exec-gate.js";
import { physicalPathOf, type ProtectedPaths } from "./permissions.js";

/** Where a system installs bubblewrap. Nothing is looked up on `PATH`. */
export const CODEX_EXEC_BUBBLEWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap"] as const;

/** How long the namespace has to be made, shown and given its executor. */
const SETUP_WAIT_MS = 10_000;
/** How long ORCA waits, after it refused a namespace, for what bubblewrap had to say about it. */
const DIAGNOSTICS_WAIT_MS = 500;
/** `O_CLOEXEC`, as `/proc/<pid>/fdinfo/<n>` shows it among a descriptor's flags. */
const CLOSE_ON_EXEC = 0o2000000;
/** How long the holder has to answer one request. */
const HOLDER_WAIT_MS = 2000;
/** Bytes of the namespace's error stream kept to explain a failure. */
const DIAGNOSTIC_BYTES = 2048;
/** The longest line the holder may write. */
const HOLDER_LINE_BYTES = 64 * 1024;

/** The directories masked in the executor's mount namespace. Each is a real directory's own path. */
export interface CodexExecMasks {
  /** Covered by an empty read-only directory. */
  hidden: readonly string[];
  /** Bound read-only. */
  readOnly: readonly string[];
  /** Inside a read-only directory, and bound writable again. */
  writable: readonly string[];
}

/** Why an executor could not be isolated. Nothing was started, or what was started was ended. */
export class CodexExecIsolationError extends Error {}

/**
 * The masks for ORCA's protected paths, and what cannot be masked.
 *
 * A `noAccess` directory is hidden. A `readOnly` directory is bound read-only with the agent
 * areas inside it writable. `readOnlyDirectories` are more directories to bind read-only: a
 * config directory, when the agent's own directories are not inside it. Every path is taken
 * as the file system resolves it. A path that is not there, or is not a directory, cannot be
 * masked and is listed in `unmasked`: it stays the gate's to refuse by path, and whoever
 * wires this in decides whether that is enough.
 */
export function codexExecMasks(
  protectedPaths: ProtectedPaths,
  more: { readOnlyDirectories?: readonly string[] | undefined } = {},
): CodexExecMasks & { unmasked: string[] } {
  const unmasked: string[] = [];
  const directories = (paths: readonly string[], report: boolean): string[] => {
    const found = new Set<string>();
    for (const path of paths) {
      const real = physicalPathOf(path);
      if (real !== undefined && isDirectory(real)) found.add(real);
      else if (report) unmasked.push(path);
    }
    return [...found];
  };
  const hidden = directories(protectedPaths.noAccess, true);
  // What is inside a hidden directory is hidden with it.
  const shown = (path: string): boolean => !hidden.some((root) => path === root || inside(path, root));
  const readOnly = directories([...protectedPaths.readOnly, ...(more.readOnlyDirectories ?? [])], true).filter(shown);
  const writable = directories(protectedPaths.agentAreas ?? [], false).filter(
    (area) => shown(area) && !readOnly.includes(area) && readOnly.some((root) => inside(area, root)),
  );
  return { hidden, readOnly, writable, unmasked };
}

/** Whether `path` is a directory itself, not a link to one. False when that cannot be told. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

const inside = (path: string, root: string): boolean =>
  path !== root && path.startsWith(root === sep ? sep : `${root}${sep}`);

/** One mask, as bubblewrap is told to make it. */
function maskArguments(masks: CodexExecMasks): string[] {
  const seen = new Map<string, string>();
  const real = (path: string, what: string): string => {
    if (!isAbsolute(path) || path.includes("\0") || path === sep || !isDirectory(path) || realpathSync(path) !== path)
      throw new CodexExecIsolationError(`a ${what} path is not a directory's own path: ${path}`);
    if (seen.has(path)) throw new CodexExecIsolationError(`a path is masked twice: ${path}`);
    seen.set(path, what);
    return path;
  };
  const steps: { path: string; args: string[] }[] = [];
  for (const path of [...masks.readOnly, ...masks.writable])
    if (masks.hidden.some((root) => inside(path, root)))
      throw new CodexExecIsolationError(`a path inside a hidden directory cannot be shown: ${path}`);
  for (const path of masks.readOnly) steps.push({ path, args: ["--ro-bind", real(path, "read-only"), path] });
  for (const path of masks.writable) {
    real(path, "writable");
    if (!masks.readOnly.some((root) => inside(path, root)))
      throw new CodexExecIsolationError(`a writable path is not inside a read-only one: ${path}`);
    steps.push({ path, args: ["--bind", path, path] });
  }
  for (const path of masks.hidden) steps.push({ path, args: ["--tmpfs", real(path, "hidden"), "--remount-ro", path] });
  // A directory is masked before anything inside it, so that the mask inside lands on top.
  steps.sort((a, b) => a.path.length - b.path.length);
  return steps.flatMap((step) => step.args);
}

/** How to start the executor in its own namespaces. */
export interface CodexExecIsolatedSpawn extends CodexExecServerSpawn {
  /** What is masked in the executor's mount namespace. */
  masks: CodexExecMasks;
  /** The program that runs the holder: this Node, unless ORCA runs under another runtime. */
  runtime?: string | undefined;
  /** What the runtime needs in its environment to run as Node. The executor is given none of it. */
  runtimeEnv?: Readonly<Record<string, string>> | undefined;
  /** The bubblewrap to use. The default is the one the system installed. */
  bubblewrap?: string | undefined;
  /** How long the namespace has to be made, shown and given its executor. */
  setupWaitMs?: number | undefined;
}

/** What ORCA saw of an isolated executor before it was sent anything. */
export interface CodexExecIsolationProof {
  /** The holder: process 1 of the executor's pid namespace, by its pid here. */
  holder: number;
  /** The executor, by its pid here. */
  executor: number;
  /** The namespaces both are in, as the kernel names them. None is ORCA's. */
  namespaces: { pid: string; mnt: string; user: string };
  masks: CodexExecMasks;
  /** The system's `ptrace_scope`, when it has one. */
  ptraceScope?: number | undefined;
}

/**
 * The bubblewrap the system installed: a file owned by root that only root can change and
 * that does not run as root. Undefined when there is none.
 */
export function systemBubblewrap(candidates: readonly string[] = CODEX_EXEC_BUBBLEWRAP_PATHS): string | undefined {
  return candidates.find((path) => {
    try {
      const real = realpathSync(path);
      const file = statSync(real);
      return file.isFile() && file.uid === 0 && (file.mode & 0o6022) === 0;
    } catch {
      return false;
    }
  });
}

/**
 * The holder: process 1 of the executor's pid namespace. It starts the executor with its own
 * input and output, holds directories ORCA names, and ends when the executor exits or ORCA's
 * channel closes. Run with `-e`, so that it is this text and no file that is run.
 */
const HOLDER = String.raw`"use strict";
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const control = new net.Socket({ fd: 3, readable: true, writable: true });
const leave = (code) => { try { control.destroy(); } catch {} process.exit(code); };
const say = (message, then) => control.write(JSON.stringify(message) + "\n", then);
const held = new Set();
let child;
const refusesWrite = (path) => {
  try { fs.accessSync(path, fs.constants.W_OK); return false; } catch (error) { return error.code === "EROFS"; }
};
const act = (m) => {
  if (m.op === "hold") {
    try {
      const fd = fs.openSync(m.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      held.add(fd);
      say({ id: m.id, fd });
    } catch (error) {
      say({ id: m.id, error: String(error && error.code) });
    }
  } else if (m.op === "drop") {
    if (held.delete(m.fd)) fs.closeSync(m.fd);
  } else if (m.op === "probe") {
    const wrong = [];
    for (const path of m.hidden) {
      try { if (fs.readdirSync(path).length > 0) wrong.push("not empty: " + path); } catch { wrong.push("not listed: " + path); }
      if (!refusesWrite(path)) wrong.push("writable: " + path);
    }
    for (const path of m.readOnly) if (!refusesWrite(path)) wrong.push("writable: " + path);
    for (const path of m.writable) {
      try { fs.accessSync(path, fs.constants.W_OK); } catch { wrong.push("not writable: " + path); }
    }
    say({ id: m.id, wrong });
  } else if (m.op === "start" && child === undefined) {
    child = spawn(m.program, m.args, { cwd: m.cwd, env: m.env, stdio: "inherit" });
    child.on("error", () => leave(71));
    child.on("exit", (code, signal) => {
      const status = signal ? 72 : code === null ? 73 : code;
      setTimeout(() => leave(status), 200);
      say({ exited: { code, signal } }, () => leave(status));
    });
    say({ id: m.id, started: child.pid });
  }
};
let waiting = "";
control.setEncoding("utf8");
control.on("data", (chunk) => {
  waiting += chunk;
  for (;;) {
    const end = waiting.indexOf("\n");
    if (end < 0) break;
    const line = waiting.slice(0, end);
    waiting = waiting.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { leave(74); }
    act(message);
  }
});
control.on("end", () => leave(70));
control.on("error", () => leave(70));
control.on("close", () => leave(70));
// What ORCA's own process was handed open, and would hand on, came here through bubblewrap.
// None of it is the executor's. Whatever this runtime opened for itself closes when a
// program is started; anything that would not is closed here. ORCA looks from outside too.
for (const name of fs.readdirSync("/proc/self/fd")) {
  const fd = Number(name);
  if (!(fd > 3)) continue;
  let flags;
  try { flags = /^flags:\s*([0-7]+)$/m.exec(fs.readFileSync("/proc/self/fdinfo/" + fd, "utf8")); } catch { continue; }
  if (flags && (parseInt(flags[1], 8) & 0o2000000) === 0) { try { fs.closeSync(fd); } catch {} }
}
say({ ready: process.pid });
`;

/** A mount point as `/proc/<pid>/mountinfo` spells it, read back. */
const mountPath = (spelled: string): string =>
  spelled.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

interface Mount {
  point: string;
  options: string[];
  type: string;
}

/** The mount table of a process, later mounts last. */
export function parseMountInfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    const dash = fields.indexOf("-");
    if (fields.length < 7 || dash < 6 || fields[dash + 1] === undefined) continue;
    mounts.push({ point: mountPath(fields[4]!), options: fields[5]!.split(","), type: fields[dash + 1]! });
  }
  return mounts;
}

/**
 * The first process of the executor's pid namespace, once ORCA has verified that it is that.
 *
 * It is known by a descriptor for the kernel's own directory of the process, not by its pid:
 * a pid can come to mean another process, and that directory cannot. Everything ORCA reads
 * about the process, when it verifies it and when it looks for its end, is read through
 * `directory`, so what was verified and what is later seen are one process.
 */
interface FirstProcess {
  pid: number;
  fd: number;
  /** `/proc/self/fd/<fd>`: the process's `/proc` directory, by ORCA's descriptor for it. */
  directory: string;
}

/**
 * What the kernel shows of a process, read through a descriptor for its `/proc` directory.
 *
 * `ended` is said only on the kernel's own word, and there are two such words. One: the read
 * is answered "no such process" (`ESRCH`), which through a descriptor means this very process
 * was reaped. Two: the process is listed finished (`Z`) with no thread but its first left.
 * A finished first thread alone is not that, because the others can still be running. For
 * the first process of a pid namespace either word also says the rest of the namespace is
 * gone: its last thread ends every other process there and waits for them before it finishes.
 *
 * Anything else that is not a readable, running process is `unseen`: a read that failed for
 * another reason (no descriptor to spare, no leave, no such file), or text ORCA cannot read
 * the state and thread count from. Not being able to look is not having seen it end.
 */
export function codexExecProcessSeen(directory: string): "there" | "ended" | "unseen" {
  let stat: string;
  try {
    stat = readFileSync(`${directory}/stat`, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "ended" : "unseen";
  }
  // The name is in brackets and can hold anything, so the fields are counted from its end.
  const named = stat.lastIndexOf(") ");
  const rest = named < 0 ? [] : stat.slice(named + 2).split(" ");
  const state = rest[0];
  const threads = rest[17];
  if (state === undefined || !/^[A-Za-z]$/.test(state) || threads === undefined || !/^\d+$/.test(threads))
    return "unseen";
  if (state === "Z") return threads === "1" ? "ended" : "unseen";
  // `X` is a process on its way out of the table: not running, and not yet said to be gone.
  return state === "X" ? "unseen" : "there";
}

const field = (status: string, name: string): string[] =>
  (new RegExp(`^${name}:\\s*(.*)$`, "m").exec(status)?.[1] ?? "").split(/\s+/).filter((word) => word !== "");

/** The pids here of the processes whose parent is the first process. */
function childrenOf(first: FirstProcess): number[] {
  try {
    return readFileSync(`${first.directory}/task/${first.pid}/children`, "utf8")
      .split(" ")
      .filter((word) => /^\d+$/.test(word))
      .map(Number);
  } catch {
    // A kernel without that file: every process is asked for its parent.
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .filter((candidate) => {
        try {
          return field(readFileSync(`/proc/${candidate}/status`, "utf8"), "PPid")[0] === String(first.pid);
        } catch {
          return false;
        }
      });
  }
}

/** The namespaces of the process whose `/proc` directory this is. */
const namespacesOf = (directory: string): { pid: string; mnt: string; user: string } => ({
  pid: readlinkSync(`${directory}/ns/pid`),
  mnt: readlinkSync(`${directory}/ns/mnt`),
  user: readlinkSync(`${directory}/ns/user`),
});

/** A descriptor for the kernel's directory of the process a pid means now, or undefined when there is none. */
function openProcess(pid: number): { fd: number; directory: string } | undefined {
  try {
    const fd = openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY);
    return { fd, directory: `/proc/self/fd/${fd}` };
  } catch {
    return undefined;
  }
}

/**
 * Start `codex exec-server --listen stdio` in a user, pid and mount namespace of its own,
 * and speak its line-delimited JSON once ORCA has seen the isolation for itself.
 *
 * What is sent before then waits, and is dropped if the isolation cannot be shown, or is not
 * shown by the deadline (`setupWaitMs`): ORCA then ends the namespace itself, at once and
 * whatever bubblewrap does or says, and `onExit` and `isolated` give the reason. A `stop`
 * before the isolation is shown does the same: the setup ends there, no executor is started
 * after it, and `isolated` rejects. Once the isolation is shown, `stop` closes the executor's
 * input, then ORCA's channel to the holder, which ends the namespace, and only then signals
 * bubblewrap.
 *
 * `onExit` always says whether ORCA saw the tree end. It says `nothingLeft` only when ORCA
 * verified the first process of the namespace and the kernel then showed that process ended
 * (`codexExecProcessSeen`). With no first process verified, or with a reading that failed or
 * showed anything else, it says ORCA did not see it.
 *
 * Throws `CodexExecIsolationError`, with nothing started, when this is not Linux, there is
 * no bubblewrap the system installed, or a mask is not a real directory's own path.
 */
export function spawnIsolatedCodexExecServer(spec: CodexExecIsolatedSpawn): CodexExecBackend & {
  readonly pid: number | undefined;
  /** What ORCA saw before the executor was sent anything. Rejects when it could not be shown. */
  readonly isolated: Promise<CodexExecIsolationProof>;
  hold(held: CodexExecGateHeldDirectory): Promise<CodexExecGateHeldDirectory | undefined>;
} {
  if (process.platform !== "linux") throw new CodexExecIsolationError("an executor is isolated only on Linux");
  const bubblewrap = spec.bubblewrap ?? systemBubblewrap();
  if (bubblewrap === undefined)
    throw new CodexExecIsolationError("the system has no bubblewrap (bwrap) that only root can change");
  const masks: CodexExecMasks = {
    hidden: [...spec.masks.hidden],
    readOnly: [...spec.masks.readOnly],
    writable: [...spec.masks.writable],
  };
  const child = spawn(
    bubblewrap,
    [
      "--unshare-user",
      "--unshare-pid",
      "--as-pid-1",
      "--die-with-parent",
      // Nothing in the namespace is to hold a capability over it, whoever ORCA runs as.
      "--cap-drop",
      "ALL",
      "--info-fd",
      "4",
      "--dev-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      ...maskArguments(masks),
      "--chdir",
      "/",
      "--",
      spec.runtime ?? process.execPath,
      "-e",
      HOLDER,
    ],
    { cwd: "/", env: { ...(spec.runtimeEnv ?? {}) }, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
  );
  const control = child.stdio[3] as unknown as Socket;
  const info = child.stdio[4] as unknown as Readable;
  const grace = spec.stopGraceMs ?? 2000;

  let diagnostics = "";
  /**
   * The first process of the namespace. Set only once ORCA has verified that it is that, and
   * unset when ORCA's descriptor for it is closed. The pid bubblewrap names is a claim, and
   * is never kept here.
   */
  let first: FirstProcess | undefined;

  /* ---- the channel to the holder ---- */
  const answers = new Map<number, (message: Record<string, unknown>) => void>();
  let requests = 0;
  let onReady: ((pid: unknown) => void) | undefined;
  let line = "";
  let closed = false;
  const lost = (): void => {
    closed = true;
    for (const answer of answers.values()) answer({ error: "closed" });
    answers.clear();
  };
  const endNamespace = (): void => {
    // Closing the channel ends the holder, and with it everything in its pid namespace.
    lost();
    control.destroy();
  };
  const core = codexExecServerOver({
    child,
    stopGraceMs: spec.stopGraceMs,
    budget: spec.budget,
    messageLimitBytes: spec.messageLimitBytes,
    steps: [endNamespace, () => void child.kill("SIGKILL")],
    kill: () => {
      endNamespace();
      // Bubblewrap is given the grace to reap the first process only where ORCA could then see
      // that it did. With none verified there is nothing to see by waiting.
      if (first === undefined) child.kill("SIGKILL");
      else setTimeout(() => void child.kill("SIGKILL"), grace).unref();
    },
    // Only the kernel's word about the verified first process counts. See `codexExecProcessSeen`.
    nothingLeft: () => first !== undefined && codexExecProcessSeen(first.directory) === "ended",
    onDiagnostics: (chunk) => {
      if (diagnostics.length < DIAGNOSTIC_BYTES)
        diagnostics = (diagnostics + chunk.toString("utf8")).slice(0, DIAGNOSTIC_BYTES);
    },
  });

  /**
   * What bubblewrap had to say has arrived, or is not waited for any longer. The wait has an
   * end of its own, because bubblewrap may never exit or close its error stream, and nothing
   * ORCA does to end the namespace waits for this.
   */
  const closedOrExited = new Promise<void>((resolve) => {
    child.stderr.once("close", () => resolve());
    child.once("exit", () => setTimeout(resolve, 200).unref());
  });
  const said = (): Promise<void> =>
    Promise.race([
      closedOrExited,
      new Promise<void>((resolve) => void setTimeout(resolve, DIAGNOSTICS_WAIT_MS).unref()),
    ]);
  /** A reason, with the first thing bubblewrap said beside it when it said anything. */
  const explained = (reason: string): string => {
    const why = diagnostics.trim().split("\n")[0];
    return why && !reason.includes(why) ? `${reason}: ${why}` : reason;
  };

  control.setEncoding("utf8");
  control.on("data", (chunk: string) => {
    line += chunk;
    if (line.length > HOLDER_LINE_BYTES) return giveUp("the holder in its namespace wrote too much");
    for (;;) {
      const end = line.indexOf("\n");
      if (end < 0) break;
      let message: unknown;
      try {
        message = JSON.parse(line.slice(0, end));
      } catch {
        message = undefined;
      }
      line = line.slice(end + 1);
      if (typeof message !== "object" || message === null) continue;
      const heard = message as Record<string, unknown>;
      if ("ready" in heard) onReady?.(heard["ready"]);
      const id = heard["id"];
      if (typeof id === "number") {
        const answer = answers.get(id);
        answers.delete(id);
        answer?.(heard);
      }
    }
  });
  control.on("error", lost);
  control.on("close", lost);
  const tell = (message: Record<string, unknown>): void => {
    if (!closed) control.write(`${JSON.stringify(message)}\n`);
  };
  const ask = (message: Record<string, unknown>, waitMs = HOLDER_WAIT_MS): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      if (closed) return resolve({ error: "closed" });
      const id = ++requests;
      const timer = setTimeout(() => {
        answers.delete(id);
        resolve({ error: "no answer" });
      }, waitMs);
      answers.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      tell({ ...message, id });
    });

  /* ---- what is sent before the isolation is shown waits ---- */
  let shown = false;
  let refused: string | undefined;
  /** What the setup is waiting for, for the reason given when the deadline passes. */
  let making = true;
  let onRefused: (() => void) | undefined;
  const waiting: { message: string; flushed: () => void }[] = [];
  const dropWaiting = (): void => {
    for (const { flushed } of waiting.splice(0)) flushed();
  };
  /**
   * Give the executor up before it was shown. The teardown is asked for here and now: the
   * channel is closed, which ends the holder, and bubblewrap is signalled. Nothing that is
   * still awaited (an answer, an exit, what bubblewrap wrote) stands between the refusal and it.
   */
  const refuse = (why: string): void => {
    if (shown || refused !== undefined) return;
    refused = why;
    clearTimeout(deadline);
    dropWaiting();
    core.fail(why);
    onRefused?.();
  };
  /** Give it up for a reason of ORCA's own, shown or not. */
  function giveUp(why: string): void {
    if (shown) core.fail(why);
    else refuse(why);
  }
  /**
   * Why the setup can go no further, once it cannot: ORCA refused or stopped it, its channel
   * to the holder closed, or bubblewrap exited. The setup asks this after everything it
   * waited for, before it has the executor started and before it says the isolation is shown.
   */
  const over = (): string | undefined =>
    refused ?? (closed ? "ORCA's channel to the holder closed before the isolation was shown" : undefined);
  const waitMs = spec.setupWaitMs ?? SETUP_WAIT_MS;
  const deadline = setTimeout(
    () =>
      refuse(
        making
          ? "the executor's namespace could not be made: it was not made in time"
          : "the executor's isolation was not shown in time",
      ),
    waitMs,
  );
  deadline.unref();

  const prove = async (): Promise<CodexExecIsolationProof> => {
    const wrong = (what: string): never => {
      throw new CodexExecIsolationError(what);
    };
    /** After anything awaited: a setup that was refused, stopped or cut off meanwhile goes no further. */
    const unlessOver = (): void => {
      const why = over();
      if (why !== undefined) wrong(why);
    };
    /** And neither does one whose first process ended meanwhile: ORCA's descriptor for it is closed. */
    const stillThere = (holder: FirstProcess): void => {
      unlessOver();
      if (first !== holder) wrong("the holder is not there");
    };
    const made = await new Promise<{ pid: unknown; first: unknown } | string | undefined>((resolve) => {
      let text = "";
      let pid: unknown;
      let pid1: unknown;
      const done = (): void => {
        if (pid !== undefined && pid1 !== undefined) resolve({ pid, first: pid1 });
      };
      info.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.length > HOLDER_LINE_BYTES) return resolve("bubblewrap wrote too much about it");
        try {
          pid = (JSON.parse(text) as Record<string, unknown>)["child-pid"];
          done();
        } catch {
          // Not all of it yet.
        }
      });
      onReady = (inner) => {
        pid1 = inner;
        done();
      };
      onRefused = () => resolve(undefined);
      core.onExit((detail) => resolve(`bubblewrap ended (${detail})`));
    });
    if (refused !== undefined) wrong(refused);
    if (typeof made === "string") wrong(`the executor's namespace could not be made: ${made}`);
    unlessOver();
    making = false;
    const { pid: named, first: saidInside } = made as { pid: unknown; first: unknown };
    if (typeof named !== "number" || !Number.isSafeInteger(named) || named <= 1) wrong("bubblewrap named no process");

    // The pid bubblewrap named is a candidate. ORCA takes a descriptor for the process that pid
    // means now, and verifies through that descriptor that the process is the first of
    // namespaces that are not ORCA's. Only then is it the process whose end ORCA will speak of.
    const candidate = openProcess(named as number);
    if (candidate === undefined) wrong("the holder is not there");
    const at = candidate!.directory;
    let namespaces: { pid: string; mnt: string; user: string };
    let status: string;
    try {
      status = readFileSync(`${at}/status`, "utf8");
      // A child of ORCA's bubblewrap, which is ORCA's own child and has not been reaped: its pid
      // is no other process's while that is so.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
        wrong("bubblewrap ended before the holder was seen");
      if (field(status, "PPid")[0] !== String(child.pid)) wrong("the holder is not the child of ORCA's bubblewrap");
      const inner = field(status, "NSpid");
      if (saidInside !== 1 || inner.length < 2 || inner.at(-1) !== "1" || inner[0] !== String(named))
        wrong("the holder is not the first process of a pid namespace of its own");
      namespaces = namespacesOf(at);
      const mine = namespacesOf("/proc/self");
      for (const kind of ["pid", "mnt", "user"] as const)
        if (namespaces[kind] === mine[kind]) wrong(`the holder is in ORCA's own ${kind} namespace`);
      if (codexExecProcessSeen(at) !== "there") wrong("the holder is not there");
    } catch (error) {
      closeSync(candidate!.fd);
      throw error;
    }
    first = { pid: named as number, ...candidate! };
    const holder = first;

    if (!/^0+$/.test(field(status, "CapEff")[0] ?? "")) wrong("the holder holds capabilities over its namespace");

    // From outside: the holder would hand the executor its input and output and nothing else.
    // A descriptor ORCA's own process was handed open comes through bubblewrap to the holder,
    // and one such would be an object in a command's hands that no mask and no decision covers.
    for (const name of readdirSync(`${at}/fd`)) {
      if (name === "0" || name === "1" || name === "2") continue;
      let about: string;
      try {
        about = readFileSync(`${at}/fdinfo/${name}`, "utf8");
      } catch (error) {
        // Closed since it was listed, so not there to hand on.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const flags = /^flags:\s*([0-7]+)$/m.exec(about)?.[1];
      if (flags === undefined || (Number.parseInt(flags, 8) & CLOSE_ON_EXEC) === 0)
        wrong(`the holder would hand descriptor ${name} on to the executor`);
    }

    // From outside: its mount table shows each mask, and a hidden directory is empty through its root.
    const mounts = parseMountInfo(readFileSync(`${at}/mountinfo`, "utf8"));
    const top = (path: string): Mount | undefined => mounts.filter((mount) => mount.point === path).at(-1);
    for (const path of masks.hidden) {
      const mount = top(path);
      if (mount?.type !== "tmpfs" || !mount.options.includes("ro")) wrong(`a hidden directory is not masked: ${path}`);
      if (readdirSync(`${at}/root${path}`).length > 0) wrong(`a hidden directory is not empty: ${path}`);
      const through = statSync(`${at}/root${path}`, { bigint: true });
      const real = statSync(path, { bigint: true });
      if (through.dev === real.dev && through.ino === real.ino)
        wrong(`a hidden directory is the directory itself: ${path}`);
    }
    for (const path of masks.readOnly)
      if (!top(path)?.options.includes("ro")) wrong(`a read-only directory is not bound read-only: ${path}`);
    for (const path of masks.writable)
      if (!top(path)?.options.includes("rw")) wrong(`a writable directory is not bound writable: ${path}`);

    // From inside, by the holder: what the masks do to a process in the namespace.
    const probe = await ask({ op: "probe", ...masks });
    stillThere(holder);
    if (!Array.isArray(probe["wrong"])) wrong("the holder did not try the masks");
    if ((probe["wrong"] as unknown[]).length > 0)
      wrong(`a mask does not hold inside the namespace (${String((probe["wrong"] as unknown[])[0])})`);

    // Only now is there an executor. It is the holder's child, in the holder's namespaces.
    const begun = await ask(
      {
        op: "start",
        program: spec.program,
        args: ["exec-server", "--listen", "stdio"],
        cwd: spec.cwd,
        env: codexExecServerEnv(spec.env),
      },
      waitMs,
    );
    stillThere(holder);
    const innerPid = begun["started"];
    if (typeof innerPid !== "number") wrong("the holder did not start the executor");
    const isIt = (directory: string): boolean => {
      try {
        const theirs = readFileSync(`${directory}/status`, "utf8");
        return field(theirs, "NSpid").at(-1) === String(innerPid) && field(theirs, "PPid")[0] === String(holder.pid);
      } catch {
        return false;
      }
    };
    const executor = childrenOf(holder).find((pid) => isIt(`/proc/${pid}`));
    if (executor === undefined) wrong("the executor is not the holder's child");
    // As with the holder: one descriptor, so that every reading below is of one process.
    const theirs = openProcess(executor!);
    if (theirs === undefined) wrong("the executor is not there");
    try {
      if (!isIt(theirs!.directory)) wrong("the executor is not the holder's child");
      if (!/^0+$/.test(field(readFileSync(`${theirs!.directory}/status`, "utf8"), "CapEff")[0] ?? ""))
        wrong("the executor holds capabilities over its namespace");
      const its = namespacesOf(theirs!.directory);
      for (const kind of ["pid", "mnt", "user"] as const)
        if (its[kind] !== namespaces[kind]) wrong(`the executor is not in the holder's ${kind} namespace`);
      // The holder's channel is a socket, which no path opens. The executor was not handed it either.
      const channel = readlinkSync(`${at}/fd/3`);
      for (const fd of readdirSync(`${theirs!.directory}/fd`)) {
        let target: string;
        try {
          target = readlinkSync(`${theirs!.directory}/fd/${fd}`);
        } catch {
          continue;
        }
        if (target === channel) wrong("the executor holds the holder's channel");
      }
    } finally {
      closeSync(theirs!.fd);
    }
    let ptraceScope: number | undefined;
    try {
      ptraceScope = Number(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim());
    } catch {
      ptraceScope = undefined;
    }
    return {
      holder: holder.pid,
      executor: executor!,
      namespaces,
      masks,
      ...(ptraceScope !== undefined && Number.isInteger(ptraceScope) ? { ptraceScope } : {}),
    };
  };

  const isolated = (async (): Promise<CodexExecIsolationProof> => {
    let proof: CodexExecIsolationProof;
    try {
      proof = await prove();
      // Asked once more, here where the isolation would be said to be shown.
      const why = over();
      if (why !== undefined) throw new CodexExecIsolationError(why);
    } catch (error) {
      // The teardown starts with the refusal. What bubblewrap wrote is then waited for only to
      // explain the refusal, and only so long: it may never exit or close its error stream.
      refuse(error instanceof Error ? error.message : "the executor's isolation could not be shown");
      await said();
      throw new CodexExecIsolationError(explained(refused ?? "the executor's isolation could not be shown"));
    }
    shown = true;
    clearTimeout(deadline);
    for (const { message, flushed } of waiting.splice(0)) {
      try {
        core.send(message, flushed);
      } catch {
        flushed();
      }
    }
    return proof;
  })();
  // A caller that never looks is told through `onExit`.
  isolated.catch(() => undefined);
  core.onExit(() => {
    clearTimeout(deadline);
    dropWaiting();
    lost();
    // The exit was judged, through this descriptor, before any listener heard of it.
    if (first !== undefined) closeSync(first.fd);
    first = undefined;
  });

  return {
    pid: child.pid,
    isolated,
    send(message, flushed) {
      if (shown) return core.send(message, flushed);
      if (refused !== undefined) throw new Error(`the executor is gone (${refused})`);
      waiting.push({ message, flushed });
    },
    onMessage: (listener) => core.onMessage(listener),
    onExit: (listener) =>
      core.onExit((detail, nothingLeft) => {
        // This backend always says which: an exit it could not judge is one it did not see.
        const seen = nothingLeft === true;
        if (shown) return listener(detail, seen);
        // An executor that was never shown ended for a reason bubblewrap or ORCA gave.
        void said().then(() => {
          listener(explained(refused !== undefined && refused !== detail ? `${detail}: ${refused}` : detail), seen);
        });
      }),
    stop() {
      // A stop before the isolation was shown ends the setup there and then: what it is
      // waiting for is cut short, no executor is started after this, and no proof is given.
      // The namespace is ended at once, with none of the grace an executor at work is given.
      refuse("ORCA stopped it before its isolation was shown");
      return core.stop();
    },
    async hold(held) {
      const holder = first;
      if (!shown || holder === undefined || closed) return undefined;
      const answer = await ask({ op: "hold", path: held.real });
      const fd = answer["fd"];
      if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 0) return undefined;
      const drop = (): void => tell({ op: "drop", fd });
      try {
        // ORCA's descriptor for the holder is closed, and may mean something else, once it is gone.
        if (first !== holder || codexExecProcessSeen(holder.directory) !== "there") {
          drop();
          return undefined;
        }
        // Seen from here, not taken on the holder's word: its descriptor and ORCA's are one directory.
        const theirs = statSync(`${holder.directory}/fd/${fd}`, { bigint: true });
        const ours = statSync(held.reach, { bigint: true });
        if (!theirs.isDirectory() || theirs.dev !== ours.dev || theirs.ino !== ours.ino) {
          drop();
          return undefined;
        }
      } catch {
        drop();
        return undefined;
      }
      held.release();
      let open = true;
      return {
        real: held.real,
        reach: `/proc/1/fd/${fd}`,
        endsWithExecutor: true,
        release() {
          if (!open) return;
          open = false;
          drop();
        },
      };
    },
  };
}
