/**
 * The executor behind ORCA's gate, in namespaces ORCA makes (#1026).
 *
 * The gate (`codex-exec-gate.ts`) decides each request Codex's executor is sent. Two things it
 * cannot do by deciding: end everything the executor started, and keep ORCA's own directories
 * out of the executor's reach under a name the decision never saw. This backend does both by
 * where it runs the executor: through the system's bubblewrap, in a user, pid and mount
 * namespace of its own, and with no network unless the host's is asked for. The user and the
 * rest of the file system stay as they are.
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
 * **The deadline is kept by ORCA's thread, and is no bound in seconds on the teardown.** A
 * timer ends a setup that is waiting. A setup that is not waiting is that thread at work,
 * which its own timer cannot interrupt, so the setup also reads a clock that does not run
 * back: right before it has the executor started, and right before it says the isolation is
 * shown and sends what was waiting. A setup found late there starts no executor after that
 * and gives no proof, however late it is found. The reads that leave `/proc` for a file
 * system, which may be slow or never answer, are made off ORCA's thread, one at a time. A
 * refusal (the deadline, a stop, the namespace's own end) settles the setup's result by
 * itself while such a read is out, and what the read comes to later is not looked at.
 * ORCA's descriptor for the first process stays open until the read is back, because the
 * read may still have that descriptor's name to follow. Each read that is out keeps one of
 * the few threads Node reads files on, so ORCA has no more than
 * `CODEX_EXEC_READS_AT_ONCE` of them out for all its setups together: a setup that finds no
 * place waits for one, within its own deadline, and its read is never made if it is refused
 * first, or if its time is found to be up when a place comes to it. A read that never comes back keeps its place for as long as ORCA runs. With every
 * place kept, a later setup that has a hidden directory to look into is refused at its
 * deadline, and says why. What ORCA reads
 * from `/proc` itself (a process's status, namespaces, mount table and descriptors) it
 * reads on its thread. While the kernel is answering one of those, and while anything else
 * keeps that thread, neither the timer nor a `stop` is acted on: the teardown comes when the
 * thread is free again. Nothing in ORCA watches from outside that thread, because all it
 * could do is signal a pid. What does not depend on ORCA's thread is the kernel's part: the
 * namespace ends when ORCA or its bubblewrap dies. The masks' paths are read on ORCA's
 * thread too, before bubblewrap is started, when there is nothing yet to end.
 *
 * **What a command can reach outside the namespace is narrowed, not closed.** A command
 * ORCA allowed runs as the user. A program outside the namespace that acts for that user (a
 * user service manager, a keyring, a container daemon, a terminal multiplexer, a login to the
 * same machine) is under no mask and in no tree, and what it does for a command it does with
 * all the user may do. `codexExecOutsideReach` names the directories such programs are
 * usually reached through, for whoever starts the executor to hide, and the variables that
 * point a command at them. Unless the host's network is asked for, the namespace has a
 * network of its own with nothing in it, which closes services on the loopback address and
 * sockets with abstract names, and every other use of the network with them. With
 * `network: "host"` those stay reachable. Neither covers a system service the user may use
 * through a socket outside the hidden directories, nor what a command leaves behind to be
 * run later (a shell profile, a unit of the user's service manager). A file that gives
 * whoever runs it another user's rights gives a command nothing: ORCA starts the executor
 * only after the kernel listed it as unable to gain privileges that way.
 *
 * Limits, said plainly. Where the system lets one process trace an unrelated process of the same user
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
import { readdir, stat } from "node:fs/promises";
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
/**
 * How many reads of a file system ORCA has out at once for its setups, all of them together.
 * A read that never comes back keeps one of the few threads Node reads files on until it
 * does, and those threads are every part of ORCA's. This is the most of them a setup's reads
 * ever keep.
 */
export const CODEX_EXEC_READS_AT_ONCE = 2;
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

/**
 * The variables that point a command at a program outside the namespace that acts for the
 * user. Each has a rule in `codexExecOutsideReach`: a variable that is set is followed to a
 * directory that is hidden, or it is listed as not hidden. There is no third outcome. They
 * are followed in this order: the runtime directory comes before the names that are inside
 * it, and the variable that names a program's place before those that only tell of the
 * program (its process, its pane, its credentials).
 */
