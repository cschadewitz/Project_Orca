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
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexExecIsolationError,
  codexExecGateBinder,
  codexExecMasks,
  parseMountInfo,
  spawnIsolatedCodexExecServer,
  systemBubblewrap,
  type CodexExecIsolatedSpawn,
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
    expect(parseMountInfo(table)).toEqual([
      { point: "/", options: ["rw", "relatime"], type: "ext4" },
      { point: "/home/u/my store", options: ["ro", "relatime"], type: "ext4" },
      { point: "/home/u/my store/private", options: ["ro", "nosuid", "nodev", "relatime"], type: "tmpfs" },
      { point: "/tab\tand\\slash", options: ["rw"], type: "tmpfs" },
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
    // No holder was ever seen, so no executor was started and nothing of one is left.
    expect(ended.nothingLeft).toBe(true);
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
