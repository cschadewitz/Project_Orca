/**
 * The Codex IPC caveat (#1026): potential host communication endpoints, **observed from the ORCA
 * daemon** once when an opted-in Codex session opens, so that ORCA can say so beside the opt-in.
 * **It is a diagnostic, not a control or a proof.** Every read and permission check runs in the
 * daemon, not inside Codex's command sandbox, so it says nothing about what that sandbox lets a
 * command reach: sandbox reachability is not tested. It changes nothing about what the agent may
 * do, it can miss a connection the agent inherited and an endpoint made after it ran, and an empty
 * answer says only that none was found where it looked: "None detected at startup; isolation has
 * not been verified."
 *
 * Where it looks, and nothing else:
 *
 * - **Unix sockets** listening in the daemon's network namespace (`/proc/net/unix`): one with a
 *   path when the daemon's user may open it for writing, and every abstract one.
 * - **TCP** listening in that namespace (`/proc/net/tcp`, `/proc/net/tcp6`), on any address.
 * - **Named pipes** the daemon's user may write, under the per-user runtime directory, `/tmp`,
 *   `/var/tmp`, `/dev/shm` and the home directory, `HOST_IPC_PIPE_DEPTH` levels down and
 *   `HOST_IPC_PIPE_ENTRIES` entries at most.
 *
 * Not looked for: named pipes anywhere else, UDP, and connections the agent inherited. Whatever
 * in its scope could not be read (a table, a directory at any depth), was cut short by the entry
 * cap, or was left when the deadline passed, is named as incomplete. All of it is asynchronous,
 * one directory entry at a time, and stops at its deadline or when its signal aborts.
 */