export const CODEX_EXEC_OUTSIDE_VARIABLES = [
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "GNOME_KEYRING_CONTROL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "SESSION_MANAGER",
  "DOCKER_HOST",
  "CONTAINER_HOST",
  "TMUX",
  "TMUX_PANE",
  "TMUX_TMPDIR",
  "SCREENDIR",
  "STY",
  "VSCODE_IPC_HOOK_CLI",
] as const;

/** What `codexExecOutsideReach` found. */
export interface CodexExecOutsideReach {
  /** Directories to hide: each is a real directory's own path, and holds such programs' sockets. */
  hidden: string[];
  /** The environment for the executor, without the variables in `CODEX_EXEC_OUTSIDE_VARIABLES`. */
  env: Record<string, string>;
  /** Which of those variables were set, by name. Their values are not kept. */
  dropped: string[];
  /**
   * Every place such a program may be reached through that is known of and not hidden, and
   * why: it cannot be hidden without hiding more, it is not the user's own to hide, ORCA
   * could not look at it, or a variable names it in a way ORCA cannot follow or cannot read
   * exactly. `from` is the variable that named the place, by its name and never by its
   * value, or a well-known path. What is listed here is not behind the hidden directories.
   * Only when it is empty is every place this function knows of hidden, and that is still a
   * list of places.
   */
  unhidden: { from: string; why: string }[];
}

/** What is at a path: a directory itself, nothing, something else, or ORCA could not look. */
function whatIsAt(path: string): "directory" | "absent" | "other" | "unseen" {
  try {
    return lstatSync(path).isDirectory() ? "directory" : "other";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unseen";
  }
}

/**
 * The addresses of a message bus, read exactly as the D-Bus specification writes them:
 * `transport:key=value,key=value` joined by `;`, where a value is made of the bytes
 * `-0-9A-Za-z_/.\*` and of `%HH` for every other byte. Undefined for anything else: an
 * empty address, a key given twice, a byte that should have been escaped, an escape that is
 * not two hex digits, or bytes that are not text. What is not read exactly is not guessed at.
 */
