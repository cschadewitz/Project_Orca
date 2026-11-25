/**
 * The Codex IPC caveat (#1026): which of the host's communication endpoints a process of the
 * agent's user can reach, read once when an opted-in Codex session opens, so that ORCA can say
 * so beside the opt-in. **It is a diagnostic, not a control or a proof.** It changes nothing
 * about what the agent may do, it can miss a connection the agent inherited and an endpoint made
 * after it ran, and an empty answer says only that none was found: "None detected at startup;
 * isolation has not been verified."
 *
 * What it reads, and nothing else:
 *
 * - **Unix sockets** listening in ORCA's network namespace (`/proc/net/unix`): one with a path
 *   when this user may connect to it, and every abstract one (the kernel checks no permission
 *   on those).
 * - **TCP** listening in that namespace (`/proc/net/tcp`, `/proc/net/tcp6`), on any address.
 * - **Named pipes** this user may write, under the per-user runtime directory, `/tmp`,
 *   `/var/tmp`, `/dev/shm` and the home directory, a few levels down. A pipe elsewhere is not
 *   looked for; the result says where it looked.
 *
 * Whatever of that could not be read, or was cut short, is named as incomplete.
 */
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
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
  readFile: (path: string) => string;
  /** Names in a directory, each with whether it is a directory, a FIFO, or neither. */
  readdir: (path: string) => { name: string; type: "dir" | "fifo" | "other" }[];
  /** Whether this user may write (connect to) the path. */
  writable: (path: string) => boolean;
}

const realReads: HostIpcReads = {
  readFile: (path) => readFileSync(path, "utf8"),
  readdir: (path) =>
    readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      // A link is not followed: what it leads to is somewhere else, looked at there or not.
      type: entry.isDirectory() ? "dir" : entry.isFIFO() ? "fifo" : "other",
    })),
  writable: (path) => {
    try {
      // A socket's path that is gone (the table keeps the name it was bound to) is not counted.
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** How deep under each directory named pipes are looked for, and how many entries at most. */
export const HOST_IPC_PIPE_DEPTH = 3;
export const HOST_IPC_PIPE_ENTRIES = 20_000;

/** `__SO_ACCEPTCON` in `/proc/net/unix`'s flags: the socket listens. */
const LISTENING = 0x10000;

function unixSockets(reads: HostIpcReads, incomplete: string[]): HostIpcEndpoint[] {
  let table: string;
  try {
    table = reads.readFile("/proc/net/unix");
  } catch (error) {
    incomplete.push(`unix sockets: /proc/net/unix could not be read (${code(error)})`);
    return [];
  }
  const found: HostIpcEndpoint[] = [];
  for (const line of table.split("\n").slice(1)) {
    // Num RefCount Protocol Flags Type St Inode [Path]; a path may hold spaces.
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const flags = Number.parseInt(fields[3]!, 16);
    if (!Number.isFinite(flags) || (flags & LISTENING) === 0) continue;
    const path = line.trim().split(/\s+/).slice(7).join(" ");
    if (path.startsWith("@")) found.push({ kind: "abstract-socket", name: path });
    else if (path.startsWith("/") && reads.writable(path)) found.push({ kind: "unix-socket", name: path });
  }
  return found;
}

function tcpListeners(reads: HostIpcReads, incomplete: string[]): HostIpcEndpoint[] {
  const found: HostIpcEndpoint[] = [];
  for (const [file, v6] of [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true],
  ] as const) {
    let table: string;
    try {
      table = reads.readFile(file);
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
      found.push({ kind: "tcp", name: `${v6 ? ipv6(address) : ipv4(address)}:${Number.parseInt(port, 16)}` });
    }
  }
  return found;
}

function namedPipes(
  roots: string[],
  reads: HostIpcReads,
  incomplete: string[],
): { found: HostIpcEndpoint[]; searched: string[] } {
  const found: HostIpcEndpoint[] = [];
  const searched: string[] = [];
  let entries = 0;
  let cut = false;
  const walk = (dir: string, depth: number): void => {
    let listing: ReturnType<HostIpcReads["readdir"]>;
    try {
      listing = reads.readdir(dir);
    } catch (error) {
      // A directory this user cannot list holds nothing it can name to write to, except by a
      // name it already knows; say so for the roots, where it matters.
      if (depth === 0) incomplete.push(`named pipes: ${dir} could not be listed (${code(error)})`);
      return;
    }
    for (const entry of listing) {
      if (++entries > HOST_IPC_PIPE_ENTRIES) {
        cut = true;
        return;
      }
      const path = join(dir, entry.name);
      if (entry.type === "fifo" && reads.writable(path)) found.push({ kind: "named-pipe", name: path });
      else if (entry.type === "dir" && depth + 1 < HOST_IPC_PIPE_DEPTH) walk(path, depth + 1);
      if (cut) return;
    }
  };
  for (const root of roots) {
    if (cut) break;
    searched.push(root);
    walk(root, 0);
  }
  if (cut)
    incomplete.push(`named pipes: the search stopped after ${HOST_IPC_PIPE_ENTRIES} entries, in ${searched.at(-1)}`);
  return { found, searched };
}

/** Read the host's endpoints now. `env` is the environment the agent is started with. */
export function hostIpcInventory(
  env: Readonly<Record<string, string | undefined>>,
  reads: HostIpcReads = realReads,
): HostIpcInventory {
  const incomplete: string[] = [];
  const roots = [
    ...new Set(
      [env["XDG_RUNTIME_DIR"], "/tmp", "/var/tmp", "/dev/shm", env["HOME"]].filter(
        (dir): dir is string => dir !== undefined && dir.startsWith("/"),
      ),
    ),
  ];
  const pipes = namedPipes(roots, reads, incomplete);
  // A directory under two roots (one inside `/tmp`, say) is looked through twice: one entry each.
  const seen = new Set<string>();
  const endpoints = [...unixSockets(reads, incomplete), ...tcpListeners(reads, incomplete), ...pipes.found].filter(
    (endpoint) => {
      const key = `${endpoint.kind} ${endpoint.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
  return { endpoints, pipesSearched: pipes.searched, incomplete };
}

/** How many endpoints the caveat names before it gives a count. */
const NAMED = 8;

/** The caveat ORCA says beside the opt-in, from an inventory. */
export function hostIpcCaveat(inventory: HostIpcInventory): string {
  const where =
    `Checked: unix sockets and TCP listening in ORCA's network namespace, and named pipes under ` +
    `${inventory.pipesSearched.join(", ") || "no directory"}.`;
  const unfinished =
    inventory.incomplete.length === 0 ? "" : ` The check was incomplete: ${inventory.incomplete.join("; ")}.`;
  if (inventory.endpoints.length === 0)
    return `None detected at startup; isolation has not been verified. ${where}${unfinished}`;
  const named = inventory.endpoints.slice(0, NAMED).map((endpoint) => `${endpoint.kind} ${endpoint.name}`);
  const more = inventory.endpoints.length - named.length;
  return (
    `Codex's processes run as this user and can reach ${inventory.endpoints.length} host communication ` +
    `endpoint${inventory.endpoints.length === 1 ? "" : "s"} found at startup: ${named.join(", ")}` +
    `${more > 0 ? `, and ${more} more` : ""}. What a command sends through them is not seen by ORCA's hook. ` +
    `This is an inventory, not isolation: it can miss inherited connections and endpoints made later. ${where}${unfinished}`
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
