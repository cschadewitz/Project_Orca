/**
 * The Codex IPC caveat (#1026): potential host communication endpoints observed from the ORCA
 * daemon when an opted-in Codex session opens, and the warning made of them. A diagnostic: these
 * tests show where it looks, how it says what it could not check, that it stops at its deadline,
 * and how it is worded; not that anything is isolated or reachable from Codex's sandbox.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_IPC_PIPE_DEPTH,
  HOST_IPC_PIPE_ENTRIES,
  hostIpcCaveat,
  hostIpcInventory,
  type HostIpcReads,
} from "../src/host-ipc-inventory.js";

const UNIX_HEADER = "Num       RefCount Protocol Flags    Type St Inode Path";
const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

type Entry = { name: string; type: "dir" | "fifo" | "other" };

/** A host made of the tables and directories given. */
function fakeHost(opts: {
  unix?: string[] | Error;
  tcp?: string[] | Error;
  tcp6?: string[] | Error;
  dirs?: Record<string, Entry[] | Error | (() => AsyncIterable<Entry>)>;
  writable?: (path: string) => boolean;
}): HostIpcReads {
  const table = (header: string, rows: string[] | Error | undefined) => {
    if (rows instanceof Error) throw rows;
    return [header, ...(rows ?? [])].join("\n") + "\n";
  };
  return {
    readFile: async (path) => {
      if (path === "/proc/net/unix") return table(UNIX_HEADER, opts.unix);
      if (path === "/proc/net/tcp") return table(TCP_HEADER, opts.tcp);
      if (path === "/proc/net/tcp6") return table(TCP_HEADER, opts.tcp6);
      throw errno("ENOENT");
    },
    readdir: (path) => {
      const listing = opts.dirs?.[path];
      if (typeof listing === "function") return listing();
      return (async function* () {
        if (listing instanceof Error) throw listing;
        yield* listing ?? [];
      })();
    },
    writable: async (path) => (opts.writable ?? (() => true))(path),
  };
}
const errno = (code: string) => Object.assign(new Error(code), { code });
const ENV = { XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/u" };
const ROOTS = ["/run/user/1000", "/tmp", "/var/tmp", "/dev/shm", "/home/u"];

describe("where the inventory looks", () => {
  it("counts listening unix sockets the daemon's user may open, every abstract one, and nothing else", async () => {
    const inventory = await hostIpcInventory(ENV, {
      reads: fakeHost({
        unix: [
          "0000000000000001: 00000002 00000000 00010000 0001 01  101 /run/user/1000/bus",
          "0000000000000002: 00000002 00000000 00010000 0001 01  102 /run/root-only.sock",
          "0000000000000003: 00000002 00000000 00010000 0001 01  103 @/tmp/.X11-unix/X0",
          // Connected, not listening: one end of a conversation, not an endpoint.
          "0000000000000004: 00000003 00000000 00000000 0001 03  104 /run/user/1000/connected",
          "0000000000000005: 00000003 00000000 00000000 0001 03  105",
          "0000000000000006: 00000002 00000000 00010000 0001 01  106 /tmp/with space.sock",
        ],
        writable: (path) => path !== "/run/root-only.sock",
      }),
    });
    expect(inventory.endpoints).toEqual([
      { kind: "unix-socket", name: "/run/user/1000/bus" },
      { kind: "abstract-socket", name: "@/tmp/.X11-unix/X0" },
      { kind: "unix-socket", name: "/tmp/with space.sock" },
    ]);
    expect(inventory.incomplete).toEqual([]);
  });

  it("counts TCP listeners on any address, IPv4 and IPv6", async () => {
    const inventory = await hostIpcInventory(ENV, {
      reads: fakeHost({
        tcp: [
          "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1",
          "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1",
          // Established, not listening.
          "   2: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1",
        ],
        tcp6: [
          "   0: 00000000000000000000000001000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 4 1",
        ],
      }),
    });
    expect(inventory.endpoints).toEqual([
      { kind: "tcp", name: "127.0.0.1:8080" },
      { kind: "tcp", name: "0.0.0.0:22" },
      { kind: "tcp", name: "[0:0:0:0:0:0:0:1]:80" },
    ]);
  });

  it("looks for named pipes the daemon's user may write, under the runtime directory, the temporary ones and home", async () => {
    const inventory = await hostIpcInventory(ENV, {
      reads: fakeHost({
        dirs: {
          "/run/user/1000": [
            { name: "pipe", type: "fifo" },
            { name: "deep", type: "dir" },
          ],
          "/run/user/1000/deep": [{ name: "deeper", type: "dir" }],
          "/run/user/1000/deep/deeper": [
            { name: "found", type: "fifo" },
            { name: "deepest", type: "dir" },
          ],
          "/run/user/1000/deep/deeper/deepest": [{ name: "too-deep", type: "fifo" }],
          "/tmp": [
            { name: "theirs", type: "fifo" },
            { name: "file", type: "other" },
          ],
        },
        writable: (path) => path !== "/tmp/theirs",
      }),
    });
    expect(HOST_IPC_PIPE_DEPTH).toBe(3);
    expect(inventory.endpoints).toEqual([
      { kind: "named-pipe", name: "/run/user/1000/pipe" },
      { kind: "named-pipe", name: "/run/user/1000/deep/deeper/found" },
    ]);
    expect(inventory.pipesSearched).toEqual(ROOTS);
    expect(inventory.incomplete).toEqual([]);
  });
});

describe("what it could not check", () => {
  it("names unreadable tables and every directory it could not list, at any depth", async () => {
    const inventory = await hostIpcInventory(
      { HOME: "relative" },
      {
        reads: fakeHost({
          unix: errno("EACCES"),
          tcp: errno("EACCES"),
          tcp6: errno("ENOENT"),
          dirs: {
            "/tmp": [
              { name: "a", type: "dir" },
              { name: "b", type: "dir" },
            ],
            "/tmp/a": errno("EACCES"),
            "/tmp/b": errno("EACCES"),
            "/var/tmp": errno("ENOENT"),
          },
        }),
      },
    );
    // A home that is not an absolute path is not looked through, and so not listed as searched.
    expect(inventory.pipesSearched).toEqual(["/tmp", "/var/tmp", "/dev/shm"]);
    expect(inventory.endpoints).toEqual([]);
    expect(inventory.incomplete).toEqual([
      "unix sockets: /proc/net/unix could not be read (EACCES)",
      "TCP: /proc/net/tcp could not be read (EACCES)",
      "named pipes: 3 directories could not be listed: /tmp/a (EACCES), /tmp/b (EACCES), /var/tmp (ENOENT)",
    ]);
    // Nothing found and the check incomplete: the warning says both.
    expect(hostIpcCaveat(inventory)).toMatch(
      /^None detected at startup; isolation has not been verified\. .* The check was incomplete: unix sockets: .*named pipes: 3 directories could not be listed: .*\(ENOENT\)\.$/,
    );
  });

  it("says where it stopped when there are too many entries to look through", async () => {
    const many = Array.from({ length: HOST_IPC_PIPE_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}`,
      type: "other" as const,
    }));
    const inventory = await hostIpcInventory(ENV, { reads: fakeHost({ dirs: { "/run/user/1000": many } }) });
    expect(inventory.pipesSearched).toEqual(["/run/user/1000"]);
    expect(inventory.incomplete).toEqual([
      `named pipes: the search stopped after ${HOST_IPC_PIPE_ENTRIES} entries, in /run/user/1000`,
    ]);
  });

  it("answers at its deadline, with what it had, when a read never returns", async () => {
    const started = Date.now();
    const inventory = await hostIpcInventory(ENV, {
      deadlineMs: 50,
      reads: fakeHost({
        dirs: {
          "/run/user/1000": () =>
            (async function* () {
              yield { name: "pipe", type: "fifo" as const };
              await new Promise(() => undefined);
            })(),
        },
      }),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(inventory.endpoints).toEqual([{ kind: "named-pipe", name: "/run/user/1000/pipe" }]);
    expect(inventory.incomplete).toEqual([
      "stopped: the inventory's 50 ms deadline passed before the inventory finished",
    ]);
  });

  it("stops between entries when the session ends, and says so", async () => {
    const ended = new AbortController();
    const inventory = await hostIpcInventory(ENV, {
      signal: ended.signal,
      reads: fakeHost({
        dirs: {
          "/run/user/1000": () =>
            (async function* () {
              yield { name: "first", type: "fifo" as const };
              ended.abort();
              yield { name: "second", type: "fifo" as const };
            })(),
        },
      }),
    });
    expect(inventory.endpoints).toEqual([{ kind: "named-pipe", name: "/run/user/1000/first" }]);
    expect(inventory.incomplete).toEqual([
      "stopped: the session ended first while named pipes were looked for, in /run/user/1000",
    ]);
  });

  it("turns a failure it did not expect into an incomplete answer, never a rejection", async () => {
    const inventory = await hostIpcInventory(ENV, {
      reads: {
        ...fakeHost({}),
        readFile: async () => `${UNIX_HEADER}\n0000000000000001: 00000002 00000000 00010000 0001 01  101 /run/s\n`,
        writable: () => Promise.reject(new Error("broken")),
      },
    });
    expect(inventory.incomplete).toEqual(["the inventory failed (broken)"]);
  });
});

describe("the caveat", () => {
  const scope =
    "Searched from the ORCA daemon: unix sockets (abstract ones, and path ones the daemon's user may open for " +
    "writing) and TCP listeners in the daemon's network namespace, and named pipes the daemon's user may write " +
    `under /run/user/1000, /tmp (3 levels, ${HOST_IPC_PIPE_ENTRIES} entries at most). Not searched: named pipes ` +
    "elsewhere, UDP, and connections the agent inherited.";

  it("says exactly that none was detected, that isolation has not been verified, and what it measured", () => {
    expect(hostIpcCaveat({ endpoints: [], pipesSearched: ["/run/user/1000", "/tmp"], incomplete: [] })).toBe(
      "None detected at startup; isolation has not been verified. No potential host communication endpoint was " +
        "observed from the ORCA daemon where it looked; sandbox reachability was not tested. " +
        scope,
    );
  });

  it("names what it found as potential endpoints observed from the daemon, a few by name", () => {
    const endpoints = Array.from({ length: 10 }, (_, i) => ({ kind: "unix-socket" as const, name: `/run/s${i}` }));
    expect(hostIpcCaveat({ endpoints, pipesSearched: ["/run/user/1000", "/tmp"], incomplete: [] })).toBe(
      "10 potential host communication endpoints observed from the ORCA daemon at startup; sandbox reachability " +
        "was not tested: " +
        endpoints
          .slice(0, 8)
          .map((e) => `unix-socket ${e.name}`)
          .join(", ") +
        ", and 2 more. A command Codex runs may be able to use them without a tool call ORCA's hook sees. This " +
        "is an inventory, not isolation: it can miss inherited connections and endpoints made later. " +
        scope,
    );
    expect(
      hostIpcCaveat({
        endpoints: [endpoints[0]!],
        pipesSearched: ["/run/user/1000", "/tmp"],
        incomplete: ["TCP: /proc/net/tcp6 could not be read (EACCES)"],
      }),
    ).toMatch(
      /^1 potential host communication endpoint observed .*: unix-socket \/run\/s0\. .* The check was incomplete: TCP: \/proc\/net\/tcp6 could not be read \(EACCES\)\.$/,
    );
  });
});

describe.skipIf(process.platform !== "linux")("on this machine", () => {
  let dir: string | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds a socket listening and a named pipe it may write, not a pipe reached only by a link, once each", async () => {
    dir = await mkdtemp(join(tmpdir(), "orca-1026-ipc-"));
    const runtime = join(dir, "runtime");
    const elsewhere = join(dir, "elsewhere");
    await mkdir(runtime);
    await mkdir(elsewhere);
    const socket = join(runtime, "listening.sock");
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(socket, resolve));
    execFileSync("mkfifo", [join(runtime, "pipe")]);
    execFileSync("mkfifo", [join(elsewhere, "linked")]);
    await symlink(join(elsewhere, "linked"), join(runtime, "link"));
    const inventory = await hostIpcInventory({ XDG_RUNTIME_DIR: runtime, HOME: "/nonexistent-orca-home" });
    expect(inventory.endpoints).toContainEqual({ kind: "unix-socket", name: socket });
    expect(inventory.endpoints).toContainEqual({ kind: "named-pipe", name: join(runtime, "pipe") });
    // Under the runtime directory and under /tmp both, and named once.
    expect(inventory.endpoints.filter((e) => e.name === join(runtime, "pipe"))).toHaveLength(1);
    expect(inventory.endpoints.map((e) => e.name)).not.toContain(join(runtime, "link"));
    expect(inventory.pipesSearched[0]).toBe(runtime);
    expect(inventory.incomplete).toContainEqual(expect.stringContaining("/nonexistent-orca-home (ENOENT)"));
    expect(hostIpcCaveat(inventory)).toContain(`unix-socket ${socket}`);
  });
});