function busAddresses(text: string): { transport: string; keys: Map<string, string> }[] | undefined {
  const addresses: { transport: string; keys: Map<string, string> }[] = [];
  for (const address of text.split(";")) {
    const transport = /^([a-z][a-z0-9-]*):/.exec(address)?.[1];
    if (transport === undefined) return undefined;
    const keys = new Map<string, string>();
    const rest = address.slice(transport.length + 1);
    for (const pair of rest === "" ? [] : rest.split(",")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=((?:[-0-9A-Za-z_/.\\*]|%[0-9A-Fa-f]{2})*)$/.exec(pair);
      if (match === null || keys.has(match[1]!)) return undefined;
      const bytes: number[] = [];
      for (let at = 0; at < match[2]!.length; at += 1) {
        if (match[2]![at] === "%") {
          bytes.push(parseInt(match[2]!.slice(at + 1, at + 3), 16));
          at += 2;
        } else bytes.push(match[2]!.charCodeAt(at));
      }
      try {
        keys.set(match[1]!, new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
      } catch {
        return undefined;
      }
    }
    addresses.push({ transport, keys });
  }
  return addresses;
}

/**
 * Where a command would usually reach a program outside the namespace that acts for the
 * user, as far as a directory can be named for it: the user's runtime directory (the session
 * bus with the user service manager and the keyring, rootless container sockets, agents,
 * editors), the directories of the sockets the environment names (the SSH agent's, the
 * session bus's, a keyring's, a container daemon's, an editor's, a display's, the session
 * manager's, a terminal multiplexer's), the sockets of the X and session managers, and
 * those of the terminal multiplexers. Whoever starts the executor hides the directories
 * (`masks.hidden`) and gives it the environment without the variables.
 *
 * This is a list of well-known places, and so it narrows what is reached and does not close
 * it: a program that listens anywhere else is not on it. A name that is not in the file
 * system (an abstract socket, which an X server usually listens on beside its socket in the
 * file system) and a network address are not behind any directory: the executor's own
 * network namespace is what keeps a command from those, not this list.
 *
 * **Every variable that is set is followed to a hidden directory or listed.** A place the
 * environment names counts as hidden only when ORCA followed the name to a directory of the
 * user's own that nobody else may write, and that can be hidden without hiding the user's
 * home or a directory a command works in. Anything else is listed in `unhidden` by the
 * variable's name: a value that is no path, one that leads nowhere or cannot be looked at,
 * a directory that is someone else's, a service that is not reached through a directory at
 * all, a name in a runtime directory that is not hidden, a value written in a way ORCA does
 * not read exactly, and a variable that tells of a program (its process, its pane, its
 * credentials) when nothing names where that program is reached. The only thing passed over
 * in silence is a well-known directory nothing named that is not there; one that is there
 * and cannot be hidden is listed too. An incomplete finding is told from a complete one by
 * that list.
 *
 * `system` is where the system keeps its temporary and runtime directories. Tests give it.
 */
export function codexExecOutsideReach(
  env: Readonly<Record<string, string | undefined>>,
  user: { uid: number; name: string; home: string; keep: readonly string[] },
  system: { temporary: string; run: string } = { temporary: "/tmp", run: "/run" },
): CodexExecOutsideReach {
  const hidden = new Set<string>();
  const unhidden: { from: string; why: string }[] = [];
  const not = (from: string, why: string): undefined => {
    if (!unhidden.some((entry) => entry.from === from && entry.why === why)) unhidden.push({ from, why });
    return undefined;
  };
  const kept = [user.home, ...user.keep].map((path) => physicalPathOf(path) ?? path);
  const noPath = "its value is not a path ORCA can follow";
  const unread = "its value is written in a way ORCA does not read exactly";
  const elsewhere = "it names a service that is not reached through a directory";
  const nothing = "it names nothing that is there";
  /**
   * Hide the directory at `path` and give its real path, or say why not. `named` is true
   * for a place the environment named: there, nothing found is an answer too. `own` asks
   * that the directory be the user's and nobody else's to write, which is asked of every
   * place the environment named and of the well-known ones that are one user's.
   */
  const hide = (path: string, from: string, named: boolean, own: boolean): string | undefined => {
    if (!isAbsolute(path) || path.includes("\0")) return not(from, noPath);
    const real = physicalPathOf(path);
    if (real === undefined) return not(from, "it could not be looked at");
    const found = whatIsAt(real);
    if (found === "absent") return named ? not(from, nothing) : undefined;
    if (found === "unseen") return not(from, "it could not be looked at");
    if (found === "other") return not(from, "it is not a directory");
    if (real === sep || kept.some((needed) => needed === real || inside(needed, real)))
      return not(from, "it holds the user's home or a directory a command works in");
    if (own) {
      let owner: number;
      let mode: number;
      try {
        ({ uid: owner, mode } = statSync(real));
      } catch {
        return not(from, "it could not be looked at");
      }
      // A directory others may write is one other things live in: hiding it hides those.
      if (owner !== user.uid || (mode & 0o022) !== 0) return not(from, "it is not a directory of the user's own");
    }
    hidden.add(real);
    return real;
  };
  /** Hide the directory a socket is in, wherever the path to the socket really leads. */
  const hideSocket = (path: string, from: string): string | undefined => {
    if (!isAbsolute(path) || path.includes("\0")) return not(from, noPath);
    const socket = physicalPathOf(path);
    if (socket === undefined) return not(from, "it could not be looked at");
    return hide(socket.slice(0, socket.lastIndexOf(sep)) || sep, from, true, true);
  };
  /** A name inside the runtime directory the environment gave, which has to be hidden itself first. */
  let runtime: string | undefined;
  const inRuntime = (name: string, from: string): string | undefined =>
    runtime === undefined
      ? not(from, "it is a name in the runtime directory, and no runtime directory is hidden")
      : hideSocket(`${runtime}${sep}${name}`, from);
  type Name = (typeof CODEX_EXEC_OUTSIDE_VARIABLES)[number];
  /** Which of the variables that are set were followed to a hidden directory. */
  const followed = new Map<Name, boolean>();
  /**
   * A variable that tells of a program and is no place (its process, its pane, its
   * credentials): it is as hidden as the place of that program, which another variable names.
   */
  const alongside = (place: Name, from: Name): boolean => {
    if (!followed.has(place)) not(from, "it tells of a program, and nothing names where that is reached");
    else if (!followed.get(place)) not(from, "it tells of a program at a place that is not hidden");
    return followed.get(place) === true;
  };
  /** `unix://<socket>`; any other scheme is a network's or another program's. */
  const container = (value: string, from: Name): boolean => {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(value)?.[1];
    if (scheme === undefined) return not(from, unread) !== undefined;
    if (scheme !== "unix") return not(from, elsewhere) !== undefined;
    return hideSocket(value.slice("unix://".length), from) !== undefined;
  };
  const screens = [
    `${system.run}/screen/S-${user.name}`,
    `${system.temporary}/screens/S-${user.name}`,
    `${system.temporary}/uscreens/S-${user.name}`,
    `${user.home}/.screen`,
  ];

  /** One rule for each variable: true when what it names is behind a hidden directory. */
  const rules: Record<Name, (value: string) => boolean> = {
    XDG_RUNTIME_DIR: (value) => {
      runtime = hide(value, "XDG_RUNTIME_DIR", true, true);
      return runtime !== undefined;
    },
    GNOME_KEYRING_CONTROL: (value) => hide(value, "GNOME_KEYRING_CONTROL", true, true) !== undefined,
    SCREENDIR: (value) => hide(value, "SCREENDIR", true, true) !== undefined,
    SSH_AUTH_SOCK: (value) => hideSocket(value, "SSH_AUTH_SOCK") !== undefined,
    VSCODE_IPC_HOOK_CLI: (value) => hideSocket(value, "VSCODE_IPC_HOOK_CLI") !== undefined,
    // `<socket>:<pid>:<protocol>`.
    GPG_AGENT_INFO: (value) => {
      const socket = /^(.*):\d+:\d+$/s.exec(value)?.[1];
      return (
        (socket === undefined ? not("GPG_AGENT_INFO", unread) : hideSocket(socket, "GPG_AGENT_INFO")) !== undefined
      );
    },
    // `<socket>,<pid>,<session>`.
    TMUX: (value) => {
      const socket = /^(.*),\d+,\d+$/s.exec(value)?.[1];
      return (socket === undefined ? not("TMUX", unread) : hideSocket(socket, "TMUX")) !== undefined;
    },
    // The multiplexer keeps one directory for the user under the one named.
    TMUX_TMPDIR: (value) =>
      (isAbsolute(value)
        ? hide(`${value}${sep}tmux-${user.uid}`, "TMUX_TMPDIR", true, true)
        : not("TMUX_TMPDIR", noPath)) !== undefined,
    // A session's name: its socket has that name in the directory given, or in one of the usual ones.
    STY: (value) => {
      if (value === "" || value.includes(sep) || value.includes("\0")) return not("STY", unread) !== undefined;
      const directories = env["SCREENDIR"] === undefined ? screens : [env["SCREENDIR"]];
      const found = directories
        .filter((directory) => isAbsolute(directory))
        .map((directory) => `${directory}${sep}${value}`);
      const there = found.find((path) => whatIsAt(path) !== "absent");
      return (there === undefined ? not("STY", nothing) : hideSocket(there, "STY")) !== undefined;
    },
    // Only `unix:path=<socket>` and `unix:runtime=yes` are places in the file system.
    DBUS_SESSION_BUS_ADDRESS: (value) => {
      const from = "DBUS_SESSION_BUS_ADDRESS";
      const addresses = busAddresses(value);
      if (addresses === undefined) return not(from, unread) !== undefined;
      let all = true;
      for (const { transport, keys } of addresses) {
        const places = ["path", "abstract", "runtime", "dir", "tmpdir"].filter((key) => keys.has(key));
        const known = [...keys.keys()].every((key) => key === "guid" || places.includes(key));
        let done: string | undefined;
        if (transport === "tcp" || transport === "nonce-tcp" || transport === "unixexec") done = not(from, elsewhere);
        else if (transport !== "unix" || !known || places.length !== 1) done = not(from, unread);
        else if (places[0] === "path") done = hideSocket(keys.get("path")!, from);
        else if (places[0] === "abstract") done = not(from, elsewhere);
        else if (places[0] === "runtime" && keys.get("runtime") === "yes") done = inRuntime("bus", from);
        // `dir` and `tmpdir` say where a server may make a socket, not where one is.
        else done = not(from, unread);
        all = all && done !== undefined;
      }
      return all;
    },
    DOCKER_HOST: (value) => container(value, "DOCKER_HOST"),
    CONTAINER_HOST: (value) => container(value, "CONTAINER_HOST"),
    // `local/<host>:@<name>` and `unix/<host>:<socket>` and `tcp/<host>:<port>`, joined by commas.
    SESSION_MANAGER: (value) => {
      const from = "SESSION_MANAGER";
      let all = true;
      for (const id of value.split(",")) {
        const local = /^(?:local|unix)\/[^/:]*:(.*)$/s.exec(id)?.[1];
        let done: string | undefined;
        if (local === undefined) done = not(from, /^(?:tcp|inet|inet6|decnet)\/[^/]/.test(id) ? elsewhere : unread);
        else if (local.startsWith("@")) done = not(from, elsewhere);
        else done = isAbsolute(local) ? hideSocket(local, from) : not(from, unread);
        all = all && done !== undefined;
      }
      return all;
    },
    // A display given as a path is a socket; given as a name it is in the runtime directory.
    WAYLAND_DISPLAY: (value) =>
      (isAbsolute(value)
        ? hideSocket(value, "WAYLAND_DISPLAY")
        : value === "" || value.includes("\0")
          ? not("WAYLAND_DISPLAY", unread)
          : inRuntime(value, "WAYLAND_DISPLAY")) !== undefined,
    // `:0` and `unix:0` are a socket in the X directory. With a host it is the network's.
    DISPLAY: (value) => {
      if (/^(?:unix)?:\d+(?:\.\d+)?$/.test(value))
        return hide(`${system.temporary}/.X11-unix`, "DISPLAY", true, false) !== undefined;
      return not("DISPLAY", /^[^/:\s]+(?:\/[^/:\s]+)?:\d+(?:\.\d+)?$/.test(value) ? elsewhere : unread) !== undefined;
    },
    SSH_AGENT_PID: () => alongside("SSH_AUTH_SOCK", "SSH_AGENT_PID"),
    TMUX_PANE: () => alongside("TMUX", "TMUX_PANE"),
    XAUTHORITY: () => alongside("DISPLAY", "XAUTHORITY"),
  };

  // What the environment names, in the order of the list: the runtime directory before the
  // names inside it, and a program's place before what else tells of the program.
  const dropped: string[] = [];
  for (const name of CODEX_EXEC_OUTSIDE_VARIABLES) {
    const value = env[name];
    if (value === undefined) continue;
    dropped.push(name);
    followed.set(name, rules[name](value));
    // Whatever a rule does, a variable that is set and not followed to a hidden directory is listed.
    if (!followed.get(name) && !unhidden.some((entry) => entry.from === name))
      not(name, "ORCA did not follow it to a directory");
  }

  // The well-known places, whatever the environment says. One that is not there is not a place.
  const run = `${system.run}/user/${user.uid}`;
  hide(run, run, false, true);
  for (const shared of [`${system.temporary}/.X11-unix`, `${system.temporary}/.ICE-unix`])
    hide(shared, shared, false, false);
  for (const own of [`${system.temporary}/tmux-${user.uid}`, ...screens]) hide(own, own, false, true);

  const without: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !(CODEX_EXEC_OUTSIDE_VARIABLES as readonly string[]).includes(key)) without[key] = value;
  // One inside another is hidden with it.
  const all = [...hidden];
  return {
    hidden: all.filter((path) => !all.some((root) => inside(path, root))),
    env: without,
    dropped,
    unhidden,
  };
}

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