import { access, constants, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** One endpoint found. */
export interface HostIpcEndpoint {
  kind: "unix-socket" | "abstract-socket" | "tcp" | "named-pipe";
  /** A path, `@name` for an abstract socket, or `address:port` for TCP. */
  name: string;
}

/** What was found, where pipes were looked for, and what could not be checked. */
export interface HostIpcInventory {
  endpoints: HostIpcEndpoint[];
  pipesSearched: string[];
  incomplete: string[];
}

/** How the inventory reads the host; the real file system unless a test gives another. */
export interface HostIpcReads {
  readFile: (path: string) => Promise<string>;
  /** A directory's entries, one at a time, each a directory, a FIFO, or neither. Links are not followed. */
  readdir: (path: string) => AsyncIterable<{ name: string; type: "dir" | "fifo" | "other" }>;
  /** Whether the daemon's user may open the path for writing (connect to it, for a socket). */
  writable: (path: string) => Promise<boolean>;
}

const realReads: HostIpcReads = {
  readFile: (path) => readFile(path, "utf8"),
  readdir: async function* (path) {
    // `opendir` reads the directory a batch at a time, so a huge one is not read whole first.
    for await (const entry of await opendir(path, { bufferSize: 64 }))
      yield { name: entry.name, type: entry.isDirectory() ? "dir" : entry.isFIFO() ? "fifo" : "other" };
  },
  writable: async (path) => {
    try {
      // A socket's path that is gone (the table keeps the name it was bound to) is not counted.
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** How deep under each directory named pipes are looked for, and how many entries at most. */
export const HOST_IPC_PIPE_DEPTH = 3;
export const HOST_IPC_PIPE_ENTRIES = 20_000;
/** How long the whole inventory may take before what is left is named incomplete. */
export const HOST_IPC_DEADLINE_MS = 5_000;
/** How many unlistable directories are named before a count. */
const UNLISTED_NAMED = 5;

/** `__SO_ACCEPTCON` in `/proc/net/unix`'s flags: the socket listens. */
const LISTENING = 0x10000;

export interface HostIpcInventoryOptions {
  reads?: HostIpcReads | undefined;
  /** `HOST_IPC_DEADLINE_MS` unless given. */
  deadlineMs?: number | undefined;
  /** Stops the inventory early (the session closed); what is left is named incomplete. */
  signal?: AbortSignal | undefined;
}

/**
 * Look now, from the daemon. `env` is the environment the agent is started with. Never
 * rejects: a failure, the deadline and an abort each come back as an incomplete result.
 */
export async function hostIpcInventory(
  env: Readonly<Record<string, string | undefined>>,
  options: HostIpcInventoryOptions = {},
): Promise<HostIpcInventory> {
  const reads = options.reads ?? realReads;
  const deadlineMs = options.deadlineMs ?? HOST_IPC_DEADLINE_MS;
  const stop = AbortSignal.any([
    AbortSignal.timeout(deadlineMs),
    ...(options.signal !== undefined ? [options.signal] : []),
  ]);
  const why = () =>
    options.signal?.aborted ? "the session ended first" : `the inventory's ${deadlineMs} ms deadline passed`;
  const incomplete: string[] = [];
  const endpoints: HostIpcEndpoint[] = [];
  const seen = new Set<string>();
  const add = (endpoint: HostIpcEndpoint) => {
    // A directory under two roots (one inside `/tmp`, say) is looked through twice: one entry each.
    const key = `${endpoint.kind} ${endpoint.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(endpoint);
  };
  const roots = [
    ...new Set(
      [env["XDG_RUNTIME_DIR"], "/tmp", "/var/tmp", "/dev/shm", env["HOME"]].filter(
        (dir): dir is string => dir !== undefined && dir.startsWith("/"),
      ),
    ),
  ];
  const pipesSearched: string[] = [];
  const work = (async () => {
    await unixSockets(reads, stop, add, incomplete, why);
    await tcpListeners(reads, stop, add, incomplete, why);
    await namedPipes(roots, reads, stop, add, incomplete, why, pipesSearched);
  })().catch((error: unknown) => {
    incomplete.push(`the inventory failed (${error instanceof Error ? error.message : String(error)})`);
  });
  // The work stops itself at the deadline; this keeps a read that never returns from holding
  // the answer past it.
  let late!: () => void;
  const timedOut = new Promise<"late">((resolve) => {
    late = () => resolve("late");
    if (stop.aborted) late();
    else stop.addEventListener("abort", late, { once: true });
  });
  const ended = await Promise.race([work.then(() => "done" as const), timedOut]);
  stop.removeEventListener("abort", late);
  // One turn for the work to notice the stop and say where it was, if it is not stuck in a read.
  if (ended === "late") await Promise.race([work, new Promise((resolve) => setImmediate(resolve))]);
  if (ended === "late" && !incomplete.some((entry) => entry.startsWith("stopped:")))
    incomplete.push(`stopped: ${why()} before the inventory finished`);
  return { endpoints: [...endpoints], pipesSearched: [...pipesSearched], incomplete: [...incomplete] };
}

async function unixSockets(
  reads: HostIpcReads,
  stop: AbortSignal,
  add: (endpoint: HostIpcEndpoint) => void,
  incomplete: string[],
  why: () => string,
): Promise<void> {
  let table: string;
  try {
    table = await reads.readFile("/proc/net/unix");
  } catch (error) {
    incomplete.push(`unix sockets: /proc/net/unix could not be read (${code(error)})`);
    return;
  }
  for (const line of table.split("\n").slice(1)) {
    if (stop.aborted) {
      incomplete.push(`stopped: ${why()} while unix sockets were checked`);
      return;
    }
    // Num RefCount Protocol Flags Type St Inode [Path]; a path may hold spaces.
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const flags = Number.parseInt(fields[3]!, 16);
    if (!Number.isFinite(flags) || (flags & LISTENING) === 0) continue;
    const path = fields.slice(7).join(" ");
    if (path.startsWith("@")) add({ kind: "abstract-socket", name: path });
    else if (path.startsWith("/") && (await reads.writable(path))) add({ kind: "unix-socket", name: path });
  }
}

async function tcpListeners(
  reads: HostIpcReads,
  stop: AbortSignal,
  add: (endpoint: HostIpcEndpoint) => void,
  incomplete: string[],
  why: () => string,
): Promise<void> {
  for (const [file, v6] of [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true],
  ] as const) {
    if (stop.aborted) {
      incomplete.push(`stopped: ${why()} before TCP was checked`);
      return;
    }
    let table: string;
    try {
      table = await reads.readFile(file);
    } catch (error) {
      // A kernel without IPv6 has no tcp6 table, and so no IPv6 listener to miss.
      if (v6 && code(error) === "ENOENT") continue;
      incomplete.push(`TCP: ${file} could not be read (${code(error)})`);
      continue;
    }
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // sl local_address rem_address st ...; 0A is LISTEN.
      if (fields.length < 4 || fields[3] !== "0A") continue;
      const [address, port] = fields[1]!.split(":");
      if (address === undefined || port === undefined) continue;
      add({ kind: "tcp", name: `${v6 ? ipv6(address) : ipv4(address)}:${Number.parseInt(port, 16)}` });
    }
  }
}

async function namedPipes(
  roots: string[],
  reads: HostIpcReads,
  stop: AbortSignal,
  add: (endpoint: HostIpcEndpoint) => void,
  incomplete: string[],
  why: () => string,
  searched: string[],
): Promise<void> {
  let entries = 0;
  let ended: string | undefined;
  const unlisted: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    try {
      for await (const entry of reads.readdir(dir)) {
        if (stop.aborted) {
          ended ??= `stopped: ${why()} while named pipes were looked for, in ${dir}`;
          return;
        }
        if (++entries > HOST_IPC_PIPE_ENTRIES) {
          ended ??= `named pipes: the search stopped after ${HOST_IPC_PIPE_ENTRIES} entries, in ${dir}`;
          return;
        }
        const path = join(dir, entry.name);
        if (entry.type === "fifo" && (await reads.writable(path))) add({ kind: "named-pipe", name: path });
        else if (entry.type === "dir" && depth + 1 < HOST_IPC_PIPE_DEPTH) await walk(path, depth + 1);
        if (ended !== undefined) return;
      }
    } catch (error) {
      // At any depth: a directory skipped is a part of the scope not looked through.
      unlisted.push(`${dir} (${code(error)})`);
    }
  };
  for (const root of roots) {
    if (ended !== undefined) break;
    searched.push(root);
    await walk(root, 0);
  }
  if (unlisted.length > 0)
    incomplete.push(
      `named pipes: ${unlisted.length} director${unlisted.length === 1 ? "y" : "ies"} could not be listed: ` +
        unlisted.slice(0, UNLISTED_NAMED).join(", ") +
        (unlisted.length > UNLISTED_NAMED ? `, and ${unlisted.length - UNLISTED_NAMED} more` : ""),
    );
  if (ended !== undefined) incomplete.push(ended);
}

/** How many endpoints the caveat names before it gives a count. */
const NAMED = 8;

/** The caveat ORCA says beside the opt-in, from an inventory. */
export function hostIpcCaveat(inventory: HostIpcInventory): string {
  const scope =
    `Searched from the ORCA daemon: unix sockets (abstract ones, and path ones the daemon's user may open ` +
    `for writing) and TCP listeners in the daemon's network namespace, and named pipes the daemon's user ` +
    `may write under ${inventory.pipesSearched.join(", ") || "no directory"} (${HOST_IPC_PIPE_DEPTH} levels, ` +
    `${HOST_IPC_PIPE_ENTRIES} entries at most). Not searched: named pipes elsewhere, UDP, and connections the ` +
    `agent inherited.`;
  const unfinished =
    inventory.incomplete.length === 0 ? "" : ` The check was incomplete: ${inventory.incomplete.join("; ")}.`;
  if (inventory.endpoints.length === 0)
    return (
      `None detected at startup; isolation has not been verified. No potential host communication endpoint was ` +
      `observed from the ORCA daemon where it looked; sandbox reachability was not tested. ${scope}${unfinished}`
    );
  const named = inventory.endpoints.slice(0, NAMED).map((endpoint) => `${endpoint.kind} ${endpoint.name}`);
  const more = inventory.endpoints.length - named.length;
  return (
    `${inventory.endpoints.length} potential host communication endpoint${inventory.endpoints.length === 1 ? "" : "s"} ` +
    `observed from the ORCA daemon at startup; sandbox reachability was not tested: ${named.join(", ")}` +
    `${more > 0 ? `, and ${more} more` : ""}. A command Codex runs may be able to use them without a tool ` +
    `call ORCA's hook sees. This is an inventory, not isolation: it can miss inherited connections and ` +
    `endpoints made later. ${scope}${unfinished}`
  );
}

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "error";
}

/** `/proc/net/tcp`'s address: four bytes in host order (little-endian on x64). */
function ipv4(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes
    .map((byte) => Number.parseInt(byte, 16))
    .reverse()
    .join(".");
}

/** `/proc/net/tcp6`'s address: four 32-bit words, each in host order. */
function ipv6(hex: string): string {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse());
  const groups: string[] = [];
  for (let i = 0; i < bytes.length; i += 2) groups.push(`${bytes[i]}${bytes[i + 1]}`.replace(/^0{1,3}/, ""));
  return `[${groups.join(":")}]`;
}
