/**
 * The opt-in route for ORCA's gate in Codex's executor path (#1026), `codexExecGate:
 * experimental`, as this step ships it: every session that asks for it is refused before the
 * agent starts, with each reason found (the layout, the host, the closed executor's standing
 * shortfalls, and that the route is not wired yet), and no entry point runs the agent another
 * way. The live part makes the closed executor on this machine where bubblewrap can, and has
 * to wherever `ORCA_REQUIRE_EXEC_ISOLATION=1` says it can.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, type OrcaError } from "@orca/core";
import {
  admitCodexExecGateSession,
  CODEX_EXEC_NOT_CLOSED,
  codexExecGateHost,
  codexExecGateHostProblems,
  codexExecGateLayoutProblems,
  codexExecGateRefused,
  codexExecGateRequested,
  LocalHost,
  openAcpSession,
  systemBubblewrap,
  type AgentHost,
  type CodexExecGateHost,
  type CodexExecIsolationProof,
  type OpenSessionOptions,
} from "@orca/agents";
import { delegatingSessionFactory } from "@orca/daemon";
import { makeSessionFactory, orcaProtectedPaths } from "../src/bootstrap.js";

const BUBBLEWRAP = process.platform === "linux" ? systemBubblewrap() : undefined;
const USABLE =
  BUBBLEWRAP !== undefined &&
  spawnSync(BUBBLEWRAP, ["--unshare-user", "--unshare-pid", "--dev-bind", "/", "/", "--proc", "/proc", "/bin/true"])
    .status === 0;
const REQUIRED = process.env["ORCA_REQUIRE_EXEC_ISOLATION"] === "1";

let root: string;
let config: string;
let work: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orca-1026-route-")));
  config = join(root, "config");
  work = join(root, "work");
  await mkdir(join(config, ".orca", "work"), { recursive: true });
  await mkdir(work, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A host that could hold the route, as far as the host goes. */
const goodHost: CodexExecGateHost = {
  platform: "linux",
  arch: "x64",
  bubblewrap: "/usr/bin/bwrap",
  unshare: "/usr/bin/unshare",
  systemCodexConfig: undefined,
};

/** A host that records whether anything asked it to start an agent. */
function watchedHost(): { host: AgentHost; spawned: ReturnType<typeof vi.fn> } {
  const host: AgentHost = new LocalHost({ id: "local", type: "local" });
  const spawned = vi.fn(async () => {
    throw new Error("an agent was started");
  });
  host.spawnAgent = spawned;
  return { host, spawned };
}

const codex = (more: Record<string, unknown> = {}) =>
  AgentSpecSchema.parse({ id: "codex", command: "codex-acp", codexExecGate: "experimental", ...more });

/** What a refusal says, reason by reason. */
const reasonsOf = async (refused: Promise<unknown>): Promise<string[]> => {
  const error = (await refused.then(
    () => undefined,
    (e: unknown) => e,
  )) as OrcaError | undefined;
  expect(error?.code).toBe("NOT_SUPPORTED");
  return (error?.details?.["reasons"] as string[] | undefined) ?? [];
};

describe("the route as config sees it", () => {
  it("is off unless asked for with experimental, and never together with the hook or on a remote daemon", () => {
    expect(codexExecGateRequested(codex())).toBe(true);
    expect(codexExecGateRequested(codex({ codexExecGate: "off" }))).toBe(false);
    expect(codexExecGateRequested(AgentSpecSchema.parse({ id: "codex", command: "codex-acp" }))).toBe(false);
    expect(AgentSpecSchema.safeParse({ id: "c", command: "x", codexExecGate: "on" }).success).toBe(false);
    for (const hook of ["experimental", "on"])
      expect(
        AgentSpecSchema.safeParse({ id: "c", command: "x", codexExecGate: "experimental", nativeToolHook: hook })
          .success,
      ).toBe(false);
    expect(
      AgentSpecSchema.safeParse({ id: "c", command: "x", codexExecGate: "experimental", nativeToolHook: "off" })
        .success,
    ).toBe(true);
    expect(
      AgentSpecSchema.safeParse({
        id: "box",
        type: "orca-daemon",
        profile: "box",
        workflow: "w",
        codexExecGate: "experimental",
      }).success,
    ).toBe(false);
  });
});

