/**
 * The Codex IPC caveat (#1026): the inventory of the host's communication endpoints read when an
 * opted-in Codex session opens, and the warning made of it. A diagnostic: these tests show what
 * it reads and how it says it, not that anything is isolated.
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

/** A host made of the tables and directories given. */
function fakeHost(opts: {
  unix?: string[] | Error;
  tcp?: string[] | Error;
  tcp6?: string[] | Error;
  dirs?: Record<string, { name: string; type: "dir" | "fifo" | "other" }[] | Error>;
  writable?: (path: string) => boolean;
}): HostIpcReads {
  const table = (header: string, rows: string[] | Error | undefined) => {
    if (rows instanceof Error) throw rows;
    return [header, ...(rows ?? [])].join("\n") + "\n";
  };
  return {
    readFile: (path) => {
      if (path === "/proc/net/unix") return table(UNIX_HEADER, opts.unix);
      if (path === "/proc/net/tcp") return table(TCP_HEADER, opts.tcp);
      if (path === "/proc/net/tcp6") return table(TCP_HEADER, opts.tcp6);
      throw Object.assign(new Error("no"), { code: "ENOENT" });
    },
    readdir: (path) => {
      const listing = opts.dirs?.[path];
      if (listing instanceof Error) throw listing;
      return listing ?? [];
    },
    writable: opts.writable ?? (() => true),
  };
}
const errno = (code: string) => Object.assign(new Error(code), { code });
const ENV = { XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/u" };

describe("what the inventory reads", () => {
  it("counts listening unix sockets this user may connect to, every abstract one, and nothing else", () => {
    const inventory = hostIpcInventory(
      ENV,
      fakeHost({
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
    );
    expect(inventory.endpoints).toEqual([
      { kind: "unix-socket", name: "/run/user/1000/bus" },
      { kind: "abstract-socket", name: "@/tmp/.X11-unix/X0" },
      { kind: "unix-socket", name: "/tmp/with space.sock" },
    ]);
    expect(inventory.incomplete).toEqual([]);
  });

  it("counts TCP listeners on any address, IPv4 and IPv6", () => {
    const inventory = hostIpcInventory(
      ENV,
      fakeHost({
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
    );
    expect(inventory.endpoints).toEqual([
      { kind: "tcp", name: "127.0.0.1:8080" },
      { kind: "tcp", name: "0.0.0.0:22" },
      { kind: "tcp", name: "[0:0:0:0:0:0:0:1]:80" },
    ]);
  });

  it("looks for named pipes this user may write, under the runtime directory, the temporary ones and home", () => {
    const inventory = hostIpcInventory(
      ENV,
      fakeHost({
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
    );
    expect(HOST_IPC_PIPE_DEPTH).toBe(3);
    expect(inventory.endpoints).toEqual([
      { kind: "named-pipe", name: "/run/user/1000/pipe" },
      { kind: "named-pipe", name: "/run/user/1000/deep/deeper/found" },
    ]);
    expect(inventory.pipesSearched).toEqual(["/run/user/1000", "/tmp", "/var/tmp", "/dev/shm", "/home/u"]);
  });

  it("names what it could not read, and leaves out a directory the environment does not name", () => {
    const inventory = hostIpcInventory(
      { HOME: "relative" },
      fakeHost({
        unix: errno("EACCES"),
        tcp: errno("EACCES"),
        tcp6: errno("ENOENT"),
        dirs: { "/tmp": errno("EACCES"), "/tmp/inner": errno("EACCES") },
      }),
    );
    expect(inventory.pipesSearched).toEqual(["/tmp", "/var/tmp", "/dev/shm"]);
    expect(inventory.incomplete).toEqual([
      "named pipes: /tmp could not be listed (EACCES)",
      "unix sockets: /proc/net/unix could not be read (EACCES)",
      "TCP: /proc/net/tcp could not be read (EACCES)",
    ]);
  });

  it("says where it stopped when there are too many entries to look through", () => {
    const many = Array.from({ length: HOST_IPC_PIPE_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}`,
      type: "other" as const,
    }));
    const inventory = hostIpcInventory(ENV, fakeHost({ dirs: { "/run/user/1000": many } }));
    expect(inventory.pipesSearched).toEqual(["/run/user/1000"]);
    expect(inventory.incomplete).toEqual([
      `named pipes: the search stopped after ${HOST_IPC_PIPE_ENTRIES} entries, in /run/user/1000`,
    ]);
  });
});

describe("the caveat", () => {
  const where =
    "Checked: unix sockets and TCP listening in ORCA's network namespace, and named pipes under /run/user/1000, /tmp.";

  it("says exactly that none was detected, and that isolation has not been verified", () => {
    expect(hostIpcCaveat({ endpoints: [], pipesSearched: ["/run/user/1000", "/tmp"], incomplete: [] })).toBe(
      `None detected at startup; isolation has not been verified. ${where}`,
    );
  });

  it("says the check was incomplete, and why, whether or not it found anything", () => {
    expect(
      hostIpcCaveat({
        endpoints: [],
        pipesSearched: ["/run/user/1000", "/tmp"],
        incomplete: ["unix sockets: /proc/net/unix could not be read (EACCES)"],
      }),
    ).toBe(
      `None detected at startup; isolation has not been verified. ${where} The check was incomplete: unix sockets: /proc/net/unix could not be read (EACCES).`,
    );
    expect(
      hostIpcCaveat({
        endpoints: [{ kind: "tcp", name: "127.0.0.1:8080" }],
        pipesSearched: ["/run/user/1000", "/tmp"],
        incomplete: ["TCP: /proc/net/tcp6 could not be read (EACCES)"],
      }),
    ).toMatch(/The check was incomplete: TCP: \/proc\/net\/tcp6 could not be read \(EACCES\)\.$/);
  });

  it("names what it found, a few by name, and that it is an inventory, not isolation", () => {
    const endpoints = Array.from({ length: 10 }, (_, i) => ({ kind: "unix-socket" as const, name: `/run/s${i}` }));
    const caveat = hostIpcCaveat({ endpoints, pipesSearched: ["/run/user/1000", "/tmp"], incomplete: [] });
    expect(caveat).toBe(
      "Codex's processes run as this user and can reach 10 host communication endpoints found at startup: " +
        endpoints
          .slice(0, 8)
          .map((e) => `unix-socket ${e.name}`)
          .join(", ") +
        ", and 2 more. What a command sends through them is not seen by ORCA's hook. This is an inventory, not " +
        `isolation: it can miss inherited connections and endpoints made later. ${where}`,
    );
    expect(
      hostIpcCaveat({ endpoints: [endpoints[0]!], pipesSearched: ["/run/user/1000", "/tmp"], incomplete: [] }),
    ).toContain("can reach 1 host communication endpoint found at startup: unix-socket /run/s0. ");
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

  it("finds a socket listening and a named pipe it may write, and not a pipe it reaches only by a link", async () => {
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
    const inventory = hostIpcInventory({ XDG_RUNTIME_DIR: runtime, HOME: "/nonexistent-orca-home" });
    expect(inventory.endpoints).toContainEqual({ kind: "unix-socket", name: socket });
    expect(inventory.endpoints).toContainEqual({ kind: "named-pipe", name: join(runtime, "pipe") });
    // Under the runtime directory and under /tmp both, and named once.
    expect(inventory.endpoints.filter((e) => e.name === join(runtime, "pipe"))).toHaveLength(1);
    expect(inventory.endpoints.map((e) => e.name)).not.toContain(join(runtime, "link"));
    expect(inventory.pipesSearched[0]).toBe(runtime);
    expect(hostIpcCaveat(inventory)).toContain(`unix-socket ${socket}`);
  });
});