/** The reads a setup makes of a file system, off ORCA's thread. Any of them may never come back. */
export interface CodexExecSetupReads {
  readdir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<{ dev: bigint; ino: bigint }>;
}

let readsOut = 0;
/** Setups waiting for a place, first come first. Each says, when given one, whether it took it. */
const readsWaiting = new Set<() => boolean>();

/** How many reads of a file system ORCA's setups have out now: asked for, and not come back. */
export function codexExecReadsOut(): number {
  return readsOut;
}

/** How many reads of a file system are waiting for one of those to come back. */
export function codexExecReadsWaiting(): number {
  return readsWaiting.size;
}

/** A place is free. It goes to the first setup waiting that still takes it, or back. */
function passOn(): void {
  for (const next of readsWaiting) {
    readsWaiting.delete(next);
    if (next()) return;
  }
  readsOut -= 1;
}

/**
 * Make one read of a file system off ORCA's thread, for a setup that may be over before the
 * read comes back. No more than `CODEX_EXEC_READS_AT_ONCE` are out at a time, whatever
 * setups ask for them: one more waits for one of those to come back, and is not made at all
 * if its setup is over first. A setup that is over has its answer at once, a refusal, and
 * what its read comes to later is nobody's. The read's place stays taken until it is back.
 *
 * `over` is asked when the read is given its place, right before the read is made. A setup
 * whose time is up may not have heard so yet, when its timer has not run, and a read made
 * for it could keep the place for good. It is refused there, and the place goes to the next.
 */