describe("what keeps a layout off the route", () => {
  const layout = (more: Partial<Parameters<typeof codexExecGateLayoutProblems>[0]> = {}) => ({
    configDir: config,
    storeDir: ".orca",
    workspace: work,
    ...more,
  });

  it("takes ORCA's files apart from every directory the agent may write", () => {
    expect(codexExecGateLayoutProblems(layout())).toEqual([]);
    expect(codexExecGateLayoutProblems(layout({ additionalDirectories: [join(root, "more")] }))).toEqual([
      expect.stringMatching(/^the additional directory .*more cannot be resolved \(ENOENT\)$/),
    ]);
  });

  it("refuses the default layout, where the config directory is the workspace, and says what fixes it", () => {
    expect(codexExecGateLayoutProblems(layout({ workspace: config }))).toEqual([
      `the workspace ${config} is ORCA's config directory: on this route ORCA's files have to be outside every directory the agent may write. Set \`workspace:\` in the config to a directory outside ${config}`,
      `ORCA's store ${join(config, ".orca")} is inside the workspace ${config}, which the agent may write`,
    ]);
  });

  it("refuses ORCA's files inside a directory the agent may write, and the other way round", () => {
    expect(codexExecGateLayoutProblems(layout({ workspace: root }))).toEqual([
      `ORCA's config directory ${config} is inside the workspace ${root}, which the agent may write`,
      `ORCA's store ${join(config, ".orca")} is inside the workspace ${root}, which the agent may write`,
    ]);
    // The store's own agent area is the store's, not a workspace of the agent's.
    expect(codexExecGateLayoutProblems(layout({ workspace: join(config, ".orca", "work") }))).toEqual([
      `the workspace ${join(config, ".orca", "work")} is inside ORCA's config directory ${config}`,
      `the workspace ${join(config, ".orca", "work")} is inside ORCA's store ${join(config, ".orca")}`,
    ]);
    // A store put elsewhere, and a config file loaded from elsewhere, are kept apart the same way.
    expect(codexExecGateLayoutProblems(layout({ storeDir: join(work, "store") }))).toEqual([
      expect.stringMatching(/^ORCA's store .*work\/store cannot be resolved/),
    ]);
    expect(codexExecGateLayoutProblems(layout({ configFile: join(work, "orca.config.yaml") }))).toEqual([
      `the workspace ${work} is the directory of the config file ORCA loaded: on this route ORCA's files have to be outside every directory the agent may write. Set \`workspace:\` in the config to a directory outside ${work}`,
    ]);
  });

  it("compares the paths links lead to, not the names", async () => {
    const link = join(root, "looks-apart");
    await symlink(config, link);
    expect(codexExecGateLayoutProblems(layout({ workspace: link }))).toEqual([
      expect.stringContaining(`the workspace ${config} is ORCA's config directory`),
      `ORCA's store ${join(config, ".orca")} is inside the workspace ${config}, which the agent may write`,
    ]);
  });
});

describe("what keeps a host off the route", () => {
  it("names each reason", () => {
    expect(codexExecGateHostProblems(goodHost)).toEqual([]);
    expect(
      codexExecGateHostProblems({
        platform: "darwin",
        arch: "arm64",
        bubblewrap: undefined,
        unshare: undefined,
        systemCodexConfig: ["managed_config.toml", "requirements.toml"],
      }),
    ).toEqual([
      "the route runs on Linux x64 only, and this is darwin arm64",
      "the system has no bubblewrap of its own (root's, at /usr/bin/bwrap or /bin/bwrap, not set-user-ID)",
      "the system has no unshare of its own (root's, at /usr/bin/unshare or /bin/unshare)",
      "/etc/codex holds host-wide Codex configuration (managed_config.toml, requirements.toml), which could override or add to the settings ORCA gives Codex; an administrator-configured host is not this configuration",
    ]);
    expect(codexExecGateHostProblems({ ...goodHost, systemCodexConfig: [] })).toEqual([
      expect.stringContaining("/etc/codex holds host-wide Codex configuration (an empty directory)"),
    ]);
  });
});

describe("admission", () => {
  const admission = (more: Partial<Parameters<typeof admitCodexExecGateSession>[0]> = {}) => ({
    agentId: "codex",
    layout: { configDir: config, storeDir: ".orca", workspace: work },
    protectedPaths: orcaProtectedPaths({ configDir: config, storeDir: ".orca" }),
    host: goodHost,
    ...more,
  });
  const proof: CodexExecIsolationProof = {
    holder: 2,
    executor: 3,
    namespaces: { pid: "pid:[1]", mnt: "mnt:[1]", user: "user:[1]", net: "net:[1]", ipc: "ipc:[1]" },
    network: "none",
    masks: { hidden: [], readOnly: [], writable: [] },
    closed: { writable: [] },
    ptraceScope: 1,
  };
  /** A stand-in for the namespace backend: what it was asked for, and what it shows. */
  const isolating = (shows: Promise<CodexExecIsolationProof>) => {
    const asked: unknown[] = [];
    const stopped = vi.fn(async () => undefined);
    const isolate = vi.fn((spec: unknown) => {
      asked.push(spec);
      shows.catch(() => undefined);
      return { isolated: shows, stop: stopped } as unknown as ReturnType<
        NonNullable<Parameters<typeof admitCodexExecGateSession>[0]["isolate"]>
      >;
    });
    return { isolate, asked, stopped };
  };

  it("refuses with the closed executor's standing shortfalls, and that the route is not wired, when all else holds", async () => {
    const { isolate, asked, stopped } = isolating(Promise.resolve(proof));
    const reasons = await reasonsOf(admitCodexExecGateSession(admission({ isolate })));
    expect(reasons).toEqual([...CODEX_EXEC_NOT_CLOSED, "ORCA does not start Codex on this route yet (#1026)"]);
    // Made closed, with the workspace as the only writable directory of the host's, and ended.
    expect(asked).toEqual([expect.objectContaining({ program: "/bin/cat", cwd: work, closed: { writable: [work] } })]);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("refuses with what the namespace backend said when it could not make or show the executor", async () => {
    const { isolate, stopped } = isolating(Promise.reject(new Error("setting up uid map: Permission denied")));
    const reasons = await reasonsOf(admitCodexExecGateSession(admission({ isolate })));
    expect(reasons).toEqual([
      "the closed executor could not be made and shown: setting up uid map: Permission denied",
      "ORCA does not start Codex on this route yet (#1026)",
    ]);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("does not make the executor on a layout or host that could not hold it", async () => {
    const { isolate } = isolating(Promise.resolve(proof));
    const reasons = await reasonsOf(
      admitCodexExecGateSession(
        admission({
          isolate,
          layout: { configDir: config, storeDir: ".orca", workspace: config },
          host: { ...goodHost, systemCodexConfig: ["config.toml"] },
        }),
      ),
    );
    expect(reasons).toEqual([
      expect.stringContaining("is ORCA's config directory"),
      expect.stringContaining("is inside the workspace"),
      expect.stringContaining("/etc/codex holds host-wide Codex configuration (config.toml)"),
      "ORCA does not start Codex on this route yet (#1026)",
    ]);
    expect(isolate).not.toHaveBeenCalled();
  });

  it("says every reason in its message, numbered, and that nothing falls back", async () => {
    const { isolate } = isolating(Promise.resolve(proof));
    await expect(admitCodexExecGateSession(admission({ isolate }))).rejects.toThrow(
      /^agent codex has codexExecGate: experimental, and ORCA refuses the session: \(1\) .*named pipe.*\(4\) ORCA does not start Codex on this route yet \(#1026\)\. Nothing falls back to running Codex without the gate; remove codexExecGate to run the agent without it\.$/,
    );
  });
});

describe("the session factory and the other entry points", () => {
  it("the factory refuses before anything opens, with the layout's reason first", async () => {
    const open = vi.fn(async (_: OpenSessionOptions) => {
      throw new Error("a session was opened");
    });
    const isolate = vi.fn();
    const factory = makeSessionFactory({ configDir: config, storeDir: ".orca" }, open, undefined, {
      host: goodHost,
      isolate,
    });
    const { host, spawned } = watchedHost();
    const reasons = await reasonsOf(factory({ host, agent: codex(), cwd: config }));
    expect(reasons[0]).toContain("is ORCA's config directory");
    expect(reasons.at(-1)).toBe("ORCA does not start Codex on this route yet (#1026)");
    expect(open).not.toHaveBeenCalled();
    expect(spawned).not.toHaveBeenCalled();
    expect(isolate).not.toHaveBeenCalled();
  });

  it("the factory refuses an agent on another machine, and one with both routes built past the schema", async () => {
    const open = vi.fn();
    const factory = makeSessionFactory({ configDir: config, storeDir: ".orca" }, open, undefined, { host: goodHost });
    const ssh = new LocalHost({ id: "box", type: "ssh" } as never);
    await expect(factory({ host: ssh, agent: codex(), cwd: work })).rejects.toThrow(
      /runs on ssh host box; the gate route applies only to agents on ORCA's own machine/,
    );
    const both = { ...codex(), nativeToolHook: "experimental" as const };
    await expect(factory({ host: watchedHost().host, agent: both, cwd: work })).rejects.toThrow(
      /has both codexExecGate and nativeToolHook/,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("openAcpSession without the factory refuses before the host starts anything", async () => {
    const { host, spawned } = watchedHost();
    await expect(openAcpSession({ host, agent: codex(), cwd: work })).rejects.toThrow(
      /codexExecGate: experimental, but ORCA takes this route only in sessions its daemon or a workflow run opens/,
    );
    expect(spawned).not.toHaveBeenCalled();
  });

  it("remote delegation refuses a spec built past the schema before any dispatch", async () => {
    const base = vi.fn();
    const remotes = vi.fn(() => []);
    const factory = delegatingSessionFactory(base, { remotes, configDir: root, receiptsDir: root });
    const agent = {
      ...AgentSpecSchema.parse({ id: "box", type: "orca-daemon", profile: "box", workflow: "w" }),
      codexExecGate: "experimental" as const,
    };
    expect(codexExecGateRefused(agent, "remote-delegation")?.message).toMatch(/it is an orca-daemon agent/);
    await expect(factory({ host: watchedHost().host, agent, cwd: work })).rejects.toThrow(
      /codexExecGate: experimental, but it is an orca-daemon agent/,
    );
    expect(base).not.toHaveBeenCalled();
    expect(remotes).not.toHaveBeenCalled();
  });
});

describe.skipIf(!USABLE && !REQUIRED)("admission on this machine, with the closed executor made for real", () => {
  it("has bubblewrap that can make a user namespace", () => {
    // Failing here, not skipping, where the machine is said to have it.
    expect(USABLE).toBe(true);
  });

  it("refuses with exactly the standing shortfalls, having made and shown the closed executor", async () => {
    const host = codexExecGateHost();
    expect(codexExecGateHostProblems(host)).toEqual([]);
    const reasons = await reasonsOf(
      admitCodexExecGateSession({
        agentId: "codex",
        layout: { configDir: config, storeDir: ".orca", workspace: work },
        protectedPaths: orcaProtectedPaths({ configDir: config, storeDir: ".orca" }),
        host,
      }),
    );
    // Not refused on the way: the executor was made and shown closed. What is left is the list
    // that is never empty, after what this machine lets a process do to its parent, if anything.
    const ptrace = reasons.filter((r) => r.includes("ptrace_scope"));
    expect(reasons).toEqual([
      ...ptrace,
      ...CODEX_EXEC_NOT_CLOSED,
      "ORCA does not start Codex on this route yet (#1026)",
    ]);
  });
});
