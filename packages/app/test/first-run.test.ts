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
import { syntheticFirstRunWriter } from "./fixtures/synthetic-first-run-writer.js";
import { FirstRunOwnershipRefusal } from "../src/main/first-run/ownership.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function rig() {
  const root = await mkdtemp(join(process.cwd(), ".orca-first-run-test-"));
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
  it("binds update recovery to the exact saved workspace before consulting current or creating a candidate", async () => {
    const f = await rig();
    await f.prepare();
    const prepareConnection = vi.fn((path: string) => f.deps.prepareConnection(path));
    const current = vi.spyOn(f.deps, "current");
    await expect(
      f.setup.connect(f.assertCurrent, {
        workspace: join(f.workspace, "other"),
        prepareConnection,
      }),
    ).rejects.toThrow();
    expect(current).not.toHaveBeenCalled();
    expect(prepareConnection).not.toHaveBeenCalled();
    expect(f.prepareConnection).not.toHaveBeenCalled();
    await f.setup.connect(f.assertCurrent, { workspace: f.workspace, prepareConnection });
    expect(prepareConnection).toHaveBeenCalledExactlyOnceWith(f.workspace);
    expect(f.activate).toHaveBeenCalledOnce();
  });
  it("rechecks recovery cancellation after authentication and disposes without activation", async () => {
    const f = await rig();
    await f.prepare();
    const before = await readFile(f.deps.receiptPath, "utf8");
    let finish!: (hello: HelloResult) => void;
    f.handshake.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.setup.connect(f.assertCurrent, {
      workspace: f.workspace,
      prepareConnection: (path) => f.deps.prepareConnection(path),
    });
    const refused = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.handshake).toHaveBeenCalledOnce());
    f.changeEpoch();
    finish(f.hello);
    await refused;
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(await readFile(f.deps.receiptPath, "utf8")).toBe(before);
  });
  it("enrolls the reviewed workspace before configuration writes and refuses failed enrollment", async () => {
    const f = await rig();
    const enroll = vi.fn(async (path: string) => {
      expect(path).toBe(f.workspace);
      expect(await readdir(path)).toEqual([]);
      throw new Error("Enrollment did not settle");
    });
    f.deps.enroll = enroll;
    await expect(f.prepare()).rejects.toThrow("Project setup could not verify");
    expect(enroll).toHaveBeenCalledOnce();
    expect(await readdir(f.workspace)).toEqual([]);
    expect(f.prepareConnection).not.toHaveBeenCalled();
  });
  it("writes configuration only after reviewed-root enrollment has settled", async () => {
    const f = await rig();
    const enroll = vi.fn(async (path: string) => {
      expect(await readdir(path)).toEqual([]);
      await writeFile(join(path, ".orca-update-window.json"), "fixture enrollment anchor\n", { mode: 0o600 });
    });
    f.deps.enroll = enroll;
    await f.prepare();
    expect(enroll).toHaveBeenCalledOnce();
    expect(await readFile(join(f.workspace, ".orca-update-window.json"), "utf8")).toBe("fixture enrollment anchor\n");
    expect(await readdir(f.workspace)).toContain("orca.config.yaml");
    expect(f.prepareConnection).not.toHaveBeenCalled();
  });
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
  it("keeps the saved selection through commits, a branch switch and a detached HEAD in the project", async () => {
    const f = await rig();
    await f.prepare();
    const commit = (message: string) =>
      f.git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        message,
      );
    const receipt = await readFile(f.deps.receiptPath, "utf8");
    commit("ordinary work after setup");
    expect((await new FirstRunSetup(f.deps).status()).state).toBe("prepared");
    f.git("checkout", "-b", "feature");
    commit("work on another branch");
    expect((await new FirstRunSetup(f.deps).status()).state).toBe("prepared");
    await new FirstRunSetup(f.deps).connect(f.assertCurrent);
    expect(f.activate).toHaveBeenCalledExactlyOnceWith(f.hello);
    f.git("checkout", "--detach", "prepared");
    expect((await new FirstRunSetup(f.deps).status()).state).toBe("prepared");
    // The reviewed branch and base stay as recorded provenance; nothing rewrites the receipt.
    expect(await readFile(f.deps.receiptPath, "utf8")).toBe(receipt);
  });
  it.each(["replaced", "not-a-repository"] as const)(
    "refuses a %s project at the saved path without starting anything",
    async (kind) => {
      const f = await rig();
      await f.prepare();
      if (kind === "replaced") {
        await rename(f.project, `${f.project}.old`);
        await mkdir(f.project);
        f.git("init", "-b", "prepared");
        f.git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "--no-gpg-sign",
          "-m",
          "a different repository",
        );
      } else await rename(join(f.project, ".git"), join(f.root, "preserved-git"));
      expect((await new FirstRunSetup(f.deps).status()).state).toBe("selection-required");
      await expect(new FirstRunSetup(f.deps).connect(f.assertCurrent)).rejects.toThrow();
      expect(f.prepareConnection).not.toHaveBeenCalled();
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

async function configurationRig() {
  const f = await rig();
  await f.prepare();
  const { hash, reserveFirstRunOwnership } = await import("../src/main/first-run/ownership.js");
  const owner = reserveFirstRunOwnership(f.workspace);
  let exited = false;
  syntheticFirstRunWriter(f.workspace, 123);
  owner.attach({
    pid: 123,
    url: "http://127.0.0.1:12345",
    get exited() {
      return exited;
    },
    stop: async () => {
      exited = true;
    },
  });
  owner.verify(f.hello);
  const path = join(f.workspace, "orca.config.yaml");
  const before = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const config: Record<string, unknown> & {
    agents: { id: string; command: string; env: Record<string, string> }[];
    roles: Record<string, string>;
  } = {
    ...before,
    agents: [{ id: "local-agent", command: process.execPath, env: { SECRET: "synthetic private value" } }],
    roles: { builder: "local-agent" },
  };
  let text = JSON.stringify(config) + "\n";
  await writeFile(path, text);
  let wrongTarget = false;
  const snapshot = () => ({
    config: { document: "config", path, exists: true, revision: hash(text), text, parsed: config },
    permissions: {
      document: "permissions",
      path: join(f.workspace, "orca.permissions.json"),
      exists: false,
      revision: "",
      text: "",
    },
    schema: [],
    effective: { agents: {} },
    generation: {
      savedRevision: hash(text),
      activeRevision: hash(text),
      activeGeneration: "fixture-generation",
      state: "active",
      restartRequired: [],
    },
    asOf: "2026-10-09T00:00:00Z",
  });
  const call = vi.fn().mockImplementation(async () => snapshot());
  const client = { withCapturedAuthentication: () => client, call };
  const rebind = vi.fn((expected: string, saved: string) => owner.rebindConfig!(expected, saved));
  const deps = {
    ...f.deps,
    configuration: () => ({
      client: client as unknown as DaemonClient,
      check: () => {
        if (wrongTarget) throw new Error("target changed");
      },
      rebind,
    }),
  };
  const setup = new FirstRunSetup(deps);
  return {
    ...f,
    deps,
    setup,
    path,
    config,
    hash,
    owner,
    call,
    rebind,
    snapshot,
    exit: () => {
      exited = true;
    },
    changeTarget: () => {
      wrongTarget = true;
    },
    save: async () => {
      text = JSON.stringify(config) + "\n";
      await writeFile(path, text);
    },
  };
}
it("explicitly binds a private saved real-agent config, reopens it and preserves exact sample/store/project identity and old journal", async () => {
  const f = await configurationRig();
  expect((await f.setup.status()).state).toBe("selection-required");
  const before = await readFile(join(f.workspace, ".orca-first-run-ownership", "000001", "claim.json"), "utf8");
  const reviewed = await f.setup.reviewConfiguration(f.assertCurrent);
  if (reviewed.state !== "configuration-review") throw new Error("Expected config review");
  expect(reviewed.review.checks).toMatchObject([
    {
      agentId: "local-agent",
      state: "handshake-required",
      evidence: {
        support: "unknown",
        version: "unknown",
        acp: "not-checked",
        signIn: "unknown",
        exactCommand: "unsupported",
      },
    },
  ]);
  expect(JSON.stringify(reviewed)).not.toContain("synthetic private value");
  expect(f.call.mock.calls.map((call) => call[0])).toEqual(["config.get"]);
  const result = await f.setup.bindConfiguration(reviewed.review.id, f.assertCurrent);
  expect(result.state).toBe("prepared");
  expect(f.rebind).toHaveBeenCalledOnce();
  const reopen = new FirstRunSetup(f.deps);
  expect((await reopen.status()).state).toBe("prepared");
  expect(await readFile(join(f.project, "sentinel.txt"), "utf8")).toBe("unchanged synthetic project\n");
  expect(await readFile(join(f.workspace, ".orca-first-run-ownership", "000001", "claim.json"), "utf8")).toBe(before);
  const binding = await readFile(
    join(f.workspace, ".orca-first-run-ownership", "000001", "config-rebind-000001.json"),
    "utf8",
  );
  expect(binding).not.toContain("synthetic private value");
  expect(binding).toContain("reviewed-config-read");
  f.exit();
  expect(f.owner.complete()).toBe(true);
  const { reserveFirstRunOwnership } = await import("../src/main/first-run/ownership.js");
  expect(() => reserveFirstRunOwnership(f.workspace)).not.toThrow();
});
it.each([
  "root",
  "store",
  "host",
  "plugin",
  "sample",
  "outside-workflow",
  "invalid-generation",
  "wrong-revision",
  "wrong-path",
  "altered-asset",
])("refuses real-agent configuration rebind failure %s without rewriting receipt or ownership", async (failure) => {
  const f = await configurationRig();
  const receiptBefore = await readFile(f.deps.receiptPath, "utf8");
  if (failure === "root") f.config.workspace = { provider: "local", root: f.home, hostId: "local" };
  if (failure === "store") f.config.storeDir = "elsewhere";
  if (failure === "host") f.config.hosts = [{ id: "local", type: "ssh", host: "unrelated" }];
  if (failure === "plugin") f.config.plugins = ["unrelated-plugin"];
  if (failure === "sample") f.config.workflows = [];
  if (failure === "outside-workflow") f.config.workflows = ["first-run/workflow.yaml", "../outside.yaml"];
  await f.save();
  if (failure === "invalid-generation" || failure === "wrong-revision" || failure === "wrong-path")
    f.call.mockImplementation(async () => {
      const snapshot = f.snapshot();
      if (failure === "invalid-generation") snapshot.generation.state = "invalid";
      if (failure === "wrong-revision") snapshot.config.revision = f.hash("stale");
      if (failure === "wrong-path") snapshot.config.path = join(f.home, "other.yaml");
      return snapshot;
    });
  if (failure === "altered-asset") await writeFile(join(f.workspace, "first-run", "workflow.yaml"), "altered");
  await expect(f.setup.reviewConfiguration(f.assertCurrent)).rejects.toThrow();
  expect(f.rebind).not.toHaveBeenCalled();
  expect(await readFile(f.deps.receiptPath, "utf8")).toBe(receiptBefore);
  expect(await readdir(join(f.workspace, ".orca-first-run-ownership", "000001"))).not.toContain(
    "config-rebind-000001.json",
  );
});
it.each(["target", "epoch", "config", "receipt", "stale-review"])(
  "keeps a reviewed config draft unbound after %s changes",
  async (failure) => {
    const f = await configurationRig();
    const reviewed = await f.setup.reviewConfiguration(f.assertCurrent);
    if (reviewed.state !== "configuration-review") throw new Error("Expected config review");
    if (failure === "target") f.changeTarget();
    if (failure === "epoch") f.changeEpoch();
    if (failure === "config") {
      f.config.roles = {};
      await f.save();
    }
    if (failure === "receipt") await writeFile(f.deps.receiptPath, "{}");
    await expect(
      f.setup.bindConfiguration(
        failure === "stale-review" ? "00000000-0000-4000-8000-000000000000" : reviewed.review.id,
        f.assertCurrent,
      ),
    ).rejects.toThrow();
    expect(f.rebind).not.toHaveBeenCalled();
  },
);
it("reports a Finder PATH miss without starting an agent, auto-installing it, changing permission grants or persisting env values", async () => {
  const f = await configurationRig();
  f.config.agents[0]!.command = "unavailable-synthetic-agent";
  f.config.agents[0]!.env = { PATH: "/unavailable/synthetic/bin", SECRET: "synthetic private value" };
  await f.save();
  const reviewed = await f.setup.reviewConfiguration(f.assertCurrent);
  if (reviewed.state !== "configuration-review") throw new Error("Expected config review");
  expect(reviewed.review.checks).toMatchObject([
    { agentId: "local-agent", state: "missing", evidence: { support: "unknown", signIn: "unknown" } },
  ]);
  expect(f.rebind).not.toHaveBeenCalled();
  expect(JSON.stringify(reviewed)).not.toContain("synthetic private value");
});

it("explicitly binds Save-before-Bind after app recreation, without a live daemon or replay", async () => {
  const f = await rig();
  await f.prepare();
  const { reserveFirstRunOwnership, inspectFirstRunOwnership } = await import("../src/main/first-run/ownership.js");
  reserveFirstRunOwnership(f.workspace);
  const path = join(f.workspace, "orca.config.yaml");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  config.agents = [
    {
      id: "offline-agent",
      command: process.execPath,
      env: { SECRET: "offline synthetic private", RETAINED: "x".repeat(7000) },
    },
  ];
  await writeFile(path, JSON.stringify(config) + "\n");
  const restored = new FirstRunSetup(f.deps);
  const review = await restored.reviewConfiguration(f.assertCurrent);
  if (review.state !== "configuration-review") throw new Error("Expected offline config review");
  const originalReceipt = await readFile(f.deps.receiptPath, "utf8");
  expect(await restored.bindConfiguration(review.review.id, f.assertCurrent)).toMatchObject({ state: "prepared" });
  // Simulate interruption after the durable journal append but before receipt rename.
  await writeFile(f.deps.receiptPath, originalReceipt);
  const resumed = new FirstRunSetup(f.deps);
  const retry = await resumed.reviewConfiguration(f.assertCurrent);
  if (retry.state !== "configuration-review") throw new Error("Expected retry review");
  await resumed.bindConfiguration(retry.review.id, f.assertCurrent);
  expect(
    Object.keys(inspectFirstRunOwnership(f.workspace, true).latest!.texts).filter((name) =>
      name.startsWith("config-rebind-"),
    ),
  ).toHaveLength(1);
  expect(f.prepareConnection).not.toHaveBeenCalled();
  expect(await readFile(f.deps.receiptPath, "utf8")).not.toContain("offline synthetic private");
});

it("cancels configuration review without writing and retires the handle before retrying", async () => {
  const f = await configurationRig();
  const before = await readFile(f.deps.receiptPath, "utf8");
  const selected = await readFile(f.path, "utf8");
  const review = await f.setup.reviewConfiguration(f.assertCurrent);
  if (review.state !== "configuration-review") throw new Error("Expected review");
  await f.setup.cancelConfigurationReview(f.assertCurrent);
  await expect(f.setup.bindConfiguration(review.review.id, f.assertCurrent)).rejects.toThrow();
  expect(f.rebind).not.toHaveBeenCalled();
  expect(await readFile(f.deps.receiptPath, "utf8")).toBe(before);
  expect(await readFile(f.path, "utf8")).toBe(selected);
  const retry = await f.setup.reviewConfiguration(f.assertCurrent);
  if (retry.state !== "configuration-review") throw new Error("Expected retry review");
  expect(retry.review.id).not.toBe(review.review.id);
  await f.setup.bindConfiguration(retry.review.id, f.assertCurrent);
  expect(f.rebind).toHaveBeenCalledOnce();
  expect(f.prepareConnection).not.toHaveBeenCalled();
});
it("failed rereview retires the old handle and permits a fresh review after recovery", async () => {
  const f = await configurationRig();
  const before = await readFile(f.deps.receiptPath, "utf8");
  const review = await f.setup.reviewConfiguration(f.assertCurrent);
  if (review.state !== "configuration-review") throw new Error("Expected review");
  f.call.mockRejectedValueOnce(new Error("private transport/error needle"));
  await expect(f.setup.reviewConfiguration(f.assertCurrent)).rejects.toThrow();
  expect(f.setup.isBusy).toBe(false);
  await expect(f.setup.bindConfiguration(review.review.id, f.assertCurrent)).rejects.toThrow();
  expect(await readFile(f.deps.receiptPath, "utf8")).toBe(before);
  const retry = await f.setup.reviewConfiguration(f.assertCurrent);
  expect(retry.state).toBe("configuration-review");
  expect(f.rebind).not.toHaveBeenCalled();
});
