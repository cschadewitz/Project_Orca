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
 * closes, so ORCA ending ends them too. `nothingLeft` is ORCA's own reading of that: the
 * holder's process, which ORCA knows by pid and start time, is no longer there. Bubblewrap's
 * exit status is not what is believed.
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
 * connection with it.
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
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
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

/** A process by pid and the time it started, so that the pid coming to mean another is seen. */
interface Seen {
  pid: number;
  started: string;
}

/** `state` and `starttime` of a process, or undefined when no such process is there. */
function processStat(pid: number): { state: string; started: string } | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // The name is in brackets and can hold anything, so the fields are counted from its end.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = rest[0];
  const started = rest[19];
  return state === undefined || started === undefined ? undefined : { state, started };
}

/** Whether the process once seen is no longer there: gone, a zombie, or its pid another process's. */
function isGone(seen: Seen): boolean {
  const now = processStat(seen.pid);
  return now === undefined || now.started !== seen.started || now.state === "Z" || now.state === "X";
}

const field = (status: string, name: string): string[] =>
  (new RegExp(`^${name}:\\s*(.*)$`, "m").exec(status)?.[1] ?? "").split(/\s+/).filter((word) => word !== "");

/** The pids here of the processes whose parent is `pid`. */
function childrenOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
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
          return field(readFileSync(`/proc/${candidate}/status`, "utf8"), "PPid")[0] === String(pid);
        } catch {
          return false;
        }
      });
  }
}

const namespacesOf = (pid: number | "self"): { pid: string; mnt: string; user: string } => ({
  pid: readlinkSync(`/proc/${pid}/ns/pid`),
  mnt: readlinkSync(`/proc/${pid}/ns/mnt`),
  user: readlinkSync(`/proc/${pid}/ns/user`),
});

