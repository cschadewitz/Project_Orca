/** Real temporary directory/Git setup tests with synthetic native connection candidates. No daemon or provider runs. */
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import type { DaemonClient } from "../src/client/daemon-client.js";
import { FIRST_RUN_SAMPLE, FIRST_RUN_SAMPLE_FILES } from "../src/first-run-sample.js";
import { FirstRunSetup, type FirstRunDeps } from "../src/main/first-run/setup.js";
import { ownedDirectory } from "../src/main/first-run/directories.js";
import { FirstRunOwnershipRefusal } from "../src/main/first-run/ownership.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function rig() {
  const root = await mkdtemp(join(tmpdir(), "orca-first-run-"));
  dirs.push(root);
  const home = join(root, "Home"),
    project = join(root, "Sample α project"),
    workspace = join(root, "App β workspace");
  for (const path of [home, project, workspace]) await mkdir(path);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "prepared");
  await writeFile(join(project, "sentinel.txt"), "unchanged synthetic project\n");
  git("add", "sentinel.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "synthetic fixture",
  );
  let epoch = 1;
  let active = false;
  const assertCurrent = () => {
    if (epoch !== 1) throw new Error("stale epoch");
  };
  const choose = vi.fn<FirstRunDeps["choose"]>().mockResolvedValueOnce(project).mockResolvedValueOnce(workspace);
  const hello: HelloResult = {
    protocol: PROTOCOL_VERSION,
    orcaVersion: "fixture",
    capabilities: ["runs.read", "runs.control", "runs.subscribe"],
    identity: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
    },
    storeDir: join(workspace, ".orca"),
    processId: 123,
  };
  const handshake = vi.fn().mockResolvedValue(hello);
  const discovery = { target: hello.identity!, authentication: "credential", operations: ["operator.admitRun"] };
  const client = {
    hello: handshake,
    call: vi.fn().mockResolvedValue(discovery),
    withCapturedAuthentication: () => client,
  };
  const dispose = vi.fn(async () => {});
  const activate = vi.fn(() => {
    active = true;
  });
  const prepareConnection = vi.fn<FirstRunDeps["prepareConnection"]>().mockResolvedValue({
    expectedProcessId: 123,
    client: client as unknown as DaemonClient,
    activate,
    dispose,
    check: assertCurrent,
  });
  const deps: FirstRunDeps = {
    home,
    receiptPath: join(root, "profile", "first-run.json"),
    choose,
    prepareConnection,
    current: () => active,
  };
  const setup = new FirstRunSetup(deps);
  const prepare = async () => {
    const selected = await setup.choose(assertCurrent);
    if (selected.state !== "review") throw new Error("expected review");
    return setup.prepare(selected.review.id, assertCurrent);
  };
  return {
    root,
    project,
    workspace,
    home,
    git,
    setup,
    deps,
    choose,
    hello,
    discovery,
    handshake,
    dispose,
    activate,
    prepareConnection,
    prepare,
    assertCurrent,
    changeEpoch: () => {
      epoch = 2;
    },
  };
}