function readOutside<T>(read: () => Promise<T>, setupOver: AbortSignal, over: () => string | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const gaveUp = (): void => {
      readsWaiting.delete(placed);
      reject(new CodexExecIsolationError("the setup was over before a read of the file system came back"));
    };
    const placed = (): boolean => {
      const why = over();
      if (why !== undefined) {
        setupOver.removeEventListener("abort", gaveUp);
        reject(new CodexExecIsolationError(why));
        return false;
      }
      void (async () => read())()
        .then(resolve, reject)
        .finally(() => {
          setupOver.removeEventListener("abort", gaveUp);
          passOn();
        });
      return true;
    };
    if (setupOver.aborted) return gaveUp();
    setupOver.addEventListener("abort", gaveUp, { once: true });
    if (readsOut >= CODEX_EXEC_READS_AT_ONCE) return void readsWaiting.add(placed);
    readsOut += 1;
    if (!placed()) passOn();
  });
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
  /** The clock that time is read from, in milliseconds, never running back. For tests. */
  clock?: (() => number) | undefined;
  /** What reads a file system for the setup. For tests: Node's own, unless one is given. */
  reads?: CodexExecSetupReads | undefined;
  /** What reads the kernel's status of a process, given its file. For tests: the file itself, unless one is given. */
  status?: ((file: string) => string) | undefined;
  /**
   * The network a command has. `none`, the default, is a network namespace of the executor's
   * own with nothing in it but a loopback address of its own: no service outside the
   * namespace is reached over the network, the loopback address and sockets with abstract
   * names included, and neither is anything else. `host` is ORCA's own network, and has to
   * be asked for.
   */
  network?: "host" | "none" | undefined;
}