/**
 * Start `codex exec-server --listen stdio` in a user, pid and mount namespace of its own,
 * and speak its line-delimited JSON once ORCA has seen the isolation for itself.
 *
 * What is sent before then waits, and is dropped if the isolation cannot be shown: the
 * namespace is ended, and `onExit` and `isolated` give the reason. `stop` closes the
 * executor's input, then ORCA's channel to the holder, which ends the namespace, and only
 * then signals bubblewrap. `onExit` says `nothingLeft` when ORCA can see that the holder's
 * process is no longer there, and says it is not known when it cannot.
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
  let holder: Seen | undefined;
  const endNamespace = (): void => {
    // Closing the channel ends the holder, and with it everything in its pid namespace.
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
      setTimeout(() => void child.kill("SIGKILL"), grace).unref();
    },
    // An executor is started only once the holder has been seen. So with no holder seen there
    // was no executor, and otherwise the holder has to be gone.
    nothingLeft: () => holder === undefined || isGone(holder),
    onDiagnostics: (chunk) => {
      if (diagnostics.length < DIAGNOSTIC_BYTES)
        diagnostics = (diagnostics + chunk.toString("utf8")).slice(0, DIAGNOSTIC_BYTES);
    },
  });

  /** What bubblewrap had to say has arrived, or is not waited for any longer. */
  const said = new Promise<void>((resolve) => {
    child.stderr.once("close", () => resolve());
    child.once("exit", () => setTimeout(resolve, 200).unref());
  });

  /* ---- the channel to the holder ---- */
  const answers = new Map<number, (message: Record<string, unknown>) => void>();
  let requests = 0;
  let onReady: ((pid: unknown) => void) | undefined;
  let line = "";
  let closed = false;
  control.setEncoding("utf8");
  control.on("data", (chunk: string) => {
    line += chunk;
    if (line.length > HOLDER_LINE_BYTES) return core.fail("the holder in its namespace wrote too much");
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
  const lost = (): void => {
    closed = true;
    for (const answer of answers.values()) answer({ error: "closed" });
    answers.clear();
  };
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
  const waiting: { message: string; flushed: () => void }[] = [];
  const dropWaiting = (): void => {
    for (const { flushed } of waiting.splice(0)) flushed();
  };

  const prove = async (): Promise<CodexExecIsolationProof> => {
    const wrong = (what: string): never => {
      throw new CodexExecIsolationError(what);
    };
    const waitMs = spec.setupWaitMs ?? SETUP_WAIT_MS;
    const made = await new Promise<{ pid: unknown; first: unknown } | string>((resolve) => {
      let text = "";
      let pid: unknown;
      let first: unknown;
      const done = (): void => {
        if (pid !== undefined && first !== undefined) resolve({ pid, first });
      };
      const timer = setTimeout(() => resolve("it was not made in time"), waitMs);
      timer.unref();
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
      onReady = (pid1) => {
        first = pid1;
        done();
      };
      core.onExit((detail) => resolve(`bubblewrap ended (${detail})`));
    });
    if (typeof made === "string") {
      await said;
      const why = diagnostics.trim().split("\n")[0];
      wrong(`the executor's namespace could not be made: ${made}${why ? `: ${why}` : ""}`);
    }
    const { pid, first } = made as { pid: unknown; first: unknown };
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) wrong("bubblewrap named no process");
    const at = pid as number;
    const stat = processStat(at);
    if (stat === undefined) wrong("the holder is not there");
    holder = { pid: at, started: stat!.started };

    // From outside: the holder is our child's child, and process 1 of namespaces that are not ours.
    const status = readFileSync(`/proc/${at}/status`, "utf8");
    if (field(status, "PPid")[0] !== String(child.pid)) wrong("the holder is not the child of ORCA's bubblewrap");
    const inner = field(status, "NSpid");
    if (first !== 1 || inner.length < 2 || inner.at(-1) !== "1" || inner[0] !== String(at))
      wrong("the holder is not the first process of a pid namespace of its own");
    if (!/^0+$/.test(field(status, "CapEff")[0] ?? "")) wrong("the holder holds capabilities over its namespace");
    const namespaces = namespacesOf(at);
    const mine = namespacesOf("self");
    for (const kind of ["pid", "mnt", "user"] as const)
      if (namespaces[kind] === mine[kind]) wrong(`the holder is in ORCA's own ${kind} namespace`);

    // From outside: its mount table shows each mask, and a hidden directory is empty through its root.
    const mounts = parseMountInfo(readFileSync(`/proc/${at}/mountinfo`, "utf8"));
    const top = (path: string): Mount | undefined => mounts.filter((mount) => mount.point === path).at(-1);
    for (const path of masks.hidden) {
      const mount = top(path);
      if (mount?.type !== "tmpfs" || !mount.options.includes("ro")) wrong(`a hidden directory is not masked: ${path}`);
      if (readdirSync(`/proc/${at}/root${path}`).length > 0) wrong(`a hidden directory is not empty: ${path}`);
      const through = statSync(`/proc/${at}/root${path}`, { bigint: true });
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
    const innerPid = begun["started"];
    if (typeof innerPid !== "number") wrong("the holder did not start the executor");
    const executor = childrenOf(at).find((candidate) => {
      try {
        return field(readFileSync(`/proc/${candidate}/status`, "utf8"), "NSpid").at(-1) === String(innerPid);
      } catch {
        return false;
      }
    });
    if (executor === undefined) wrong("the executor is not the holder's child");
    if (!/^0+$/.test(field(readFileSync(`/proc/${executor!}/status`, "utf8"), "CapEff")[0] ?? ""))
      wrong("the executor holds capabilities over its namespace");
    const theirs = namespacesOf(executor!);
    for (const kind of ["pid", "mnt", "user"] as const)
      if (theirs[kind] !== namespaces[kind]) wrong(`the executor is not in the holder's ${kind} namespace`);
    // The holder's channel is a socket, which no path opens. The executor was not handed it either.
    const channel = readlinkSync(`/proc/${at}/fd/3`);
    for (const fd of readdirSync(`/proc/${executor!}/fd`)) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${executor!}/fd/${fd}`);
      } catch {
        continue;
      }
      if (target === channel) wrong("the executor holds the holder's channel");
    }
    let ptraceScope: number | undefined;
    try {
      ptraceScope = Number(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim());
    } catch {
      ptraceScope = undefined;
    }
    return {
      holder: at,
      executor: executor!,
      namespaces,
      masks,
      ...(ptraceScope !== undefined && Number.isInteger(ptraceScope) ? { ptraceScope } : {}),
    };
  };

  const isolated = prove().then(
    (proof) => {
      shown = true;
      for (const { message, flushed } of waiting.splice(0)) {
        try {
          core.send(message, flushed);
        } catch {
          flushed();
        }
      }
      return proof;
    },
    (error: unknown) => {
      refused = error instanceof Error ? error.message : "the executor's isolation could not be shown";
      dropWaiting();
      core.fail(refused);
      throw error instanceof CodexExecIsolationError ? error : new CodexExecIsolationError(refused);
    },
  );
  // A caller that never looks is told through `onExit`.
  isolated.catch(() => undefined);
  core.onExit(() => {
    dropWaiting();
    lost();
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
        if (shown) return listener(detail, nothingLeft);
        // An executor that was never shown ended for a reason bubblewrap or ORCA gave.
        void said.then(() => {
          const why = refused ?? diagnostics.trim().split("\n")[0];
          listener(why && why !== detail ? `${detail}: ${why}` : detail, nothingLeft);
        });
      }),
    stop: () => core.stop(),
    async hold(held) {
      if (!shown || holder === undefined || closed) return undefined;
      const at = holder.pid;
      const answer = await ask({ op: "hold", path: held.real });
      const fd = answer["fd"];
      if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 0) return undefined;
      const drop = (): void => tell({ op: "drop", fd });
      try {
        // Seen from here, not taken on the holder's word: its descriptor and ORCA's are one directory.
        const theirs = statSync(`/proc/${at}/fd/${fd}`, { bigint: true });
        const ours = statSync(held.reach, { bigint: true });
        if (isGone(holder) || !theirs.isDirectory() || theirs.dev !== ours.dev || theirs.ino !== ours.ino) {
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