describe.skipIf(typeof process.getuid !== "function")("dedicated first-run project selection", () => {
  it.each(["current", "prepare", "hello", "dispose"] as const)(
    "preserves ownership reconciliation refusal from %s through the setup wrapper",
    async (stage) => {
      const f = await rig();
      await f.prepare();
      const refusal = new FirstRunOwnershipRefusal();
      const fail = () => {
        throw refusal;
      };
      if (stage === "current") f.deps.current = fail;
      if (stage === "prepare") f.prepareConnection.mockRejectedValueOnce(refusal);
      if (stage === "hello") f.handshake.mockRejectedValueOnce(refusal);
      if (stage === "dispose") {
        f.handshake.mockRejectedValueOnce(new Error("synthetic handshake failure"));
        f.dispose.mockImplementationOnce(fail);
      }
      await expect(f.setup.connect(f.assertCurrent)).rejects.toBe(refusal);
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.setup.isBusy).toBe(false);
    },
  );
  it.each([".orca", "auth", ".orca/nested"])(
    "refuses redirected %s before spawning and preserves the external directory",
    async (name) => {
      const f = await rig();
      await f.prepare();
      if (name.includes("/")) await mkdir(join(f.workspace, ".orca"));
      await symlink(f.project, join(f.workspace, name), "dir");
      expect((await f.setup.status()).state).toBe("selection-required");
      await expect(f.setup.connect(f.assertCurrent)).rejects.toThrow();
      expect(f.prepareConnection).not.toHaveBeenCalled();
      expect(await readFile(join(f.project, "sentinel.txt"), "utf8")).toBe("unchanged synthetic project\n");
    },
  );
  it("requires review, preserves project checkout, writes only new JEV-free assets, and reconnects exact saved selection", async () => {
    const f = await rig();
    const before = {
      head: f.git("rev-parse", "HEAD"),
      status: f.git("status", "--porcelain"),
      sentinel: await readFile(join(f.project, "sentinel.txt"), "utf8"),
    };
    expect((await f.setup.status()).state).toBe("selection-required");
    const selected = await f.setup.choose(f.assertCurrent);
    expect(selected).toMatchObject({
      state: "review",
      review: { project: f.project, workspace: f.workspace, sample: FIRST_RUN_SAMPLE },
    });
    expect(await readdir(f.workspace)).toEqual([]);
    expect(f.prepareConnection).not.toHaveBeenCalled();
    if (selected.state !== "review") throw new Error("expected review");
    expect(await f.setup.prepare(selected.review.id, f.assertCurrent)).toMatchObject({ state: "prepared" });
    const config = JSON.parse(await readFile(join(f.workspace, "orca.config.yaml"), "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      agents: [],
      roles: {},
      plugins: [],
      templates: [],
      humanInput: { mode: "pause" },
      workspace: { provider: "local", root: f.project },
      workflows: ["first-run/workflow.yaml"],
    });
    for (const [name, text] of Object.entries(FIRST_RUN_SAMPLE_FILES))
      expect(await readFile(join(f.workspace, name), "utf8")).toBe(text);
    expect(f.prepareConnection).not.toHaveBeenCalled();
    const restarted = new FirstRunSetup(f.deps);
    await restarted.connect(f.assertCurrent);
    expect(f.prepareConnection).toHaveBeenCalledExactlyOnceWith(f.workspace);
    expect(f.activate).toHaveBeenCalledExactlyOnceWith(f.hello);
    await restarted.connect(f.assertCurrent);
    expect(f.prepareConnection).toHaveBeenCalledTimes(1);
    expect(f.dispose).not.toHaveBeenCalled();
    expect({
      head: f.git("rev-parse", "HEAD"),
      status: f.git("status", "--porcelain"),
      sentinel: await readFile(join(f.project, "sentinel.txt"), "utf8"),
    }).toEqual(before);
    await expect(f.setup.prepare(selected.review.id, f.assertCurrent)).rejects.toThrow();
  });
  it.each(["project", "workspace"] as const)(
    "cancelling the %s picker keeps the prior review and writes nothing",
    async (which) => {
      const f = await rig();
      const selected = await f.setup.choose(f.assertCurrent);
      if (which === "project") f.choose.mockResolvedValueOnce(undefined);
      else f.choose.mockResolvedValueOnce(f.project).mockResolvedValueOnce(undefined);
      expect(await f.setup.choose(f.assertCurrent)).toEqual(selected);
      expect(await readdir(f.workspace)).toEqual([]);
    },
  );
  it.each(["nonempty", "symlink", "inside-project", "home", "non-git", "denied"] as const)(
    "refuses %s selection without writing files",
    async (kind) => {
      const f = await rig();
      let selected = f.workspace;
      if (kind === "nonempty") await writeFile(join(selected, "personal.txt"), "preserve");
      if (kind === "symlink") {
        selected = join(f.root, "alias");
        await symlink(f.workspace, selected, "dir");
      }
      if (kind === "inside-project") {
        selected = join(f.project, "app");
        await mkdir(selected);
      }
      if (kind === "home") selected = f.home;
      if (kind === "denied") await chmod(f.workspace, 0o500);
      f.choose
        .mockReset()
        .mockResolvedValueOnce(kind === "non-git" ? f.home : f.project)
        .mockResolvedValueOnce(selected);
      await expect(f.setup.choose(f.assertCurrent)).rejects.toThrow();
      expect(await readdir(f.workspace)).toEqual(kind === "nonempty" ? ["personal.txt"] : []);
      expect(f.prepareConnection).not.toHaveBeenCalled();
    },
  );
  it.each(["replaced", "filled", "stale", "head-changed"] as const)(
    "refuses a %s reviewed root before creating assets",
    async (kind) => {
      const f = await rig();
      const selected = await f.setup.choose(f.assertCurrent);
      if (selected.state !== "review") throw new Error("expected review");
      if (kind === "replaced") {
        await rename(f.workspace, `${f.workspace}.old`);
        await mkdir(f.workspace);
      }
      if (kind === "filled") await writeFile(join(f.workspace, "personal.txt"), "preserve");
      if (kind === "stale") f.changeEpoch();
      if (kind === "head-changed")
        f.git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "changed",
        );
      await expect(f.setup.prepare(selected.review.id, f.assertCurrent)).rejects.toThrow();
      expect(await readdir(f.workspace)).toEqual(kind === "filled" ? ["personal.txt"] : []);
      expect(f.prepareConnection).not.toHaveBeenCalled();
    },
  );
  it.each(["identity", "store", "pid", "readonly", "protocol", "principal-target"] as const)(
    "disposes a candidate with wrong %s and never activates a fallback",
    async (kind) => {
      const f = await rig();
      await f.prepare();
      if (kind === "identity") delete f.hello.identity;
      if (kind === "store") f.hello.storeDir = join(f.home, ".orca");
      if (kind === "pid") f.hello.processId = 999;
      if (kind === "readonly") f.hello.capabilities = ["runs.read"];
      if (kind === "protocol") f.hello.protocol = { major: 99, minor: 0 };
      if (kind === "principal-target")
        f.discovery.target = { ...f.discovery.target, workspaceId: "33333333-3333-4333-8333-333333333333" };
      await expect(f.setup.connect(f.assertCurrent)).rejects.toThrow("No alternate daemon");
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.dispose).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses tampered assets after restart, preserves them, and ignores ambient Git routing", async () => {
    const f = await rig();
    vi.stubEnv("GIT_DIR", "/not-this-project");
    await f.prepare();
    await writeFile(join(f.workspace, "first-run/instruction.md"), "changed instruction");
    const restarted = new FirstRunSetup(f.deps);
    expect((await restarted.status()).state).toBe("selection-required");
    await expect(restarted.connect(f.assertCurrent)).rejects.toThrow();
    expect(f.prepareConnection).not.toHaveBeenCalled();
    expect(await readFile(join(f.workspace, "first-run/instruction.md"), "utf8")).toBe("changed instruction");
  });
});
it.skipIf(typeof process.getuid === "function")("unknown owner identity fails closed", async () => {
  await expect(ownedDirectory(tmpdir(), tmpdir())).rejects.toThrow();
});
