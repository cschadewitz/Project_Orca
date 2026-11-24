/**
 * The executor behind ORCA's gate in namespaces ORCA makes (#1026): what is masked, how it is
 * shown, how a directory is handed over, and what is left when the executor ends.
 *
 * The namespace tests run a stand-in executor (a shell that runs each line it is sent) under
 * the system's bubblewrap, so what they observe is the kernel's doing, not a fake's. They are
 * skipped where the system has no bubblewrap or does not let a plain process make a user
 * namespace, unless `ORCA_REQUIRE_EXEC_ISOLATION=1` says this machine has to have both, as
 * `codex-exec-gate-acceptance.yml` does. The real Codex executor runs in these namespaces in
 * `packages/cli/test/codex-exec-gate-acceptance-1026.test.ts`.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, readlinkSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_EXEC_READS_AT_ONCE,
  CodexExecIsolationError,
  codexExecClosedMounts,
  codexExecEnteredMounts,
  codexExecGateBinder,
  codexExecDescriptorsOf,
  codexExecMasks,
  CODEX_EXEC_OUTSIDE_VARIABLES,
  codexExecOutsideReach,
  codexExecProcessSeen,
  codexExecProofShortfalls,
  CODEX_EXEC_NOT_CLOSED,
  codexExecReadsOut,
  codexExecReadsWaiting,
  codexExecSocketFilter,
  parseMountInfo,
  spawnIsolatedCodexExecServer,
  systemBubblewrap,
  systemUnshare,
  type CodexExecIsolatedSpawn,
  type CodexExecIsolationProof,
  type CodexExecSetupReads,
} from "@orca/agents";

const BUBBLEWRAP = process.platform === "linux" ? systemBubblewrap() : undefined;
/** Whether this machine lets a plain process make the namespaces: tried once, with nothing in them. */
const USABLE =
  BUBBLEWRAP !== undefined &&
  spawnSync(BUBBLEWRAP, ["--unshare-user", "--unshare-pid", "--dev-bind", "/", "/", "--proc", "/proc", "/bin/true"])
    .status === 0;
const REQUIRED = process.env["ORCA_REQUIRE_EXEC_ISOLATION"] === "1";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orca-1026-isolation-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(process.platform !== "linux")("the masks for ORCA's protected paths", () => {
  it("hides what an agent may not read, binds a protected directory read-only, and lists what it cannot mask", async () => {
    const config = join(root, "config");
    const store = join(config, ".orca");
    for (const dir of ["auth", ".orca/private-execution", ".orca/work"])
      await mkdir(join(config, dir), { recursive: true });
    await writeFile(join(config, "orca.config.yaml"), "agents: []\n");
    await symlink(store, join(root, "store-link"));
    const masks = codexExecMasks({
      readOnly: [join(config, "orca.config.yaml"), join(config, "orca.permissions.json"), join(root, "store-link")],
      noAccess: [join(config, "auth"), join(store, "private-execution"), join(store, "diagnostics")],
      agentAreas: [join(store, "work"), join(store, "program")],
    });
    expect(masks.hidden).toEqual([join(config, "auth"), join(store, "private-execution")]);
    // A directory named through a link is masked where it really is.
    expect(masks.readOnly).toEqual([store]);
    expect(masks.writable).toEqual([join(store, "work")]);
    // A single file, and a path that is not there, cannot be masked: they are said, not dropped.
    expect(masks.unmasked).toEqual([
      join(store, "diagnostics"),
      join(config, "orca.config.yaml"),
      join(config, "orca.permissions.json"),
    ]);
  });

  it("binds a config directory read-only when asked, and shows nothing that is inside a hidden directory", async () => {
    const config = join(root, "config");
    await mkdir(join(config, "auth", "inner"), { recursive: true });
    const masks = codexExecMasks(
      {
        readOnly: [join(config, "auth", "inner")],
        noAccess: [join(config, "auth")],
        agentAreas: [join(root, "elsewhere")],
      },
      { readOnlyDirectories: [config] },
    );
    expect(masks).toEqual({ hidden: [join(config, "auth")], readOnly: [config], writable: [], unmasked: [] });
  });
});

describe("the mount table of a process", () => {
  it("reads each mount point as it is spelled, later mounts last", () => {
    const table = [
      "31 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
      "77 31 8:1 /home/u/my\\040store /home/u/my\\040store ro,relatime - ext4 /dev/sda1 rw",
      "78 77 0:55 / /home/u/my\\040store/private ro,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=755",
      "79 31 0:56 / /tab\\011and\\134slash rw master:3 shared:9 - tmpfs tmpfs rw",
      "not a mount line",
    ].join("\n");
    const mount = { root: "/", propagation: [] as string[] };
    expect(parseMountInfo(table)).toEqual([
      {
        ...mount,
        id: "31",
        parent: "1",
        point: "/",
        options: ["rw", "relatime"],
        type: "ext4",
        device: "8:1",
        propagation: ["shared:1"],
      },
      {
        ...mount,
        id: "77",
        parent: "31",
        point: "/home/u/my store",
        options: ["ro", "relatime"],
        type: "ext4",
        device: "8:1",
        root: "/home/u/my store",
      },
      {
        ...mount,
        id: "78",
        parent: "77",
        point: "/home/u/my store/private",
        options: ["ro", "nosuid", "nodev", "relatime"],
        type: "tmpfs",
        device: "0:55",
      },
      {
        ...mount,
        id: "79",
        parent: "31",
        point: "/tab\tand\\slash",
        options: ["rw"],
        type: "tmpfs",
        device: "0:56",
        propagation: ["master:3", "shared:9"],
      },
    ]);
  });
});