/** What ORCA saw of an isolated executor before it was sent anything. */
export interface CodexExecIsolationProof {
  /** The holder: process 1 of the executor's pid namespace, by its pid here. */
  holder: number;
  /** The executor, by its pid here. */
  executor: number;
  /**
   * The namespaces both are in, as the kernel names them. The pid, mount and user namespaces
   * are never ORCA's. The network namespace is ORCA's with `network: "host"`, and never with
   * `network: "none"`.
   */
  namespaces: { pid: string; mnt: string; user: string; net: string };
  /** The network a command has: ORCA's own, or none. Seen from the namespaces, not taken from the request. */
  network: "host" | "none";
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

/**
 * What each descriptor of a process is, as its `/proc` directory names it.
 *
 * A descriptor that was closed after it was listed is left out, on the kernel's word that
 * there is none (`ENOENT`). One that is there and that ORCA cannot look at, or a failure ORCA
 * cannot tell from that, is an error and never a pass: what ORCA did not see, it cannot say
 * is not the holder's channel.
 */
export function codexExecDescriptorsOf(directory: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const fd of readdirSync(`${directory}/fd`)) {
    try {
      targets.set(fd, readlinkSync(`${directory}/fd/${fd}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new CodexExecIsolationError(`ORCA could not see what descriptor ${fd} of a process is`);
    }
  }
  return targets;
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
const namespacesOf = (directory: string): { pid: string; mnt: string; user: string; net: string } => ({
  pid: readlinkSync(`${directory}/ns/pid`),
  mnt: readlinkSync(`${directory}/ns/mnt`),
  user: readlinkSync(`${directory}/ns/user`),
  net: readlinkSync(`${directory}/ns/net`),
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
  const network = spec.network ?? "none";
  const statusOf = spec.status ?? ((file: string): string => readFileSync(file, "utf8"));
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
      ...(network === "none" ? ["--unshare-net"] : []),
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
  /**
   * Reads this setup asked for through that descriptor and has not had back. The descriptor
   * stays open, though the process is no longer known by it, until they are back: a read
   * that is still to follow the descriptor's name must not find another file under it.
   */
  let reading = 0;
  let closeAfterReads: number | undefined;
  const letGoOfFirst = (): void => {
    if (first === undefined) return;
    const { fd } = first;
    first = undefined;
    if (reading === 0) closeSync(fd);
    else closeAfterReads = fd;
  };

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
  /** Whether the setup is waiting for a read that other setups' reads leave no place for. */
  let queued = false;
  /**
   * Aborted when the setup is refused. Everything that waits for the setup's sake hears it:
   * the wait for the namespace, a read of a file system, and `isolated` itself.
   */
  const setup = new AbortController();
  const whenRefused = new Promise<undefined>((resolve) => {
    setup.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
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
    setup.abort();
  };
  /** Give it up for a reason of ORCA's own, shown or not. */
  function giveUp(why: string): void {
    if (shown) core.fail(why);
    else refuse(why);
  }
  const waitMs = spec.setupWaitMs ?? SETUP_WAIT_MS;
  const clock = spec.clock ?? ((): number => performance.now());
  /** The time by which the isolation has to be shown, on a clock that does not run back. */
  const cutoff = clock() + waitMs;
  const late = (): string =>
    making
      ? "the executor's namespace could not be made: it was not made in time"
      : queued
        ? "the executor's isolation was not shown in time: reads of the file system that other setups asked for have not come back"
        : reading > 0
          ? "the executor's isolation was not shown in time: a read of the file system has not come back"
          : "the executor's isolation was not shown in time";
  // The timer ends a setup that is waiting. A setup that is not waiting is ORCA's own thread at
  // work, which no timer of that thread interrupts: it reads the clock itself, in `over`.
  const deadline = setTimeout(() => refuse(late()), waitMs);
  deadline.unref();
  /**
   * Why the setup can go no further, once it cannot: ORCA refused or stopped it, its channel
   * to the holder closed, bubblewrap exited, or the time for it is up. The setup asks this
   * after everything it waited for, right before it has the executor started, and right
   * before it says the isolation is shown and sends what was waiting.
   */
  const over = (): string | undefined =>
    refused ??
    (closed
      ? "ORCA's channel to the holder closed before the isolation was shown"
      : clock() >= cutoff
        ? late()
        : undefined);

  const reads: CodexExecSetupReads = spec.reads ?? {
    readdir: (path) => readdir(path),
    stat: (path) => stat(path, { bigint: true }),
  };
  /**
   * One read of a file system for this setup. It is counted from when it is asked of the
   * file system until it is back, which may be long after the setup is over, or never.
   */
  const outside = <T>(read: () => Promise<T>): Promise<T> => {
    queued = readsOut >= CODEX_EXEC_READS_AT_ONCE;
    return readOutside(
      () => {
        queued = false;
        reading += 1;
        return (async () => read())().finally(() => {
          reading -= 1;
          if (reading > 0 || closeAfterReads === undefined) return;
          closeSync(closeAfterReads);
          closeAfterReads = undefined;
        });
      },
      setup.signal,
      over,
    );
  };

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
      void whenRefused.then(resolve);
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
    let namespaces: { pid: string; mnt: string; user: string; net: string };
    let status: string;
    try {
      status = statusOf(`${at}/status`);
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
      // The network is the one that was asked for, as the kernel names it: ORCA's, or one
      // that is not ORCA's. Bubblewrap's having been told is not what is believed.
      if ((namespaces.net === mine.net) !== (network === "host"))
        wrong(
          network === "host"
            ? "the holder is not in ORCA's network namespace"
            : "the holder is in ORCA's own network namespace",
        );
      if (codexExecProcessSeen(at) !== "there") wrong("the holder is not there");
    } catch (error) {
      closeSync(candidate!.fd);
      throw error;
    }
    first = { pid: named as number, ...candidate! };
    const holder = first;

    if (!/^0+$/.test(field(status, "CapEff")[0] ?? "")) wrong("the holder holds capabilities over its namespace");
    // Asked of the holder, before it is asked to start anything: on a system where a program
    // could gain privileges from a file it runs, the executor is never run at all. The
    // executor inherits this, and is asked again below before it is sent anything.
    if (field(status, "NoNewPrivs")[0] !== "1") wrong("the holder could gain privileges from a file it runs");

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
      // These leave `/proc` for the file systems the path crosses, which can be slow to answer
      // or never answer. They are made off ORCA's thread, one at a time, and a setup that is
      // refused while one is out is over then: see `outside`.
      const listed = await outside(() => reads.readdir(`${at}/root${path}`));
      stillThere(holder);
      const through = await outside(() => reads.stat(`${at}/root${path}`));
      stillThere(holder);
      const real = await outside(() => reads.stat(path));
      stillThere(holder);
      if (listed.length > 0) wrong(`a hidden directory is not empty: ${path}`);
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
    // Asked here, with nothing between the question and the request: is the setup over, or late?
    stillThere(holder);
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
      const itsStatus = statusOf(`${theirs!.directory}/status`);
      if (!/^0+$/.test(field(itsStatus, "CapEff")[0] ?? ""))
        wrong("the executor holds capabilities over its namespace");
      // No file the executor or a command runs gives it more than it has: a program that
      // acts as another user for whoever runs it (sudo, a policy agent's helper) does not.
      if (field(itsStatus, "NoNewPrivs")[0] !== "1") wrong("the executor could gain privileges from a file it runs");
      const its = namespacesOf(theirs!.directory);
      for (const kind of ["pid", "mnt", "user", "net"] as const)
        if (its[kind] !== namespaces[kind]) wrong(`the executor is not in the holder's ${kind} namespace`);
      // The holder's channel is a socket, which no path opens. The executor was not handed it
      // either: ORCA has to have seen what each of its descriptors is to say so.
      const channel = readlinkSync(`${at}/fd/3`);
      for (const target of codexExecDescriptorsOf(theirs!.directory).values())
        if (target === channel) wrong("the executor holds the holder's channel");
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
      network,
      masks,
      ...(ptraceScope !== undefined && Number.isInteger(ptraceScope) ? { ptraceScope } : {}),
    };
  };

  const isolated = (async (): Promise<CodexExecIsolationProof> => {
    let proof: CodexExecIsolationProof;
    try {
      // A refusal settles this by itself, whatever the showing is still waiting for and
      // whether or not that ever comes. What the showing comes to after a refusal is not
      // looked at: it finds the setup over at its next step, and nothing here hears of it.
      const outcome = await Promise.race([prove(), whenRefused]);
      // Asked once more, here where the isolation would be said to be shown. Nothing is waited
      // for between this and what follows it: the proof, and the sending of what was waiting.
      const why = over();
      if (why !== undefined) throw new CodexExecIsolationError(why);
      if (outcome === undefined) throw new CodexExecIsolationError("the executor's isolation could not be shown");
      proof = outcome;
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
  core.onExit((detail) => {
    // A namespace that ended before it was shown is a setup that is over, here and now.
    refuse(
      making
        ? `the executor's namespace could not be made: bubblewrap ended (${detail})`
        : `the executor's namespace ended before its isolation was shown (${detail})`,
    );
    clearTimeout(deadline);
    dropWaiting();
    lost();
    // The exit was judged, through this descriptor, before any listener heard of it.
    letGoOfFirst();
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