describe("what a closed executor is held to", () => {
  /** ORCA's own table: a disk with the home on a second file system, the host's devices, runtime and temporary directories, and another disk. */
  const mine = parseMountInfo(
    [
      "20 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
      "19 20 8:3 /@home /home rw,relatime shared:2 - btrfs /dev/sda3 rw",
      "21 20 0:5 / /dev rw,nosuid shared:3 - devtmpfs udev rw",
      "27 21 0:70 / /dev/shm rw,nosuid shared:4 - tmpfs tmpfs rw",
      "22 20 0:25 / /run rw,nosuid,nodev shared:5 - tmpfs tmpfs rw",
      "28 22 0:71 / /run/user/1000 rw,nosuid,nodev shared:6 - tmpfs tmpfs rw",
      "23 20 0:30 / /tmp rw,nosuid,nodev shared:7 - tmpfs tmpfs rw",
      "24 20 0:21 / /proc rw,relatime shared:8 - proc proc rw",
      "25 20 8:17 / /mnt/disk rw,relatime shared:9 - ext4 /dev/sdb1 rw",
      "26 20 0:40 / /root/secret rw,relatime shared:10 - ext4 /dev/sdc1 rw",
    ].join("\n"),
  );
  const store = "/home/u/store";
  const roots = (writable: string[] = ["/home/u/work"]) => ({
    writable,
    masks: { hidden: [`${store}/private`], readOnly: [store], writable: [`${store}/work`] },
  });
  /** The namespace's table as bubblewrap leaves it when its mounts were made private first, with `more` lines after it. */
  const lines = (root = "ro") => [
    `90 80 8:1 / / ${root},nosuid,nodev,relatime - ext4 /dev/sda1 rw`,
    "89 90 8:3 /@home /home ro,nosuid,nodev,relatime - btrfs /dev/sda3 rw",
    "91 90 8:17 / /mnt/disk ro,nosuid,nodev,relatime - ext4 /dev/sdb1 rw",
    // The host's own, which bubblewrap bound with the rest and then mounted over.
    "81 90 0:5 / /dev ro,nosuid,nodev - devtmpfs udev rw",
    "82 81 0:70 / /dev/shm rw,nosuid - tmpfs tmpfs rw",
    "83 90 0:21 / /proc ro,nosuid,nodev,relatime - proc proc rw",
    "84 90 0:25 / /run ro,nosuid,nodev - tmpfs tmpfs rw",
    "85 84 0:71 / /run/user/1000 rw,nosuid,nodev - tmpfs tmpfs rw",
    "86 90 0:30 / /tmp ro,nosuid,nodev - tmpfs tmpfs rw",
    // The namespace's own.
    "93 81 0:61 / /dev rw,nosuid,nodev - tmpfs tmpfs rw,mode=755",
    "94 93 0:5 /null /dev/null rw,nosuid - devtmpfs udev rw",
    "95 93 0:62 / /dev/pts rw,nosuid,noexec - devpts devpts rw",
    "97 83 0:64 / /proc rw,nosuid,nodev,noexec - proc proc rw",
    "98 84 0:65 / /run rw,nosuid,nodev - tmpfs tmpfs rw",
    "99 86 0:66 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw",
    // What a command was given, and the masks: the store read-only, the agent's area in it, a hidden directory.
    "100 89 8:3 /@home/u/work /home/u/work rw,nosuid,nodev,relatime - btrfs /dev/sda3 rw",
    "101 89 8:3 /@home/u/store /home/u/store ro,nosuid,nodev,relatime - btrfs /dev/sda3 rw",
    "102 101 8:3 /@home/u/store/work /home/u/store/work rw,nosuid,nodev,relatime - btrfs /dev/sda3 rw",
    "103 101 0:67 / /home/u/store/private ro,nosuid,nodev - tmpfs tmpfs rw",
  ];
  const theirs = (more: string[] = [], root = "ro", change: (line: string) => string = (line) => line) =>
    parseMountInfo([...lines(root).map(change), ...more].join("\n"));
  const why = (...of: Parameters<typeof theirs>) => codexExecClosedMounts(theirs(...of), mine, roots());

  it("takes a read-only file system with the namespace's own devices and temporary directory, from the tables alone", () => {
    // The host's shared memory and runtime directory are still listed writable, under what the
    // namespace mounted over them: no path leads into them, for as long as the namespace lasts.
    expect(why()).toBeUndefined();
    // A mount inside a directory a command was given is the command's to write with it.
    expect(why(["104 100 8:33 / /home/u/work/data rw,nodev,relatime - ext4 /dev/sdd1 rw"])).toBeUndefined();
  });

  it("finds which mount is on top from the kernel's links, whatever the order of the lines, and takes no table it cannot read", () => {
    const entered = (table: string[]) => {
      const tree = codexExecEnteredMounts(parseMountInfo(table.join("\n")));
      return "entered" in tree ? tree.entered.map((mount) => `${mount.id} ${mount.point}`).sort() : tree.unreadable;
    };
    // What bubblewrap bound of the host's and then mounted over is passed through or out of
    // reach, and the mounts made over it are what a path leads into.
    expect(entered(lines())).toEqual(
      [
        "100 /home/u/work",
        "101 /home/u/store",
        "102 /home/u/store/work",
        "103 /home/u/store/private",
        "89 /home",
        "90 /",
        "91 /mnt/disk",
        "93 /dev",
        "94 /dev/null",
        "95 /dev/pts",
        "97 /proc",
        "98 /run",
        "99 /tmp",
      ].sort(),
    );
    // The same table with its lines the other way round is the same tree, and as closed.
    expect(entered(lines().reverse())).toEqual(entered(lines()));
    expect(codexExecClosedMounts(theirs().reverse(), [...mine].reverse(), roots())).toBeUndefined();
    // The host's temporary directory mounted over the namespace's own is on top by its link,
    // though its line comes first.
    expect(
      codexExecClosedMounts(
        parseMountInfo(["104 99 0:30 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw", ...lines()].join("\n")),
        mine,
        roots(),
      ),
    ).toBe("/tmp is not the namespace's own");
    // The kernel also writes the root of a namespace as mounted in itself.
    const inItself = (line: string) => line.replace(/^90 80 /, "90 90 ");
    expect(entered(lines().map(inItself))).toEqual(entered(lines()));
    expect(why([], "ro", inItself)).toBeUndefined();

    // A table that does not read as one tree gives a reason, and is never a closed one.
    const unreadable = (table: string[]) => {
      const reason = entered(table);
      expect(typeof reason).toBe("string");
      expect(codexExecClosedMounts(parseMountInfo(table.join("\n")), mine, roots())).toBe(
        `the namespace's mount table cannot be read (${String(reason)})`,
      );
      return reason;
    };
    expect(unreadable([])).toBe("no mount is listed");
    expect(unreadable(["not a line of a mount table"])).toBe("no mount is listed");
    // Every mount mounted in another that is listed: nothing to start from.
    expect(unreadable(lines().map((line) => line.replace(/^90 80 /, "90 100 ")))).toBe("no mount is the root");
    expect(unreadable([...lines(), "104 70 8:17 / /mnt/other ro,nosuid,nodev - ext4 /dev/sdb1 rw"])).toBe(
      "more than one mount is the root: /, /mnt/other",
    );
    expect(unreadable(["90 80 8:1 / /mnt ro,nosuid,nodev - ext4 /dev/sda1 rw"])).toBe("the root is at /mnt");
    expect(unreadable([...lines(), "100 90 8:17 / /mnt/disk ro,nosuid,nodev - ext4 /dev/sdb1 rw"])).toBe(
      "two mounts have the number 100",
    );
    expect(unreadable([...lines(), "104 91 8:33 / /home/x ro,nosuid,nodev - ext4 /dev/sdd1 rw"])).toBe(
      "/home/x is listed as mounted in the mount at /mnt/disk",
    );
    // Two mounts each mounted in the other: the root leads to neither, so neither was looked at.
    expect(
      unreadable([
        ...lines(),
        "104 105 8:33 / /mnt/loop rw - ext4 /dev/sdd1 rw",
        "105 104 8:33 / /mnt/loop rw - ext4 /dev/sdd1 rw",
      ]),
    ).toBe("a mount is listed that the root does not lead to");
    // Two at one point in one mount, where a path leads: the links do not say which is on top.
    expect(unreadable([...lines(), "104 89 8:3 /@home/u/else /home/u/work rw,nosuid,nodev - btrfs /dev/sda3 rw"])).toBe(
      "two mounts are at /home/u/work in one mount, and nothing says which a path leads into",
    );
    // The same two where no path leads (under the namespace's own `/dev`) are not asked about.
    expect(why(["104 81 0:70 / /dev/shm rw,nosuid - tmpfs tmpfs rw"])).toBeUndefined();
    // ORCA's own table is held to the same before anything is compared with it.
    expect(codexExecClosedMounts(theirs(), [], roots())).toBe(
      "ORCA's own mount table cannot be read (no mount is listed)",
    );
  });

  it("is not closed while a mount takes mounts made outside afterwards, wherever it is", () => {
    // As bubblewrap leaves it by itself: each mount follows the host's.
    expect(why([], "ro", (line) => line.replace(" - ", " master:1 - "))).toBe(
      "a mount made outside afterwards would appear at /",
    );
    expect(why(["104 91 8:17 /sub /mnt/disk/sub ro,nosuid,nodev shared:44 - ext4 /dev/sdb1 rw"])).toBe(
      "a mount made outside afterwards would appear at /mnt/disk/sub",
    );
    expect(
      why(["104 100 8:3 /@home/u/work/x /home/u/work/x rw,nodev master:2 propagate_from:9 - btrfs /dev/sda3 rw"]),
    ).toBe("a mount made outside afterwards would appear at /home/u/work/x");
  });

  it("is not closed with a writable file system, the host's own temporary directory, or a writable directory that is not the directory", () => {
    expect(why([], "rw")).toBe("the file system is not read-only");
    // A temporary file system that is in ORCA's table too is the host's, whatever its kind.
    expect(why(["104 99 0:30 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw"])).toBe("/tmp is not the namespace's own");
    expect(why(["104 98 0:25 / /run rw,nosuid,nodev - tmpfs tmpfs rw"])).toBe("/run is not the namespace's own");
    expect(why(["104 93 0:5 / /dev rw,nosuid,nodev - devtmpfs udev rw"])).toBe("/dev is not the namespace's own");
    // Not bound at all, bound read-only, and bound from somewhere else: another directory of the
    // same file system, and the same path of another file system.
    expect(codexExecClosedMounts(theirs(), mine, roots(["/home/u/other"]))).toBe(
      "a writable directory is not bound writable: /home/u/other",
    );
    expect(why([], "ro", (line) => line.replace("/home/u/work rw,", "/home/u/work ro,"))).toBe(
      "a writable directory is not bound writable: /home/u/work",
    );
    expect(why([], "ro", (line) => line.replace("/@home/u/work /home/u/work", "/@home/u/else /home/u/work"))).toBe(
      "a writable directory is not the directory itself in the namespace: /home/u/work",
    );
    expect(why(["104 100 8:1 /home/u/work /home/u/work rw,nosuid,nodev - ext4 /dev/sda1 rw"])).toBe(
      "a writable directory is not the directory itself in the namespace: /home/u/work",
    );
    // The agent's area is held to the same.
    expect(why([], "ro", (line) => line.replace("/@home/u/store/work /home", "/@home/u/store/other /home"))).toBe(
      "a writable directory is not the directory itself in the namespace: /home/u/store/work",
    );
  });

  it("is not closed with anything else of the host's writable where a path leads into it, whoever can get to it", () => {
    // A disk of the host's that stayed writable, the host's shared memory where a path leads
    // into it, a directory bound writable that a command was not given, and a mount under a
    // directory the user cannot enter today, which is how bubblewrap comes to leave one.
    expect(why(["104 91 8:17 / /mnt/disk rw,nodev,relatime - ext4 /dev/sdb1 rw"])).toBe(
      "/mnt/disk is the host's and writable in the namespace",
    );
    expect(why(["104 93 0:70 / /dev/shm rw,nosuid,nodev - tmpfs tmpfs rw"])).toBe(
      "/dev/shm is the host's and writable in the namespace",
    );
    expect(why(["104 89 8:3 /@home/u/more /home/u/more rw,nosuid,nodev - btrfs /dev/sda3 rw"])).toBe(
      "/home/u/more is the host's and writable in the namespace",
    );
    expect(why(["104 90 0:40 / /root/secret rw,nodev,relatime - ext4 /dev/sdc1 rw"])).toBe(
      "/root/secret is the host's and writable in the namespace",
    );
  });

  it("does not let what a command was given open what ORCA protects inside it", () => {
    // The store is inside a directory a command was given: its masks are still what decides there.
    const wide = roots(["/home/u"]);
    const given = "104 89 8:3 /@home/u /home/u rw,nosuid,nodev,relatime - btrfs /dev/sda3 rw";
    const under = (line: string) => line.replace(/^(100|101) 89 /, "$1 104 ");
    const table = (more: string[] = [], change: (line: string) => string = (line) => line) =>
      parseMountInfo(
        [
          ...lines()
            .filter((line) => !line.startsWith("100 "))
            .map(under)
            .map(change),
          given,
          ...more,
        ].join("\n"),
      );
    expect(codexExecClosedMounts(table(), mine, wide)).toBeUndefined();
    // The store's read-only mask gone writable, and a writable mount inside the store that is
    // not the agent's area: neither is covered by the directory around them having been given.
    expect(
      codexExecClosedMounts(
        table([], (line) => line.replace("/home/u/store ro,", "/home/u/store rw,")),
        mine,
        wide,
      ),
    ).toBe("/home/u/store is the host's and writable in the namespace");
    expect(
      codexExecClosedMounts(
        table(["105 101 8:3 /@home/u/store/log /home/u/store/log rw,nosuid,nodev - btrfs /dev/sda3 rw"]),
        mine,
        wide,
      ),
    ).toBe("/home/u/store/log is the host's and writable in the namespace");
    // Inside the agent's area a mount is the agent's, and inside the hidden directory within it, it is not.
    expect(
      codexExecClosedMounts(table(["105 102 8:33 / /home/u/store/work/data rw,nodev - ext4 /dev/sdd1 rw"]), mine, wide),
    ).toBeUndefined();
    expect(
      codexExecClosedMounts(
        table(["105 103 8:33 / /home/u/store/private/data rw,nodev - ext4 /dev/sdd1 rw"]),
        mine,
        wide,
      ),
    ).toBe("/home/u/store/private/data is the host's and writable in the namespace");
  });

  it("is not closed where a device of the host's could be opened: every mount a path leads into but the namespace's own devices", () => {
    // Read-only does not keep a device from being written, so a read-only mount is held to it too.
    expect(why(["104 91 8:17 / /mnt/disk ro,nosuid,relatime - ext4 /dev/sdb1 rw"])).toBe(
      "a device of the host's could be opened under /mnt/disk",
    );
    expect(why([], "ro", (line) => line.replace("/home/u/work rw,nosuid,nodev,", "/home/u/work rw,nosuid,"))).toBe(
      "a device of the host's could be opened under /home/u/work",
    );
    // The host's own terminals, mounted where the namespace's should be, are not the namespace's.
    expect(
      codexExecClosedMounts(
        theirs(["104 95 0:9 / /dev/pts rw,nosuid,noexec - devpts devpts rw"]),
        [...mine, ...parseMountInfo("29 21 0:9 / /dev/pts rw,nosuid,noexec - devpts devpts rw")],
        roots(),
      ),
    ).toBe("a device of the host's could be opened under /dev/pts");
  });

  it("is under a filter that the kernel can take: whole instructions, every jump forward and inside it", () => {
    const filter = codexExecSocketFilter();
    expect(filter.length % 8).toBe(0);
    const count = filter.length / 8;
    for (let at = 0; at < count; at++) {
      const code = filter.readUInt16LE(at * 8);
      // A conditional jump: both ways land on an instruction of the filter.
      if ((code & 0x07) === 0x05) {
        expect(at + 1 + filter.readUInt8(at * 8 + 2)).toBeLessThan(count);
        expect(at + 1 + filter.readUInt8(at * 8 + 3)).toBeLessThan(count);
      }
    }
    // It ends in a return, so no path runs off its end.
    expect(filter.readUInt16LE((count - 1) * 8) & 0x07).toBe(0x06);
  });

  it("says what a proof lacks", () => {
    const proof: CodexExecIsolationProof = {
      holder: 10,
      executor: 11,
      namespaces: { pid: "pid:[1]", mnt: "mnt:[1]", user: "user:[1]", net: "net:[1]", ipc: "ipc:[1]" },
      network: "none",
      masks: { hidden: [], readOnly: [], writable: [] },
      closed: { writable: ["/home/u/work"] },
      ptraceScope: 1,
    };
    // The best proof there is still lacks what this backend never closes or shows: the answer
    // is never empty, so it cannot be read as leave to admit a session.
    expect(codexExecProofShortfalls(proof)).toEqual([...CODEX_EXEC_NOT_CLOSED]);
    expect(CODEX_EXEC_NOT_CLOSED.join("\n")).toMatch(/named pipe/);
    expect(CODEX_EXEC_NOT_CLOSED.join("\n")).toMatch(/filter in place is ORCA's own .* is not read back/);
    const own = (changed: CodexExecIsolationProof) =>
      codexExecProofShortfalls(changed).slice(0, -CODEX_EXEC_NOT_CLOSED.length);
    expect(own({ ...proof, closed: undefined })).toEqual([
      "a command can write wherever the user can, and connect to a socket it can name by a path",
    ]);
    expect(own({ ...proof, network: "host", closed: undefined })).toHaveLength(2);
    // A system that says nothing about tracing is not one that restricts it.
    for (const ptraceScope of [0, undefined])
      expect(own({ ...proof, ptraceScope })).toEqual([
        "the system lets a command alter the executor that started it (no ptrace_scope of 1 or more)",
      ]);
  });
});

describe.skipIf(process.platform !== "linux")("the bubblewrap ORCA will run", () => {
  it("is one only root can change, and none is found where there is none", async () => {
    const mine = join(root, "bwrap");
    await writeFile(mine, "#!/bin/sh\n");
    await chmod(mine, 0o777);
    // Anyone can change this one, whoever owns it.
    expect(systemBubblewrap([mine])).toBeUndefined();
    expect(systemBubblewrap([join(root, "missing")])).toBeUndefined();
    expect(systemBubblewrap([root])).toBeUndefined();
    expect(systemBubblewrap([])).toBeUndefined();
    // The program a closed executor's bubblewrap is started through is held to the same.
    expect(systemUnshare([mine])).toBeUndefined();
    expect(systemUnshare([join(root, "missing")])).toBeUndefined();
    expect(systemUnshare([])).toBeUndefined();
  });
});

describe.skipIf(process.platform !== "linux")("what is refused before anything is started", () => {
  const spec = (masks: CodexExecIsolatedSpawn["masks"], more: Partial<CodexExecIsolatedSpawn> = {}) => ({
    program: "/bin/true",
    env: {},
    cwd: root,
    // Never run: each of these is refused before bubblewrap is started.
    bubblewrap: join(root, "never-run"),
    masks,
    ...more,
  });
  const none = { hidden: [], readOnly: [], writable: [] };

  it("refuses a mask that is not a real directory's own path", async () => {
    await mkdir(join(root, "dir", "inner"), { recursive: true });
    await writeFile(join(root, "file"), "x");
    await symlink(join(root, "dir"), join(root, "link"));
    const refused = (masks: CodexExecIsolatedSpawn["masks"]) => {
      expect(() => spawnIsolatedCodexExecServer(spec(masks))).toThrow(CodexExecIsolationError);
    };
    refused({ ...none, hidden: [join(root, "missing")] });
    refused({ ...none, hidden: [join(root, "file")] });
    refused({ ...none, hidden: [join(root, "link")] });
    refused({ ...none, readOnly: ["relative"] });
    refused({ ...none, readOnly: ["/"] });
    refused({ ...none, readOnly: [join(root, "dir"), join(root, "dir")] });
    refused({ hidden: [join(root, "dir")], readOnly: [join(root, "dir")], writable: [] });
    // Writable again only inside something read-only; nothing shown inside something hidden.
    refused({ ...none, writable: [join(root, "dir")] });
    refused({ hidden: [join(root, "dir")], readOnly: [join(root, "dir", "inner")], writable: [] });
  });

  it("refuses an agent's area that has a protected directory inside it, though the area is inside a read-only one", async () => {
    // An area is writable inside a directory ORCA keeps read-only: that is what it is for. It
    // is no leave for a protected directory inside the area, which a command could move aside
    // with a directory above it.
    const kept = join(root, "kept");
    const area = join(kept, "area");
    await mkdir(join(area, "deep", "inner"), { recursive: true });
    const refusal = (masks: CodexExecIsolatedSpawn["masks"], more: Partial<CodexExecIsolatedSpawn> = {}) => {
      try {
        spawnIsolatedCodexExecServer(spec(masks, more));
      } catch (error) {
        return error instanceof CodexExecIsolationError ? error.message : `another error: ${String(error)}`;
      }
      return "not refused";
    };
    const inside = (path: string) => `a directory ORCA protects is inside a writable directory: ${path}`;
    for (const within of [join(area, "deep"), join(area, "deep", "inner")]) {
      expect(refusal({ hidden: [], readOnly: [kept, within], writable: [area] })).toBe(inside(within));
      expect(refusal({ hidden: [within], readOnly: [kept], writable: [area] })).toBe(inside(within));
    }
    // The same with a closed executor, whose own writable directory is elsewhere.
    await mkdir(join(root, "given"));
    expect(
      refusal(
        { hidden: [join(area, "deep")], readOnly: [kept], writable: [area] },
        { closed: { writable: [join(root, "given")] } },
      ),
    ).toBe(inside(join(area, "deep")));
  });
});

describe.skipIf(process.platform !== "linux")("what the kernel shows of a process", () => {
  /** A `/proc` directory's `stat`, as the kernel writes it: state third, thread count twentieth. */
  const stat = (state: string, threads: string, name = "node") =>
    `4242 (${name}) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 ${threads} 0 123456 1000 100 1 1\n`;
  const listed = async (text: string): Promise<string> => {
    const dir = join(root, `proc-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir);
    await writeFile(join(dir, "stat"), text);
    return dir;
  };

  it("says a process ended only on the kernel's word, read through a descriptor for it", async () => {
    const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    const fd = openSync(`/proc/${child.pid!}`, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      expect(codexExecProcessSeen(`/proc/self/fd/${fd}`)).toBe("there");
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      // Reaped: the kernel answers "no such process" for the directory it gave for that process.
      expect(codexExecProcessSeen(`/proc/self/fd/${fd}`)).toBe("ended");
    } finally {
      closeSync(fd);
    }
  });

  it("does not take a reading it could not make for an ending", async () => {
    // No such directory, no such file, a file that is no process's: none of them is the kernel's word.
    expect(codexExecProcessSeen(join(root, "missing"))).toBe("unseen");
    await mkdir(join(root, "empty"));
    expect(codexExecProcessSeen(join(root, "empty"))).toBe("unseen");
    expect(codexExecProcessSeen("/proc/self/fd/987654")).toBe("unseen");
    expect(codexExecProcessSeen("/proc/2147483646")).toBe("unseen");
    for (const text of ["", "garbage", "4242 (node", stat("?", "1"), stat("S", "many"), stat("Z", "")])
      expect(codexExecProcessSeen(await listed(text))).toBe("unseen");
  });

  it("takes a finished process for ended only when no thread of it is left", async () => {
    expect(codexExecProcessSeen(await listed(stat("S", "7")))).toBe("there");
    expect(codexExecProcessSeen(await listed(stat("R", "1")))).toBe("there");
    expect(codexExecProcessSeen(await listed(stat("Z", "1")))).toBe("ended");
    // Its first thread is finished, and another can still be running.
    expect(codexExecProcessSeen(await listed(stat("Z", "2")))).toBe("unseen");
    expect(codexExecProcessSeen(await listed(stat("X", "1")))).toBe("unseen");
    // A name can hold anything, a closing bracket and a state among it.
    expect(codexExecProcessSeen(await listed(stat("S", "3", "a) Z 1 (b")))).toBe("there");
  });
});

describe.skipIf(process.platform !== "linux")("what a process's descriptors are", () => {
  it("names each one, and fails for one it cannot look at", async () => {
    // This process's own, read as the kernel lists them.
    const mine = codexExecDescriptorsOf("/proc/self");
    expect(mine.get("0")).toBeDefined();
    expect([...mine.keys()].every((fd) => /^\d+$/.test(fd))).toBe(true);
    // A listing with an entry that cannot be read as a descriptor: an error, not one left out.
    const listing = join(root, "listing");
    await mkdir(join(listing, "fd"), { recursive: true });
    await symlink("socket:[4242]", join(listing, "fd", "0"));
    expect(codexExecDescriptorsOf(listing)).toEqual(new Map([["0", "socket:[4242]"]]));
    await writeFile(join(listing, "fd", "5"), "");
    expect(() => codexExecDescriptorsOf(listing)).toThrow(CodexExecIsolationError);
    expect(() => codexExecDescriptorsOf(listing)).toThrow(/could not see what descriptor 5/);
    // No listing at all is no pass either.
    expect(() => codexExecDescriptorsOf(join(root, "missing"))).toThrow();
  });
});

describe.skipIf(process.platform !== "linux")("what a command would reach outside its namespace", () => {
  const user = () => ({ uid: userInfo().uid, name: userInfo().username, home: join(root, "home"), keep: [] });
  /** What was found for the variables and for this test's own paths: the machine's own well-known places are left out. */
  const said = (reach: ReturnType<typeof codexExecOutsideReach>) =>
    reach.unhidden.filter(({ from }) => !from.startsWith("/") || from.startsWith(root));
  /** A system of the test's own: its temporary directory with the X server's in it, and its runtime directories. */
  const system = async () => {
    const made = { temporary: join(root, "tmp"), run: join(root, "run") };
    await mkdir(join(made.temporary, ".X11-unix"), { recursive: true });
    await chmod(join(made.temporary, ".X11-unix"), 0o1777);
    await mkdir(made.run, { recursive: true });
    return made;
  };

  it("names the user's runtime directory and the agent's, and leaves their variables out", async () => {
    const runtime = join(root, "runtime");
    const agent = join(root, "ssh-abc");
    for (const dir of [runtime, agent, join(root, "home")]) await mkdir(dir, { mode: 0o700 });
    await writeFile(join(agent, "agent.1"), "");
    const reach = codexExecOutsideReach(
      {
        PATH: "/usr/bin:/bin",
        HOME: join(root, "home"),
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
        SSH_AUTH_SOCK: join(agent, "agent.1"),
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        NOT_SET: undefined,
      },
      user(),
      await system(),
    );
    expect(reach.hidden).toEqual(expect.arrayContaining([runtime, agent, join(root, "tmp", ".X11-unix")]));
    expect(reach.env).toEqual({ PATH: "/usr/bin:/bin", HOME: join(root, "home") });
    expect(reach.dropped.sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "DISPLAY",
      "SSH_AUTH_SOCK",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
    ]);
    // Everything the environment named was followed to a directory that is hidden.
    expect(said(reach)).toEqual([]);
    // Each can be masked as it is: a real directory's own path, none inside another.
    for (const path of reach.hidden) expect(await realpath(path)).toBe(path);
  });

  it("hides one directory once when the agent's socket is inside the runtime directory", async () => {
    const runtime = join(root, "runtime");
    await mkdir(join(runtime, "keyring"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "home"));
    await writeFile(join(runtime, "keyring", "ssh"), "");
    const reach = codexExecOutsideReach(
      { XDG_RUNTIME_DIR: runtime, SSH_AUTH_SOCK: join(runtime, "keyring", "ssh") },
      user(),
    );
    expect(reach.hidden.filter((path) => path.startsWith(root))).toEqual([runtime]);
  });

  it("follows each socket the environment names to its directory, wherever the name really leads", async () => {
    await mkdir(join(root, "home"));
    const places = ["bus", "keyring", "gpg", "tmux", "docker", "editor", "wayland"].map((name) => join(root, name));
    for (const dir of places) await mkdir(dir, { mode: 0o700 });
    const [bus, keyring, gpg, tmux, docker, editor, wayland] = places as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await writeFile(join(docker, "docker.sock"), "");
    // A name for the container daemon's socket that leads into another directory.
    await symlink(join(docker, "docker.sock"), join(root, "docker-by-link.sock"));
    const reach = codexExecOutsideReach(
      {
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}/a%20bus,guid=0123`,
        GNOME_KEYRING_CONTROL: keyring,
        GPG_AGENT_INFO: `${gpg}/S.gpg-agent:4242:1`,
        TMUX: `${tmux}/default,4242,0`,
        DOCKER_HOST: `unix://${join(root, "docker-by-link.sock")}`,
        VSCODE_IPC_HOOK_CLI: `${editor}/ipc.sock`,
        WAYLAND_DISPLAY: `${wayland}/wayland-1`,
      },
      user(),
    );
    expect(reach.hidden.filter((path) => path.startsWith(root)).sort()).toEqual([...places].sort());
    expect(said(reach)).toEqual([]);
    expect(reach.env).toEqual({});
  });

  it("says what it cannot hide without hiding more: a home, a working directory, a directory that is not the user's own", async () => {
    const home = join(root, "home");
    const shared = join(root, "shared");
    await mkdir(join(home, "project"), { recursive: true });
    await mkdir(shared, { mode: 0o777 });
    await chmod(shared, 0o777);
    await writeFile(join(shared, "agent.sock"), "");
    await writeFile(join(root, "not-a-directory"), "");

    // The runtime directory is the home, or holds the directory a command works in.
    for (const runtime of [home, join(home, "project")]) {
      const reach = codexExecOutsideReach({ XDG_RUNTIME_DIR: runtime }, { ...user(), keep: [join(home, "project")] });
      expect(reach.hidden.filter((path) => path.startsWith(root))).toEqual([]);
      expect(said(reach)).toEqual([
        { from: "XDG_RUNTIME_DIR", why: "it holds the user's home or a directory a command works in" },
      ]);
      // The variable is still left out: a command is not pointed at what could not be hidden.
      expect(reach.env).toEqual({});
    }
    // The agent's socket is in a directory others may write.
    const open = codexExecOutsideReach({ SSH_AUTH_SOCK: join(shared, "agent.sock") }, user());
    expect(open.hidden.filter((path) => path.startsWith(root))).toEqual([]);
    expect(said(open)).toEqual([{ from: "SSH_AUTH_SOCK", why: "it is not a directory of the user's own" }]);
    // A runtime directory the environment names is held to the same: one others may write is not the user's own.
    const loose = codexExecOutsideReach({ XDG_RUNTIME_DIR: shared }, user());
    expect(loose.hidden.filter((path) => path.startsWith(root))).toEqual([]);
    expect(said(loose)).toEqual([{ from: "XDG_RUNTIME_DIR", why: "it is not a directory of the user's own" }]);
    // The runtime directory is a file.
    const file = codexExecOutsideReach({ XDG_RUNTIME_DIR: join(root, "not-a-directory") }, user());
    expect(said(file)).toEqual([{ from: "XDG_RUNTIME_DIR", why: "it is not a directory" }]);
  });

  it("lists what the environment names and ORCA cannot follow, by the variable's name and never its value", async () => {
    await mkdir(join(root, "home"));
    // A path through links that lead back to each other: what is there cannot be looked at.
    await symlink(join(root, "loop-b"), join(root, "loop-a"));
    await symlink(join(root, "loop-a"), join(root, "loop-b"));
    const reach = codexExecOutsideReach(
      {
        XDG_RUNTIME_DIR: "run/user/secret-relative",
        SSH_AUTH_SOCK: join(root, "nowhere-secret", "agent.1"),
        GNOME_KEYRING_CONTROL: join(root, "loop-a", "secret-keyring"),
        GPG_AGENT_INFO: "",
        DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-secret;tcp:host=secret.example,port=1",
        DOCKER_HOST: "tcp://secret.example:2375",
        CONTAINER_HOST: "ssh://someone@secret.example/run/podman.sock",
        DISPLAY: "secret.example:0",
        TMUX_TMPDIR: "secret-relative",
      },
      user(),
    );
    expect(reach.hidden.filter((path) => path.startsWith(root))).toEqual([]);
    expect(said(reach)).toEqual([
      { from: "XDG_RUNTIME_DIR", why: "its value is not a path ORCA can follow" },
      { from: "DBUS_SESSION_BUS_ADDRESS", why: "it names a service that is not reached through a directory" },
      { from: "SSH_AUTH_SOCK", why: "it names nothing that is there" },
      { from: "GPG_AGENT_INFO", why: "its value is written in a way ORCA does not read exactly" },
      { from: "GNOME_KEYRING_CONTROL", why: "it could not be looked at" },
      { from: "DISPLAY", why: "it names a service that is not reached through a directory" },
      { from: "DOCKER_HOST", why: "it names a service that is not reached through a directory" },
      { from: "CONTAINER_HOST", why: "it names a service that is not reached through a directory" },
      { from: "TMUX_TMPDIR", why: "its value is not a path ORCA can follow" },
    ]);
    // No value is in what is said, and every one of the variables is left out of the environment.
    expect(JSON.stringify(reach)).not.toMatch(/secret/);
    expect(reach.env).toEqual({});
    expect(reach.dropped).toHaveLength(9);
  });

  it("passes over a well-known directory only when it is not there", async () => {
    await mkdir(join(root, "home"));
    const mine = codexExecOutsideReach({}, user());
    // On this machine, each well-known place is hidden, said not to be, or not there. None is hidden twice.
    const wellKnown = [
      `/run/user/${userInfo().uid}`,
      "/tmp/.X11-unix",
      "/tmp/.ICE-unix",
      `/tmp/tmux-${userInfo().uid}`,
    ];
    for (const place of wellKnown) {
      const there = existsSync(place);
      const accounted = mine.hidden.includes(place) || mine.unhidden.some(({ from }) => from === place);
      expect([place, accounted]).toEqual([place, there]);
    }
    // A multiplexer directory the environment places elsewhere, which is someone else's to write.
    const elsewhere = join(root, "multiplexers");
    await mkdir(join(elsewhere, `tmux-${userInfo().uid}`), { recursive: true });
    await chmod(join(elsewhere, `tmux-${userInfo().uid}`), 0o777);
    expect(said(codexExecOutsideReach({ TMUX_TMPDIR: elsewhere }, user()))).toEqual([
      { from: "TMUX_TMPDIR", why: "it is not a directory of the user's own" },
    ]);
    // With nothing of a multiplexer's there, the variable is listed: only a place nothing named is passed over.
    expect(said(codexExecOutsideReach({ TMUX_TMPDIR: join(root, "home") }, user()))).toEqual([
      { from: "TMUX_TMPDIR", why: "it names nothing that is there" },
    ]);
  });

  it("follows every variable that is set to a hidden directory or lists it by name, and nothing else", async () => {
    const made = await system();
    const name = userInfo().username;
    const uid = userInfo().uid;
    const d = Object.fromEntries(
      [
        "home",
        "runtime",
        "agent",
        "bus",
        "keyring",
        "gpg",
        "tmux",
        "screens",
        "docker",
        "editor",
        "wayland",
        "ice",
      ].map((dir) => [dir, join(root, dir)]),
    ) as Record<string, string>;
    for (const dir of Object.values(d)) await mkdir(dir, { mode: 0o700 });
    const multiplexers = join(root, "multiplexers");
    const usual = join(made.run, "screen", `S-${name}`);
    const ownRun = join(made.run, "user", String(uid));
    for (const dir of [join(multiplexers, `tmux-${uid}`), usual, ownRun])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    const shared = join(root, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    for (const file of [join(d.screens!, "4242.pts-0.here"), join(usual, "4343.pts-1.here")]) await writeFile(file, "");
    await symlink(join(root, "loop-b"), join(root, "loop-a"));
    await symlink(join(root, "loop-a"), join(root, "loop-b"));
    const x = join(made.temporary, ".X11-unix");
    const noX = { temporary: join(root, "no-x"), run: made.run };

    const noPath = "its value is not a path ORCA can follow";
    const unread = "its value is written in a way ORCA does not read exactly";
    const elsewhere = "it names a service that is not reached through a directory";
    const nothing = "it names nothing that is there";
    const noRuntime = "it is a name in the runtime directory, and no runtime directory is hidden";
    const noPlace = "it tells of a program, and nothing names where that is reached";
    const placeShown = "it tells of a program at a place that is not hidden";
    const unmasked = "it names credentials in a place that is not hidden";
    const notOwn = "it is not a directory of the user's own";
    type Variable = (typeof CODEX_EXEC_OUTSIDE_VARIABLES)[number];
    /** A variable and its value, what else is set, and the outcome: the directory hidden for it, or why it is listed. */
    type Row = [
      Variable,
      string,
      { hidden: string } | { why: string },
      Partial<Record<Variable, string>>?,
      typeof made?,
    ];
    const rows: Row[] = [
      ["XDG_RUNTIME_DIR", d.runtime!, { hidden: d.runtime! }],
      ["XDG_RUNTIME_DIR", "secret/relative", { why: noPath }],
      ["XDG_RUNTIME_DIR", join(root, "secret-missing"), { why: nothing }],
      ["XDG_RUNTIME_DIR", shared, { why: notOwn }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/bus`, { hidden: d.bus! }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:guid=0123,path=${d.bus}/a%20bus`, { hidden: d.bus! }],
      ["DBUS_SESSION_BUS_ADDRESS", "unix:runtime=yes", { hidden: d.runtime! }, { XDG_RUNTIME_DIR: d.runtime! }],
      ["DBUS_SESSION_BUS_ADDRESS", "unix:runtime=yes", { why: noRuntime }],
      ["DBUS_SESSION_BUS_ADDRESS", "unix:runtime=yes", { why: noRuntime }, { XDG_RUNTIME_DIR: shared }],
      ["DBUS_SESSION_BUS_ADDRESS", "unix:abstract=/tmp/dbus-secret", { why: elsewhere }],
      ["DBUS_SESSION_BUS_ADDRESS", "tcp:host=secret.example,port=1", { why: elsewhere }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/bus;unix:abstract=/tmp/dbus-secret`, { why: elsewhere }],
      ["DBUS_SESSION_BUS_ADDRESS", "autolaunch:scope=secret", { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/secret bus`, { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/secret%zz`, { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/secret%ff`, { why: unread }],
      // A byte-order mark is a byte of the path like any other: it is not dropped to make the path a good one.
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=%EF%BB%BF${d.bus}/secret`, { why: noPath }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/bus,path=${d.agent}/secret`, { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/bus,secret=1`, { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:tmpdir=${d.bus}`, { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", `unix:path=${d.bus}/bus;`, { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", `${d.bus}/secret`, { why: unread }],
      ["DBUS_SESSION_BUS_ADDRESS", "", { why: unread }],
      ["SSH_AUTH_SOCK", join(d.agent!, "agent.1"), { hidden: d.agent! }],
      ["SSH_AUTH_SOCK", join(root, "secret-missing", "agent.1"), { why: nothing }],
      ["SSH_AUTH_SOCK", "", { why: noPath }],
      ["SSH_AGENT_PID", "4242", { hidden: d.agent! }, { SSH_AUTH_SOCK: join(d.agent!, "agent.1") }],
      ["SSH_AGENT_PID", "4242", { why: noPlace }],
      ["SSH_AGENT_PID", "4242", { why: placeShown }, { SSH_AUTH_SOCK: join(shared, "agent.1") }],
      ["GPG_AGENT_INFO", `${d.gpg}/S.gpg-agent:4242:1`, { hidden: d.gpg! }],
      ["GPG_AGENT_INFO", `${d.gpg}/S.gpg-agent`, { why: unread }],
      ["GPG_AGENT_INFO", "", { why: unread }],
      ["GNOME_KEYRING_CONTROL", d.keyring!, { hidden: d.keyring! }],
      ["GNOME_KEYRING_CONTROL", join(root, "loop-a", "secret-keyring"), { why: "it could not be looked at" }],
      ["DISPLAY", ":0", { hidden: x }],
      ["DISPLAY", "unix:1.0", { hidden: x }],
      ["DISPLAY", ":0", { why: nothing }, {}, noX],
      ["DISPLAY", "secret.example:0", { why: elsewhere }],
      ["DISPLAY", "tcp/secret.example:0.0", { why: elsewhere }],
      ["DISPLAY", "secret", { why: unread }],
      ["DISPLAY", `${d.wayland}/secret:0`, { why: unread }],
      ["WAYLAND_DISPLAY", `${d.wayland}/wayland-1`, { hidden: d.wayland! }],
      ["WAYLAND_DISPLAY", "wayland-0", { hidden: d.runtime! }, { XDG_RUNTIME_DIR: d.runtime! }],
      ["WAYLAND_DISPLAY", "secret-wayland-0", { why: noRuntime }],
      ["WAYLAND_DISPLAY", "secret-wayland-0", { why: noRuntime }, { XDG_RUNTIME_DIR: shared }],
      ["WAYLAND_DISPLAY", "../secret-missing/wayland-0", { why: nothing }, { XDG_RUNTIME_DIR: d.runtime! }],
      ["WAYLAND_DISPLAY", "", { why: unread }],
      ["XAUTHORITY", join(d.runtime!, "xauth_secret"), { hidden: d.runtime! }, { XDG_RUNTIME_DIR: d.runtime! }],
      ["XAUTHORITY", join(ownRun, "xauth_secret"), { hidden: ownRun }],
      [
        "XAUTHORITY",
        join(d.editor!, "xauth_secret"),
        { hidden: d.editor! },
        { VSCODE_IPC_HOOK_CLI: `${d.editor}/ipc.sock` },
      ],
      ["XAUTHORITY", join(d.home!, "secret-authority"), { why: unmasked }, { DISPLAY: ":0" }],
      ["XAUTHORITY", join(d.home!, "secret-authority"), { why: unmasked }],
      ["XAUTHORITY", join(d.runtime!, "xauth_secret"), { why: unmasked }],
      ["XAUTHORITY", "secret/relative", { why: noPath }],
      ["SESSION_MANAGER", `unix/here:${d.ice}/4242`, { hidden: d.ice! }],
      ["SESSION_MANAGER", `local/here:@/tmp/.ICE-unix/secret,unix/here:${d.ice}/4242`, { why: elsewhere }],
      ["SESSION_MANAGER", "tcp/secret.example:6000", { why: elsewhere }],
      ["SESSION_MANAGER", "unix/here:secret/relative", { why: unread }],
      ["SESSION_MANAGER", "secret", { why: unread }],
      ["DOCKER_HOST", `unix://${d.docker}/docker.sock`, { hidden: d.docker! }],
      ["DOCKER_HOST", "tcp://secret.example:2375", { why: elsewhere }],
      ["DOCKER_HOST", "secret.example:2375", { why: unread }],
      ["DOCKER_HOST", "unix://secret/relative.sock", { why: noPath }],
      ["CONTAINER_HOST", `unix://${d.docker}/podman.sock`, { hidden: d.docker! }],
      ["CONTAINER_HOST", "ssh://someone@secret.example/run/podman.sock", { why: elsewhere }],
      ["TMUX", `${d.tmux}/default,4242,0`, { hidden: d.tmux! }],
      ["TMUX", `${d.tmux}/secret`, { why: unread }],
      ["TMUX_PANE", "%1", { hidden: d.tmux! }, { TMUX: `${d.tmux}/default,4242,0` }],
      ["TMUX_PANE", "%secret", { why: noPlace }],
      ["TMUX_TMPDIR", multiplexers, { hidden: join(multiplexers, `tmux-${uid}`) }],
      ["TMUX_TMPDIR", "secret/relative", { why: noPath }],
      ["TMUX_TMPDIR", d.home!, { why: nothing }],
      ["SCREENDIR", d.screens!, { hidden: d.screens! }],
      ["SCREENDIR", "secret/relative", { why: noPath }],
      ["STY", "4242.pts-0.here", { hidden: d.screens! }, { SCREENDIR: d.screens! }],
      ["STY", "4343.pts-1.here", { hidden: usual }],
      ["STY", "4343.pts-1.here", { why: nothing }, { SCREENDIR: d.screens! }],
      ["STY", "secret.session", { why: nothing }],
      ["STY", "secret/session", { why: unread }],
      ["VSCODE_IPC_HOOK_CLI", `${d.editor}/ipc.sock`, { hidden: d.editor! }],
      ["VSCODE_IPC_HOOK_CLI", "secret/relative.sock", { why: noPath }],
    ];
    // Every variable has a row for each outcome: a rule that only ever lists, or never does, would show here.
    for (const variable of CODEX_EXEC_OUTSIDE_VARIABLES)
      for (const outcome of ["hidden", "why"])
        expect([variable, outcome, rows.some((row) => row[0] === variable && outcome in row[2])]).toEqual([
          variable,
          outcome,
          true,
        ]);
    for (const [variable, value, outcome, others, where] of rows) {
      const reach = codexExecOutsideReach({ ...others, [variable]: value, PATH: "/usr/bin" }, user(), where ?? made);
      const listed = reach.unhidden.filter(({ from }) => from === variable).map(({ why }) => why);
      const row = JSON.stringify([variable, value, others ?? {}]);
      // Listed with the one reason, or not listed and its directory hidden. Never neither, never both.
      if ("why" in outcome) expect([row, listed]).toEqual([row, [outcome.why]]);
      else expect([row, listed, reach.hidden.includes(outcome.hidden)]).toEqual([row, [], true]);
      // By name only: no value is in what is said, and the variable is not handed on.
      expect([row, JSON.stringify(reach.unhidden).includes("secret")]).toEqual([row, false]);
      expect([row, reach.dropped.includes(variable), reach.env]).toEqual([row, true, { PATH: "/usr/bin" }]);
    }
  });
});

describe.skipIf(process.platform !== "linux")("a namespace that is not made in time", () => {
  const channelClosed = () => join(root, "channel-closed");
  /**
   * Start with a stand-in for bubblewrap that makes nothing and answers nothing. It ignores
   * every signal that can be ignored, never exits, and keeps its error stream open. When
   * ORCA's channel closes it notes that, and still does not leave.
   */
  async function withSilentLauncher(setupWaitMs: number) {
    const silent = join(root, "silent-bwrap");
    await writeFile(
      silent,
      [
        "#!/bin/bash",
        "trap '' TERM HUP INT PIPE",
        "echo 'the launcher is here and will say no more' >&2",
        `( while read -r -u 3 _; do :; done; : > ${channelClosed()} ) &`,
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
    );
    await chmod(silent, 0o755);
    return spawnIsolatedCodexExecServer({
      program: "/bin/true",
      env: {},
      cwd: root,
      masks: { hidden: [], readOnly: [], writable: [] },
      bubblewrap: silent,
      runtimeEnv: { PATH: "/usr/bin:/bin" },
      setupWaitMs,
      // Far longer than a test: nothing in them comes from a wait for the launcher to go by itself.
      stopGraceMs: 120_000,
    });
  }

  it("is refused at the deadline, and ended by ORCA then, whatever the launcher does", async () => {
    const began = Date.now();
    const backend = await withSilentLauncher(300);
    const exit = new Promise<{ detail: string; nothingLeft: boolean | undefined; at: number }>((resolve) => {
      backend.onExit((detail, nothingLeft) => resolve({ detail, nothingLeft, at: Date.now() - began }));
    });
    let flushed = 0;
    backend.send("never sent", () => (flushed += 1));

    // Refused soon after the deadline, with what the launcher said, though it is still running.
    await expect(backend.isolated).rejects.toThrow(/was not made in time: the launcher is here/);
    expect(Date.now() - began).toBeGreaterThanOrEqual(300);
    expect(Date.now() - began).toBeLessThan(5000);
    // What was waiting was dropped, and nothing more can be sent.
    expect(flushed).toBe(1);
    expect(() => backend.send("late", () => undefined)).toThrow(/gone/);

    // Ended by ORCA at the deadline: its channel closed, and the launcher killed without the grace.
    await expect.poll(() => existsSync(channelClosed()), { timeout: 5000 }).toBe(true);
    const ended = await exit;
    expect(ended.detail).toMatch(/was not made in time/);
    expect(ended.at).toBeLessThan(5000);
    expect(() => process.kill(backend.pid!, 0)).toThrow();
    // No first process was verified, so ORCA does not say it saw anything end.
    expect(ended.nothingLeft).toBe(false);
  });

  it("is ended at once by a stop, long before its deadline", async () => {
    const backend = await withSilentLauncher(120_000);
    let flushed = 0;
    backend.send("never sent", () => (flushed += 1));
    const began = Date.now();
    await backend.stop();
    // Neither the deadline nor the grace was waited for.
    expect(Date.now() - began).toBeLessThan(5000);
    await expect(backend.isolated).rejects.toThrow(/stopped it before its isolation was shown/);
    expect(flushed).toBe(1);
    expect(() => backend.send("late", () => undefined)).toThrow(/gone/);
    expect(() => process.kill(backend.pid!, 0)).toThrow();
  });
});

describe.skipIf(!USABLE && !REQUIRED)("an executor in namespaces ORCA makes", () => {
  let stub: string;
  let config: string;
  let store: string;
  let work: string;
  let masks: CodexExecIsolatedSpawn["masks"];
  let live: ReturnType<typeof spawnIsolatedCodexExecServer>[] = [];

  beforeEach(async () => {
    // A stand-in for the executor: it runs each line it is sent and answers with one JSON line.
    stub = join(root, "executor.sh");
    await writeFile(
      stub,
      [
        "#!/bin/bash",
        'echo "$*" > "$ORCA_STUB_STARTED"',
        "while IFS= read -r line; do",
        '  out=$(bash -c "$line" 2>&1 | head -c 4000 | base64 -w0)',
        '  echo "{\\"out\\":\\"$out\\"}"',
        "done",
        "",
      ].join("\n"),
    );
    await chmod(stub, 0o755);
    config = join(root, "config");
    store = join(config, ".orca");
    work = join(root, "work");
    for (const dir of ["auth", ".orca/private-execution", ".orca/work"])
      await mkdir(join(config, dir), { recursive: true });
    await mkdir(join(work, "sub"), { recursive: true });
    await writeFile(join(config, "auth", "owner.token"), "the-owner-token\n");
    await writeFile(join(store, "private-execution", "key"), "the-store-key\n");
    await writeFile(join(store, "events.log"), "events\n");
    await writeFile(join(work, "sub", "here.txt"), "");
    masks = {
      hidden: [join(config, "auth"), join(store, "private-execution")],
      readOnly: [store],
      writable: [join(store, "work")],
    };
    live = [];
  });
  afterEach(async () => {
    for (const backend of live) await backend.stop().catch(() => undefined);
  });

  const started = () => join(root, "started.txt");
  /** Start the stand-in in its namespaces, and run commands in it. */
  function isolate(more: Partial<CodexExecIsolatedSpawn> = {}) {
    const backend = spawnIsolatedCodexExecServer({
      program: stub,
      env: { PATH: "/usr/bin:/bin", ORCA_STUB_STARTED: started(), GIVEN: "to-the-executor" },
      cwd: work,
      masks,
      stopGraceMs: 1000,
      ...more,
    });
    live.push(backend);
    const answers: ((out: string) => void)[] = [];
    backend.onMessage((message) => {
      const { out } = JSON.parse(message) as { out: string };
      answers.shift()?.(Buffer.from(out, "base64").toString("utf8"));
    });
    const exit = new Promise<{ detail: string; nothingLeft: boolean | undefined }>((resolve) => {
      backend.onExit((detail, nothingLeft) => resolve({ detail, nothingLeft }));
    });
    const run = (command: string): Promise<string> =>
      new Promise((resolve) => {
        answers.push(resolve);
        backend.send(command, () => undefined);
      });
    return { backend, run, exit };
  }
  const sleepers = (): number => {
    try {
      return execFileSync("pgrep", ["-f", "orca-1026-isolation-sleeper"]).toString().trim().split("\n").length;
    } catch {
      return 0;
    }
  };

  it("has both: a bubblewrap the system installed, and leave to make a user namespace", () => {
    // What every test below needs. Failing here, not skipping, where the machine is said to have them.
    expect(BUBBLEWRAP).toBeDefined();
    expect(USABLE).toBe(true);
  });

  it("shows the isolation from outside before the executor is sent anything", async () => {
    const { backend, run } = isolate();
    // Sent before the isolation is shown: it waits, and is delivered once it is.
    const early = run("echo early");
    const proof = await backend.isolated;
    expect(await early).toBe("early\n");
    // The holder and the executor are two processes here, in namespaces that are not ORCA's.
    expect(proof.holder).not.toBe(proof.executor);
    expect(readFileSync(`/proc/${proof.holder}/status`, "utf8")).toMatch(/^NSpid:\s+\d+\s+1$/m);
    for (const kind of ["pid", "mnt", "user"] as const) {
      expect(proof.namespaces[kind]).not.toBe(readlinkSync(`/proc/self/ns/${kind}`));
      expect(readlinkSync(`/proc/${proof.executor}/ns/${kind}`)).toBe(proof.namespaces[kind]);
    }
    expect(proof.masks).toEqual(masks);
    // The executor is the holder's child, and a command it runs has no capability over the namespace.
    expect(readFileSync(`/proc/${proof.executor}/status`, "utf8")).toMatch(
      new RegExp(`^PPid:\\s+${proof.holder}$`, "m"),
    );
    expect(await run("grep CapEff /proc/self/status")).toMatch(/CapEff:\s+0+\n/);
    // The executor was started as an executor, with the environment it was given and no other.
    expect(await readFile(started(), "utf8")).toBe("exec-server --listen stdio\n");
    expect(await run("echo $GIVEN; env | grep -c ORCA_STUB")).toBe("to-the-executor\n1\n");
    // The holder's channel is not among what a command inherits: only its own three, and `ls`'s own.
    expect(await run("ls /proc/self/fd | tr '\\n' ' '")).toBe("0 1 2 3 ");
  });

  it("hands a command nothing that ORCA's own process was handed open", async () => {
    // Bubblewrap started with two more descriptors open, as whatever started ORCA might leave
    // them to it: one of them on a file the masks hide. A descriptor is the file itself, and
    // no mask on a name covers it.
    const handed = join(root, "bwrap-with-descriptors");
    await writeFile(
      handed,
      [
        "#!/bin/bash",
        `exec 142< /dev/null 145< ${join(config, "auth", "owner.token")}`,
        `exec ${BUBBLEWRAP!} "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(handed, 0o755);
    const { backend, run } = isolate({ bubblewrap: handed });
    await backend.isolated;
    expect(await run("ls /proc/self/fd | tr '\\n' ' '")).toBe("0 1 2 3 ");
    expect(await run("cat <&145")).toMatch(/Bad file descriptor/);
  });

  it("starts no executor behind a holder that would hand a descriptor on, and says what it saw of the end", async () => {
    // A stand-in for the holder's runtime: a shell, whose descriptors all pass to what it
    // starts. It is the first process of a real namespace, says so, and leaves when ORCA's
    // channel closes.
    const shell = join(root, "holder.sh");
    await writeFile(shell, ["#!/bin/bash", 'echo "{\\"ready\\": $$}" >&3', "read -r -u 3 _", ""].join("\n"));
    await chmod(shell, 0o755);
    const { backend, exit } = isolate({ runtime: shell });
    await expect(backend.isolated).rejects.toThrow(/would hand descriptor \d+ on to the executor/);
    const ended = await exit;
    expect(existsSync(started())).toBe(false);
    // Refused, but the first process had been verified, and bubblewrap reaped it when ORCA
    // closed the channel. So here ORCA did see the namespace end, and says so.
    expect(ended.nothingLeft).toBe(true);
  });

  const asked = () => join(root, "asked");
  /**
   * A stand-in for the holder that notes what it is asked, and takes its time: so long to
   * try the masks, so long to start the executor. It is the first process of a real
   * namespace, so ORCA's own checks pass, and it says yes to everything.
   */
  async function slowHolder(wait: { probeMs: number; startMs: number }): Promise<string> {
    const slow = join(root, "slow-holder.js");
    await writeFile(
      slow,
      [
        'const fs = require("node:fs");',
        'const net = require("node:net");',
        'const { spawn } = require("node:child_process");',
        "const control = new net.Socket({ fd: 3, readable: true, writable: true });",
        'const say = (m) => control.write(JSON.stringify(m) + "\\n");',
        'let text = "";',
        'control.setEncoding("utf8");',
        'control.on("data", (chunk) => {',
        "  text += chunk;",
        "  for (;;) {",
        '    const end = text.indexOf("\\n");',
        "    if (end < 0) break;",
        "    const m = JSON.parse(text.slice(0, end));",
        "    text = text.slice(end + 1);",
        `    fs.appendFileSync(${JSON.stringify(asked())}, m.op + "\\n");`,
        `    if (m.op === "probe") setTimeout(() => say({ id: m.id, wrong: [] }), ${wait.probeMs});`,
        '    if (m.op === "start")',
        "      setTimeout(() => {",
        '        const child = spawn(m.program, m.args, { cwd: m.cwd, env: m.env, stdio: "inherit" });',
        "        say({ id: m.id, started: child.pid });",
        `      }, ${wait.startMs});`,
        "  }",
        "});",
        'control.on("close", () => process.exit(70));',
        "// As the holder does: what the test's own process was handed open is not passed on.",
        'for (const name of fs.readdirSync("/proc/self/fd")) {',
        "  let flags;",
        '  try { flags = /^flags:\\s*([0-7]+)$/m.exec(fs.readFileSync("/proc/self/fdinfo/" + name, "utf8")); } catch { continue; }',
        "  if (Number(name) > 3 && flags && (parseInt(flags[1], 8) & 0o2000000) === 0) fs.closeSync(Number(name));",
        "}",
        "say({ ready: process.pid });",
        "",
      ].join("\n"),
    );
    const runtime = join(root, "slow-runtime");
    await writeFile(runtime, `#!/bin/sh\nexec ${process.execPath} ${slow}\n`);
    await chmod(runtime, 0o755);
    return runtime;
  }
  const askedSoFar = () => existsSync(asked()) && readFileSync(asked(), "utf8");

  it("starts no executor, and gives no proof, once it is stopped while the isolation is being shown", async () => {
    // The setup is waiting for the holder's answer about the masks when the stop comes.
    const { backend, exit } = isolate({ runtime: await slowHolder({ probeMs: 400, startMs: 0 }) });
    let flushed = 0;
    backend.send("echo never", () => (flushed += 1));
    await expect.poll(askedSoFar).toBe("probe\n");

    await backend.stop();
    await expect(backend.isolated).rejects.toThrow(/stopped it before its isolation was shown/);
    expect((await exit).detail).toMatch(/stopped it before its isolation was shown/);
    // Longer than the holder took to answer: it was asked for nothing after the stop, and no
    // executor was started.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(askedSoFar()).toBe("probe\n");
    expect(existsSync(started())).toBe(false);
    expect(flushed).toBe(1);
    expect(() => backend.send("echo late", () => undefined)).toThrow(/gone/);
  });

  it("starts no executor once the time for the setup is up, though no timer has said so", async () => {
    // The deadline's timer is a minute away and never runs here. The clock ORCA reads is put
    // past the deadline while the setup waits for the holder, as it would be had ORCA's thread
    // been kept from its timers for that long.
    let ahead = 0;
    const { backend, exit } = isolate({
      runtime: await slowHolder({ probeMs: 400, startMs: 0 }),
      setupWaitMs: 60_000,
      clock: () => performance.now() + ahead,
    });
    await expect.poll(askedSoFar).toBe("probe\n");
    ahead = 120_000;
    await expect(backend.isolated).rejects.toThrow(/isolation was not shown in time/);
    expect((await exit).detail).toMatch(/isolation was not shown in time/);
    // The holder said the masks hold, and was still not asked to start the executor.
    expect(askedSoFar()).toBe("probe\n");
    expect(existsSync(started())).toBe(false);
  });

  it("gives no proof, and sends nothing, once the time is up after the executor was started", async () => {
    let ahead = 0;
    const { backend, exit } = isolate({
      runtime: await slowHolder({ probeMs: 0, startMs: 400 }),
      setupWaitMs: 60_000,
      clock: () => performance.now() + ahead,
    });
    let heard = 0;
    backend.onMessage(() => (heard += 1));
    let flushed = 0;
    backend.send("echo never", () => (flushed += 1));
    // Asked in time. The time runs out while the holder is starting the executor.
    await expect.poll(askedSoFar).toBe("probe\nstart\n");
    ahead = 120_000;
    await expect(backend.isolated).rejects.toThrow(/isolation was not shown in time/);
    await exit;
    // The executor was started, and was sent nothing: what was waiting was dropped, not sent.
    expect(await readFile(started(), "utf8")).toBe("exec-server --listen stdio\n");
    expect(flushed).toBe(1);
    expect(heard).toBe(0);
    expect(() => backend.send("echo late", () => undefined)).toThrow(/gone/);
  });

  /**
   * A stand-in for the file system whose listings do not come back until the test lets them:
   * as a directory on a mount that has stopped answering would not. Everything else is read
   * for real.
   */
  function stuckReads() {
    const out: { path: string; back: () => void }[] = [];
    const reads: CodexExecSetupReads = {
      readdir: (path) => new Promise((resolve) => void out.push({ path, back: () => resolve([]) })),
      stat: (path) => stat(path, { bigint: true }),
    };
    /** ORCA's descriptor for the first process, which the listing was asked through. */
    const through = (): number => Number(/^\/proc\/self\/fd\/(\d+)\/root\//.exec(out[0]!.path)![1]);
    const names = (fd: number): string => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        return "closed";
      }
    };
    return { reads, out, through, names };
  }

  it("is refused at its deadline though a read of the file system never came back, and gives no proof when it does", async () => {
    const { reads, out, through, names } = stuckReads();
    try {
      const { backend, exit } = isolate({
        runtime: await slowHolder({ probeMs: 0, startMs: 0 }),
        reads,
        setupWaitMs: 4000,
      });
      let flushed = 0;
      backend.send("echo never", () => (flushed += 1));
      // The setup has asked what is in the first hidden directory, and is not answered.
      await expect.poll(() => out.length, { timeout: 3500 }).toBe(1);
      expect(codexExecReadsOut()).toBe(1);
      const fd = through();
      const named = names(fd);
      expect(named).toMatch(/^\/proc\/\d+$/);

      // The deadline settles it, with the read still out.
      await expect(backend.isolated).rejects.toThrow(/not shown in time: a read of the file system has not come back/);
      const ended = await exit;
      expect(ended.detail).toMatch(/not shown in time/);
      // The namespace was ended then, and ORCA saw it end through its descriptor for the holder.
      expect(ended.nothingLeft).toBe(true);
      expect(flushed).toBe(1);
      // The read is still counted, and the descriptor it was asked through is still that one:
      // the read has yet to follow its name, and must not find another file under it.
      expect(codexExecReadsOut()).toBe(1);
      expect(names(fd).startsWith(named)).toBe(true);

      // The read comes back, late. Nobody hears of it: no proof, nothing asked of the holder.
      out[0]!.back();
      await expect.poll(codexExecReadsOut).toBe(0);
      await expect.poll(() => names(fd).startsWith(named)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(out.length).toBe(1);
      expect(askedSoFar()).toBe(false);
      expect(existsSync(started())).toBe(false);
      expect(() => backend.send("echo late", () => undefined)).toThrow(/gone/);
    } finally {
      for (const read of out) read.back();
    }
  });

  it("is ended by a stop though a read of the file system never came back", async () => {
    const { reads, out, through, names } = stuckReads();
    try {
      const { backend, exit } = isolate({
        runtime: await slowHolder({ probeMs: 0, startMs: 0 }),
        reads,
        setupWaitMs: 120_000,
      });
      await expect.poll(() => out.length, { timeout: 10_000 }).toBe(1);
      const fd = through();
      const named = names(fd);

      const began = Date.now();
      await backend.stop();
      await expect(backend.isolated).rejects.toThrow(/stopped it before its isolation was shown/);
      const ended = await exit;
      // Neither the read nor the deadline was waited for.
      expect(Date.now() - began).toBeLessThan(5000);
      expect(ended.detail).toMatch(/stopped it before its isolation was shown/);
      expect(ended.nothingLeft).toBe(true);
      expect(codexExecReadsOut()).toBe(1);
      expect(names(fd).startsWith(named)).toBe(true);

      out[0]!.back();
      await expect.poll(codexExecReadsOut).toBe(0);
      await expect.poll(() => names(fd).startsWith(named)).toBe(false);
      expect(askedSoFar()).toBe(false);
      expect(existsSync(started())).toBe(false);
    } finally {
      for (const read of out) read.back();
    }
  });

  it("is over when its namespace ends by itself, though a read of the file system never came back", async () => {
    const { reads, out } = stuckReads();
    try {
      const { backend, exit } = isolate({ reads, setupWaitMs: 120_000 });
      await expect.poll(() => out.length, { timeout: 10_000 }).toBe(1);
      // Not ORCA's doing: its bubblewrap is killed, and the kernel ends the namespace with it.
      process.kill(backend.pid!, "SIGKILL");
      await expect(backend.isolated).rejects.toThrow(
        /the executor's namespace ended before its isolation was shown \(signal SIGKILL\)/,
      );
      expect((await exit).detail).toMatch(/signal SIGKILL/);
      expect(existsSync(started())).toBe(false);
      expect(() => backend.send("echo late", () => undefined)).toThrow(/gone/);
    } finally {
      for (const read of out) read.back();
    }
  });

  it("has no more reads of the file system out than its limit, whatever setups ask for them", async () => {
    const stuck = stuckReads();
    try {
      // As many setups as there are places, each given up with its read still out.
      for (let n = 0; n < CODEX_EXEC_READS_AT_ONCE; n += 1) {
        const { backend } = isolate({ reads: stuck.reads, setupWaitMs: 120_000 });
        await expect.poll(() => stuck.out.length, { timeout: 10_000 }).toBe(n + 1);
        await backend.stop();
        await expect(backend.isolated).rejects.toThrow(/stopped/);
      }
      expect(codexExecReadsOut()).toBe(CODEX_EXEC_READS_AT_ONCE);

      // One more setup: its read waits for a place, and is never made. It is refused at its
      // own deadline, for that reason.
      let asked = 0;
      const counted: CodexExecSetupReads = {
        readdir: (path) => ((asked += 1), stuck.reads.readdir(path)),
        stat: (path) => ((asked += 1), stuck.reads.stat(path)),
      };
      const waited = isolate({ reads: counted, setupWaitMs: 2500 });
      await expect(waited.backend.isolated).rejects.toThrow(
        /not shown in time: reads of the file system that other setups asked for have not come back/,
      );
      await waited.exit;
      expect(asked).toBe(0);
      expect(codexExecReadsOut()).toBe(CODEX_EXEC_READS_AT_ONCE);

      // The reads come back. The setup that gave up waiting is not given a place after all,
      // and a new one is shown as any other is.
      for (const read of stuck.out) read.back();
      await expect.poll(codexExecReadsOut).toBe(0);
      expect(asked).toBe(0);
      const { backend, run } = isolate();
      await backend.isolated;
      expect(await run("echo here")).toBe("here\n");
      expect(codexExecReadsOut()).toBe(0);
    } finally {
      for (const read of stuck.out) read.back();
    }
  });

  it("makes no read for a setup whose time was up when a place came to it, and gives the place to the next", async () => {
    const stuck = stuckReads();
    try {
      for (let n = 0; n < CODEX_EXEC_READS_AT_ONCE; n += 1) {
        const { backend } = isolate({ reads: stuck.reads, setupWaitMs: 120_000 });
        await expect.poll(() => stuck.out.length, { timeout: 10_000 }).toBe(n + 1);
        await backend.stop();
        await expect(backend.isolated).rejects.toThrow(/stopped/);
      }
      // Two setups wait for a place, in this order. The first has a clock the test can put
      // past its deadline, and a timer a minute away that never says so. Both read for real.
      let ahead = 0;
      let asked = 0;
      const counted: CodexExecSetupReads = {
        readdir: (path) => ((asked += 1), readdir(path)),
        stat: (path) => ((asked += 1), stat(path, { bigint: true })),
      };
      const late = isolate({ reads: counted, setupWaitMs: 60_000, clock: () => performance.now() + ahead });
      await expect.poll(codexExecReadsWaiting, { timeout: 10_000 }).toBe(1);
      const next = isolate();
      await expect.poll(codexExecReadsWaiting, { timeout: 10_000 }).toBe(2);
      ahead = 120_000;

      // One place comes free. It is offered to the first, whose time is up: no read is made
      // for it, and it is refused. The place goes on to the second, which is shown.
      stuck.out[0]!.back();
      await expect(late.backend.isolated).rejects.toThrow(/isolation was not shown in time/);
      expect(asked).toBe(0);
      await next.backend.isolated;
      expect(await next.run("echo here")).toBe("here\n");
      expect(asked).toBe(0);
      // The other read is still out, and nothing else is: the place was given back.
      expect(codexExecReadsWaiting()).toBe(0);
      expect(codexExecReadsOut()).toBe(1);
    } finally {
      for (const read of stuck.out) read.back();
    }
    await expect.poll(codexExecReadsOut).toBe(0);
  });

  /** The kernel's status of a process, with what it says of new privileges turned round for the reads `which` picks. */
  const couldGain = (which: (read: number) => boolean) => {
    let reads = 0;
    return (file: string): string => {
      const status = readFileSync(file, "utf8");
      reads += 1;
      return which(reads) ? status.replace(/^NoNewPrivs:\t1$/m, "NoNewPrivs:\t0") : status;
    };
  };

  it("never runs the executor when the holder could gain privileges from a file it runs", async () => {
    // The first status ORCA reads is the holder's, through its descriptor for that process.
    const { backend, exit } = isolate({ status: couldGain((read) => read === 1) });
    let flushed = 0;
    backend.send("echo never > never.txt", () => (flushed += 1));
    await expect(backend.isolated).rejects.toThrow(/the holder could gain privileges from a file it runs/);
    await exit;
    // Refused before the holder was asked to start anything: the stand-in executor never ran.
    expect(existsSync(started())).toBe(false);
    expect(flushed).toBe(1);
    expect(existsSync(join(work, "never.txt"))).toBe(false);
  });

  it("sends the executor nothing when only it could gain privileges from a file it runs", async () => {
    const { backend, exit } = isolate({ status: couldGain((read) => read > 1) });
    backend.send("echo never > never.txt", () => undefined);
    await expect(backend.isolated).rejects.toThrow(/the executor could gain privileges from a file it runs/);
    await exit;
    // It had been started, which is how ORCA came to look at it. What was waiting never reached it.
    expect(existsSync(started())).toBe(true);
    expect(existsSync(join(work, "never.txt"))).toBe(false);
  });

  /** Three things a program outside the namespace might listen on, and a command's way to try each. */
  async function outsidePrograms(base: string = root) {
    const runtime = join(base, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    const abstract = `orca-1026-${process.pid}-${Date.now()}`;
    const servers: Server[] = [];
    const listening = (where: Parameters<Server["listen"]>[0]): Promise<Server> =>
      new Promise((resolve) => {
        const server = createServer((socket) => socket.end());
        servers.push(server);
        server.listen(where, () => resolve(server));
      });
    await listening({ path: join(runtime, "bus") });
    await listening({ path: `\0${abstract}` });
    const loopback = await listening({ host: "127.0.0.1", port: 0 });
    const port = (loopback.address() as { port: number }).port;
    const client = join(base, "reach.js");
    await writeFile(
      client,
      [
        'const net = require("node:net");',
        "const [kind, target] = process.argv.slice(2);",
        'const to = kind === "tcp" ? { host: "127.0.0.1", port: Number(target) } : { path: kind === "abstract" ? "\\0" + target : target };',
        "const socket = net.connect(to);",
        'socket.on("connect", () => { console.log("reached"); process.exit(0); });',
        'socket.on("error", (error) => { console.log(error.code); process.exit(0); });',
        "",
      ].join("\n"),
    );
    const tryIt = (kind: string, target: string | number) => `${process.execPath} ${client} ${kind} ${target}`;
    return {
      runtime,
      byPath: tryIt("path", join(runtime, "bus")),
      byAbstractName: tryIt("abstract", abstract),
      onLoopback: tryIt("tcp", port),
      close: () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))),
    };
  }

  it("keeps a command from a socket in a hidden directory, and with the host's network not from the loopback address or an abstract name", async () => {
    const outside = await outsidePrograms();
    try {
      masks = { ...masks, hidden: [...masks.hidden, outside.runtime] };
      const { backend, run } = isolate({ network: "host" });
      const proof = await backend.isolated;
      // The host's network was asked for: the namespace's network is ORCA's own, and the proof says so.
      expect(proof.network).toBe("host");
      expect(proof.namespaces.net).toBe(readlinkSync("/proc/self/ns/net"));
      expect(await run(outside.byPath)).toBe("ENOENT\n");
      // The stated limit: with the host's network, neither of these is closed.
      expect(await run(outside.onLoopback)).toBe("reached\n");
      expect(await run(outside.byAbstractName)).toBe("reached\n");
    } finally {
      await outside.close();
    }
  });

  it("gives a command no network unless the host's is asked for: nothing on the loopback address, no abstract name, and it still runs", async () => {
    const outside = await outsidePrograms();
    try {
      const { backend, run } = isolate();
      const proof = await backend.isolated;
      expect(proof.network).toBe("none");
      expect(proof.namespaces.net).not.toBe(readlinkSync("/proc/self/ns/net"));
      expect(readlinkSync(`/proc/${proof.executor}/ns/net`)).toBe(proof.namespaces.net);
      expect(await run("echo still here")).toBe("still here\n");
      // Nor does a file a command runs give it another user's rights.
      expect(await run("grep NoNewPrivs /proc/self/status")).toBe("NoNewPrivs:\t1\n");
      expect(await run(outside.onLoopback)).not.toBe("reached\n");
      expect(await run(outside.byAbstractName)).toBe("ECONNREFUSED\n");
      // A socket named by a path is the file system's, not the network's: masks hide those.
      expect(await run(outside.byPath)).toBe("reached\n");
    } finally {
      await outside.close();
    }
  });

  /** The stand-in closed: nothing of the host's for a command to write but `work`. */
  async function close(more: Partial<CodexExecIsolatedSpawn> = {}) {
    // Its program is somewhere a command cannot write. The test's own directory is in the
    // host's `/tmp`, which a closed executor does not have, so it is bound for it to read.
    const tools = join(root, "tools");
    await mkdir(tools);
    await copyFile(stub, join(tools, "executor.sh"));
    await chmod(join(tools, "executor.sh"), 0o755);
    return isolate({
      program: join(tools, "executor.sh"),
      env: { PATH: "/usr/bin:/bin", ORCA_STUB_STARTED: join(work, "started.txt"), TMPDIR: join(root, "host-tmp") },
      masks: { ...masks, readOnly: [...masks.readOnly, tools] },
      closed: { writable: [work] },
      ...more,
    });
  }
  /** A stand-in for bubblewrap: the real one, with one of its arguments changed first. */
  async function bubblewrapWith(change: string): Promise<string> {
    const fake = join(root, "changed-bwrap");
    await writeFile(
      fake,
      [
        "#!/bin/bash",
        "args=()",
        "changed=0",
        "while [ $# -gt 0 ]; do",
        `  ${change}`,
        '  args+=("$1")',
        "  shift",
        "done",
        `exec ${BUBBLEWRAP} "\${args[@]}"`,
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    return fake;
  }

  it("closed, lets a command write its own directory and a temporary directory of the namespace's own, and nothing else", async () => {
    const name = `orca-1026-closed-${process.pid}-${Date.now()}`;
    await writeFile(join(tmpdir(), name), "the host's\n");
    try {
      const { backend, run } = await close();
      const proof = await backend.isolated;
      // What the proof says, ORCA saw: these directories and no other, and namespaces and a filter of its own.
      expect(proof.closed).toEqual({ writable: [work] });
      expect(proof.namespaces.ipc).not.toBe(readlinkSync("/proc/self/ns/ipc"));
      expect(readFileSync(`/proc/${proof.executor}/status`, "utf8")).toMatch(/^Seccomp:\t2$/m);
      expect(await run(`echo mine > ${work}/out.txt && cat ${work}/out.txt`)).toBe("mine\n");
      expect(await readFile(join(work, "out.txt"), "utf8")).toBe("mine\n");
      // A directory of the host's that anyone may write: not from here, and nothing is left there.
      expect(await run(`echo left > /var/tmp/${name}`)).toMatch(/Read-only file system/);
      expect(existsSync(`/var/tmp/${name}`)).toBe(false);
      // The agent's area inside ORCA's store is still its to write, and the store around it is not.
      expect(await run(`echo deliverable > ${store}/work/out.txt && cat ${store}/work/out.txt`)).toBe("deliverable\n");
      expect(await run(`echo changed >> ${store}/events.log`)).toMatch(/Read-only file system/);
      // Its temporary directory is its own: the host's file is not in it, and its file is not in the host's.
      expect(await run(`cat /tmp/${name}`)).toMatch(/No such file/);
      expect(await run(`echo temporary > /tmp/${name} && cat /tmp/${name}`)).toBe("temporary\n");
      expect(await readFile(join(tmpdir(), name), "utf8")).toBe("the host's\n");
      // No variable sends a program to a temporary directory of the host's, and `/run` is empty.
      expect(await run('echo "[$TMPDIR]"; ls -A /run')).toBe("[]\n");
      // Devices of its own: a terminal can still be made, and the host's shared memory is not there.
      expect(await run("ls /dev/pts; ls -A /dev/shm; script -qc 'echo on-a-terminal' /dev/null")).toBe(
        "ptmx\non-a-terminal\r\n",
      );
    } finally {
      await rm(join(tmpdir(), name), { force: true });
    }
  });

  it("closed, gives a command no socket with a name, wherever the socket is, and no way round the filter", async () => {
    // The programs outside listen in the command's own writable directory: nothing hides their sockets.
    const outside = await outsidePrograms(work);
    try {
      const { backend, run } = await close();
      await backend.isolated;
      expect(await run(`test -S ${outside.runtime}/bus && echo there`)).toBe("there\n");
      expect(await run(outside.byPath)).toBe("EACCES\n");
      expect(await run(outside.byAbstractName)).toBe("EACCES\n");
      expect(await run(outside.onLoopback)).not.toBe("reached\n");
      await writeFile(
        join(work, "sockets.py"),
        [
          "import ctypes, errno, socket",
          "def tried(name, make):",
          "    try:",
          "        make()",
          '        print(name, "made")',
          "    except OSError as error:",
          "        print(name, errno.errorcode.get(error.errno, error.errno))",
          'tried("stream-pair", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM))',
          'tried("datagram-pair", lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM))',
          'tried("datagram", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM))',
          'tried("hypervisor", lambda: socket.socket(40, socket.SOCK_STREAM))',
          'tried("packet", lambda: socket.socket(17, socket.SOCK_RAW))',
          'tried("network", lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM))',
          'tried("routes", lambda: socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0))',
          'tried("device-events", lambda: socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 15))',
          'tried("audit", lambda: socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 9))',
          "libc = ctypes.CDLL(None, use_errno=True)",
          "ring = libc.syscall(425, 4, ctypes.create_string_buffer(256))",
          'print("ring", "made" if ring >= 0 else errno.errorcode.get(ctypes.get_errno()))',
          "",
        ].join("\n"),
      );
      // An unnamed connected pair still works (a program's pipes to its children are that), a
      // socket of the network's is made in a network that has nothing in it, and so is the one a
      // program asks that network's addresses with. No other kind of the kernel's is.
      expect(await run(`python3 ${work}/sockets.py`)).toBe(
        [
          "stream-pair made",
          "datagram-pair EACCES",
          "datagram EACCES",
          "hypervisor EACCES",
          "packet EACCES",
          "network made",
          "routes made",
          "device-events EACCES",
          "audit EACCES",
          "ring ENOSYS",
          "",
        ].join("\n"),
      );
      // The kernel lists a command's own process as filtered too: the filter is every later process's.
      expect(await run("grep Seccomp: /proc/self/status")).toBe("Seccomp:\t2\n");
    } finally {
      await outside.close();
    }
  });

  it("closed, does not keep a command from a named pipe of the user's that a program outside reads (the stated limit)", async () => {
    // A pipe with a name is no socket, and a read-only file system does not protect it. This one
    // is in the directory the stand-in's program is in, which the namespace has read-only.
    const { backend, run } = await close();
    const tools = join(root, "tools");
    const pipe = join(tools, "pipe-outside");
    execFileSync("mkfifo", [pipe]);
    const reader = spawn("/bin/sh", ["-c", `cat "${pipe}" > "${join(root, "read-outside.txt")}"`], { stdio: "ignore" });
    const read = new Promise((resolve) => reader.once("exit", resolve));
    await backend.isolated;
    // The directory is read-only to the command, and nothing can be made in it.
    expect(await run(`echo new > ${tools}/made.txt`)).toMatch(/Read-only file system/);
    expect(existsSync(join(tools, "made.txt"))).toBe(false);
    expect(await run(`echo through > ${pipe}; echo $?`)).toBe("0\n");
    await read;
    expect(await readFile(join(root, "read-outside.txt"), "utf8")).toBe("through\n");
  });

  it("closed, is refused before anything is started when what is asked for is not closed", async () => {
    expect(() => isolate({ closed: { writable: [work] }, network: "host" })).toThrow(/has no network/);
    expect(() => isolate({ closed: { writable: [join(work, "not-there")] } })).toThrow(/not a directory's own path/);
    // The whole file system is not a directory to give.
    expect(() => isolate({ closed: { writable: ["/"] } })).toThrow(/not a directory's own path/);
    expect(() => isolate({ closed: { writable: [join(config, "auth")] } })).toThrow(/a writable directory is hidden/);
    // What a command is given never opens what ORCA keeps read-only: not the directory, and
    // nothing inside it. The agent's area there is writable by the masks and no other way.
    for (const inside of masks.readOnly.flatMap((kept) => [kept, join(kept, "work")])) {
      await mkdir(inside, { recursive: true });
      expect(() => isolate({ closed: { writable: [inside] } })).toThrow(
        /a writable directory is inside a directory that is kept read-only/,
      );
    }
    // Nor the other way round: a protected directory inside what a command is given could be
    // moved aside with the directory above it.
    expect(() => isolate({ closed: { writable: [root] } })).toThrow(
      /a directory ORCA protects is inside a writable directory/,
    );
    await mkdir(join(work, "deep", "kept"), { recursive: true });
    for (const kind of ["readOnly", "hidden"] as const)
      expect(() =>
        isolate({
          closed: { writable: [work] },
          masks: { ...masks, [kind]: [...masks[kind], join(work, "deep", "kept")] },
        }),
      ).toThrow(/a directory ORCA protects is inside a writable directory: .*deep\/kept/);
    // And a request that names one directory inside another is not taken to mean either.
    await mkdir(join(work, "sub"), { recursive: true });
    expect(() => isolate({ closed: { writable: [work, join(work, "sub")] } })).toThrow(
      /a writable directory is inside another/,
    );
  });

  it("closed, is refused when the namespace that was made is not under the filter, can write the file system, or takes mounts from outside", async () => {
    const unfiltered = await close({
      bubblewrap: await bubblewrapWith('if [ "$1" = "--seccomp" ]; then shift 2; continue; fi'),
    });
    await expect(unfiltered.backend.isolated).rejects.toThrow(/the holder is not under a filter/);
    expect((await unfiltered.exit).nothingLeft).toBeDefined();
    await rm(join(root, "tools"), { recursive: true });
    const writable = await close({
      bubblewrap: await bubblewrapWith(
        'if [ "$1" = "--ro-bind" ] && [ $changed = 0 ]; then args+=("--bind"); changed=1; shift; continue; fi',
      ),
    });
    await expect(writable.backend.isolated).rejects.toThrow(/not closed: the file system is not read-only/);
    // A directory of the host's bound writable that a command was not given. Its top is not the
    // user's to write: it is refused for what the mount table says, not for what could be done there.
    await rm(join(root, "tools"), { recursive: true });
    const extra = join(root, "not-given");
    await mkdir(join(extra, "below"), { recursive: true });
    await chmod(extra, 0o555);
    const more = await close({
      bubblewrap: await bubblewrapWith(
        `if [ "$1" = "--chdir" ] && [ $changed = 0 ]; then args+=("--bind" "${extra}" "${extra}"); changed=1; fi`,
      ),
    });
    try {
      await expect(more.backend.isolated).rejects.toThrow(
        /not closed: .*not-given is the host's and writable in the namespace/,
      );
    } finally {
      await chmod(extra, 0o755);
    }
    // Another directory bound where the one a command was given should be.
    await rm(join(root, "tools"), { recursive: true });
    const swapped = await close({
      bubblewrap: await bubblewrapWith(
        `if [ "$1" = "--bind" ] && [ "$2" = "${work}" ]; then args+=("--bind" "${extra}"); shift 2; continue; fi`,
      ),
    });
    await expect(swapped.backend.isolated).rejects.toThrow(
      /a writable directory is not the directory itself in the namespace/,
    );
    // The table can say the right file system and place while what is at the path, looked at
    // through the namespace's own root, is another directory: that look is made as well.
    await rm(join(root, "tools"), { recursive: true });
    const other = await close({
      reads: {
        readdir: (path) => readdir(path),
        stat: async (path) =>
          path.endsWith(`/root${work}`) ? { dev: 0n, ino: 0n } : await stat(path, { bigint: true }),
      },
    });
    await expect(other.backend.isolated).rejects.toThrow(
      /a writable directory is not the directory itself in the namespace/,
    );
    // Mounts that follow mounts made outside the namespace, which is how bubblewrap leaves them
    // on a host that shares its mounts: a disk mounted there later would appear here, writable.
    await rm(join(root, "tools"), { recursive: true });
    const following = join(root, "following-unshare");
    await writeFile(
      following,
      [
        "#!/bin/bash",
        "args=()",
        'for arg in "$@"; do',
        '  if [ "$arg" = "private" ]; then arg=shared; fi',
        '  args+=("$arg")',
        "done",
        'exec unshare "${args[@]}"',
        "",
      ].join("\n"),
    );
    await chmod(following, 0o755);
    const follows = await close({ unshare: following });
    await expect(follows.backend.isolated).rejects.toThrow(
      /not closed: a mount made outside afterwards would appear at/,
    );
    // No executor was started any of the times.
    expect(existsSync(join(work, "started.txt"))).toBe(false);
  });

  it("is refused when what is at an agent's area in the namespace is another directory, closed or not", async () => {
    // The table can show a writable mount at the agent's area while what is there, looked at
    // through the namespace's own root, is another directory. That look is made for the
    // agent's areas as for the directories a command was given.
    const area = masks.writable[0]!;
    const reads: CodexExecSetupReads = {
      readdir: (path) => readdir(path),
      stat: async (path) => (path.endsWith(`/root${area}`) ? { dev: 0n, ino: 0n } : await stat(path, { bigint: true })),
    };
    const open = isolate({ reads });
    await expect(open.backend.isolated).rejects.toThrow(
      `a writable directory is not the directory itself in the namespace: ${area}`,
    );
    const closed = await close({ reads });
    await expect(closed.backend.isolated).rejects.toThrow(
      `a writable directory is not the directory itself in the namespace: ${area}`,
    );
    // No executor was started either time.
    expect(existsSync(started())).toBe(false);
    expect(existsSync(join(work, "started.txt"))).toBe(false);
  });

  it("keeps a hidden directory out of reach by its name, through a link and after its parent is renamed", async () => {
    const { backend, run } = isolate();
    await backend.isolated;
    const token = join(config, "auth", "owner.token");
    expect(await run(`cat ${token}; ls -A ${join(config, "auth")} | wc -l`)).toMatch(/No such file[^\n]*\n0\n$/);
    expect(await run(`ln -s ${join(config, "auth")} ${work}/peek && cat ${work}/peek/owner.token`)).toMatch(
      /No such file/,
    );
    const moved = join(root, "moved");
    expect(await run(`mv ${config} ${moved} && cat ${moved}/auth/owner.token; mv ${moved} ${config}`)).toMatch(
      /No such file/,
    );
    expect(await run(`cat ${join(store, "private-execution", "key")}`)).toMatch(/No such file/);
    // The mask cannot be lifted, moved or written from inside, also from a user namespace made there.
    const lifted = await run(
      `umount ${join(config, "auth")}; mv ${join(config, "auth")} ${root}/auth2; touch ${join(config, "auth")}/x; ` +
        `unshare -Urm sh -c 'umount ${join(config, "auth")}; cat ${token}'; cat ${token}`,
    );
    expect(lifted).not.toMatch(/the-owner-token/);
    expect(lifted).toMatch(/must be superuser|not permitted/);
    expect(lifted).toMatch(/Device or resource busy/);
    expect(lifted).toMatch(/Read-only file system/);
    // From outside nothing changed.
    expect(await readFile(token, "utf8")).toBe("the-owner-token\n");
    expect(existsSync(join(root, "auth2"))).toBe(false);
  });

  it("lets a read-only directory be read and not changed, and its writable part be written", async () => {
    const { backend, run } = isolate();
    await backend.isolated;
    const events = join(store, "events.log");
    expect(await run(`cat ${events}`)).toBe("events\n");
    const tried = await run(
      `echo more >> ${events}; echo new > ${store}/new.txt; mv ${events} ${store}/gone.log; ln ${events} ${work}/alias`,
    );
    expect(tried.match(/Read-only file system/g)?.length).toBe(3);
    // A second name for a protected file cannot be made from inside: the mask is another mount.
    expect(tried).toMatch(/Invalid cross-device link/);
    expect(await readFile(events, "utf8")).toBe("events\n");
    expect(existsSync(join(store, "new.txt"))).toBe(false);
    expect(await run(`echo deliverable > ${store}/work/out.txt && cat ${store}/work/out.txt`)).toBe("deliverable\n");
    expect(await readFile(join(store, "work", "out.txt"), "utf8")).toBe("deliverable\n");
    // A file ORCA writes later, from outside, is seen inside, and is read-only there too.
    await writeFile(join(store, "later.log"), "later\n");
    expect(await run(`cat ${store}/later.log; echo x >> ${store}/later.log`)).toMatch(
      /^later\n.*Read-only file system/s,
    );
  });

  it("hands a directory to the holder, shown from outside to be the one ORCA held", async () => {
    const { backend, run } = isolate();
    const proof = await backend.isolated;
    const binder = codexExecGateBinder();
    const mine = binder.directory(join(work, "sub"))!;
    const inner = (await backend.hold(mine))!;
    expect(inner).toMatchObject({ real: join(work, "sub"), endsWithExecutor: true });
    expect(inner.reach).toMatch(/^\/proc\/1\/fd\/\d+$/);
    // ORCA's own descriptor is closed; the holder's holds the same directory, seen from here.
    expect(existsSync(mine.reach)).toBe(false);
    const theirs = `/proc/${proof.holder}/fd/${inner.reach.split("/").at(-1)!}`;
    expect(readlinkSync(theirs)).toBe(join(work, "sub"));
    // The name now leads elsewhere. A command started in the hold is in the directory that was held.
    await mkdir(join(root, "elsewhere"));
    await rename(join(work, "sub"), join(work, "moved"));
    await symlink(join(root, "elsewhere"), join(work, "sub"));
    expect(await run(`cd ${inner.reach} && ls && pwd -P`)).toBe(`here.txt\n${join(work, "moved")}\n`);
    inner.release();
    inner.release();
    await expect.poll(() => existsSync(theirs)).toBe(false);
  });

  it("holds nothing it cannot show to be ORCA's directory", async () => {
    const { backend } = isolate();
    await backend.isolated;
    const binder = codexExecGateBinder();
    // Inside, a hidden directory's name leads to the mask, which is not the directory ORCA holds.
    const hidden = binder.directory(join(config, "auth"))!;
    expect(await backend.hold(hidden)).toBeUndefined();
    expect(existsSync(hidden.reach)).toBe(true);
    hidden.release();
    // A name that became a link after ORCA opened the directory is not followed by the holder.
    const swapped = binder.directory(join(work, "sub"))!;
    await rename(join(work, "sub"), join(work, "moved"));
    await symlink(root, join(work, "sub"));
    // ORCA's descriptor names the directory where it now is, so the holder is asked for that.
    expect(swapped.real).toBe(join(work, "sub"));
    expect(await backend.hold(swapped)).toBeUndefined();
    swapped.release();
    // Once the executor is gone there is no one to hold anything.
    await backend.stop();
    const late = binder.directory(work)!;
    expect(await backend.hold(late)).toBeUndefined();
    late.release();
  });

  it("ends every process the executor started when it ends, and says so only having seen it", async () => {
    const { backend, run, exit } = isolate();
    const proof = await backend.isolated;
    // A process that left its session and its parent, as a command meaning to stay would.
    await run(`(setsid nohup bash -c 'exec -a orca-1026-isolation-sleeper sleep 300' > /dev/null 2>&1 &); sleep 0.3`);
    expect(sleepers()).toBe(1);
    await backend.stop();
    expect(await exit).toEqual({ detail: "exit 0", nothingLeft: true });
    // Seen from here at the moment ORCA heard the exit: the holder is gone, and so is the rest.
    expect(existsSync(`/proc/${proof.holder}`)).toBe(false);
    expect(sleepers()).toBe(0);
  });

  it("ends them when the executor will not stop, by ending the holder", async () => {
    const { backend, run, exit } = isolate({ stopGraceMs: 300 });
    await backend.isolated;
    // An executor that ignores its input closing and every signal a process in its namespace could send.
    await run(`(setsid nohup bash -c 'exec -a orca-1026-isolation-sleeper sleep 300' > /dev/null 2>&1 &); sleep 0.3`);
    backend.send("trap '' TERM HUP INT; exec -a orca-1026-isolation-sleeper sleep 300 < /dev/null", () => undefined);
    await expect.poll(() => sleepers()).toBe(2);
    await backend.stop();
    const ended = await exit;
    expect(ended.nothingLeft).toBe(true);
    expect(sleepers()).toBe(0);
  });

  it("ends them when ORCA's bubblewrap is killed, and claims only what it saw", async () => {
    const { backend, run, exit } = isolate();
    const proof = await backend.isolated;
    await run(`(setsid nohup bash -c 'exec -a orca-1026-isolation-sleeper sleep 300' > /dev/null 2>&1 &); sleep 0.3`);
    expect(sleepers()).toBe(1);
    process.kill(backend.pid!, "SIGKILL");
    const ended = await exit;
    expect(ended.detail).toBe("signal SIGKILL");
    // The kernel ends the namespace with ORCA's bubblewrap. Whether ORCA had seen that by the
    // time it heard the exit is said as it was, and is true only if the holder was gone.
    expect(typeof ended.nothingLeft).toBe("boolean");
    await expect.poll(() => existsSync(`/proc/${proof.holder}`), { timeout: 5000 }).toBe(false);
    await expect.poll(() => sleepers(), { timeout: 5000 }).toBe(0);
  });

  it("starts no executor, and sends nothing, when the isolation cannot be shown", async () => {
    // A stand-in for bubblewrap that names a process and runs the holder with no namespace at all.
    const fake = join(root, "fake-bwrap");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        'echo "{\\"child-pid\\": $$}" >&4',
        'while [ "$1" != "--" ]; do shift; done',
        "shift",
        'exec "$@"',
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    const { backend, exit } = isolate({ bubblewrap: fake });
    let flushed = 0;
    backend.send("echo never", () => (flushed += 1));
    await expect(backend.isolated).rejects.toThrow(/holder is not/);
    const ended = await exit;
    expect(ended.detail).toMatch(/holder is not/);
    // The process the stand-in named was never verified, so its being gone is no proof of anything.
    expect(ended.nothingLeft).toBe(false);
    // What was waiting was dropped, nothing more can be sent, and the stand-in executor never ran.
    expect(flushed).toBe(1);
    expect(() => backend.send("echo late", () => undefined)).toThrow(/gone/);
    expect(existsSync(started())).toBe(false);
  });

  it("says why when the namespace cannot be made", async () => {
    const fails = join(root, "failing-bwrap");
    await writeFile(fails, "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n");
    await chmod(fails, 0o755);
    const { backend, exit } = isolate({ bubblewrap: fails });
    await expect(backend.isolated).rejects.toThrow(/could not be made.*Permission denied/);
    const ended = await exit;
    expect(ended.detail).toMatch(/^exit 1: /);
    // No executor was started. ORCA verified no first process either, so it claims to have seen nothing end.
    expect(ended.nothingLeft).toBe(false);
    expect(existsSync(started())).toBe(false);
  });

  it("does not mask a file reached by a second name made before the executor started", async () => {
    // The limit the gate answers by refusing a file request for any file with two names.
    await link(join(store, "events.log"), join(work, "second-name.log"));
    const { backend, run } = isolate();
    await backend.isolated;
    await run(`echo through-the-other-name >> ${work}/second-name.log`);
    expect(await readFile(join(store, "events.log"), "utf8")).toBe("events\nthrough-the-other-name\n");
  });
});
