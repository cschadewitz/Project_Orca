/**
 * The opt-in route for ORCA's gate in Codex's executor path (#1026), `codexExecGate:
 * experimental`, as this step ships it: every session that asks for it is refused before the
 * agent starts, with each reason found (the layout, the host, the closed executor's standing
 * shortfalls, and that the route is not wired yet), admission starts nothing, and no entry
 * point runs the agent another way, session metadata or not.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  type AgentHost,
  type CodexExecGateHost,
  type OpenSessionOptions,
} from "@orca/agents";
import { delegatingSessionFactory } from "@orca/daemon";
import { makeSessionFactory } from "../src/bootstrap.js";

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
const reasonsOf = async (refused: Promise<unknown> | (() => unknown)): Promise<string[]> => {
  const error = (await (typeof refused === "function" ? Promise.resolve().then(refused) : refused).then(
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

  it("refuses ORCA's files inside a directory the agent may write, and the other way round", async () => {
    await writeFile(join(work, "orca.config.yaml"), "");
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

describe("a config file and its link, and containment by component", () => {
  const layout = (more: Partial<Parameters<typeof codexExecGateLayoutProblems>[0]> = {}) => ({
    configDir: config,
    storeDir: ".orca",
    workspace: work,
    ...more,
  });

  it("refuses a config file named apart that is a link into a directory the agent may write", async () => {
    const apart = join(root, "apart");
    await mkdir(apart);
    await writeFile(join(work, "orca.config.yaml"), "");
    await symlink(join(work, "orca.config.yaml"), join(apart, "orca.config.yaml"));
    expect(codexExecGateLayoutProblems(layout({ configFile: join(apart, "orca.config.yaml") }))).toEqual([
      `the workspace ${work} is the directory the config file ORCA loaded leads to: on this route ORCA's files have to be outside every directory the agent may write. Set \`workspace:\` in the config to a directory outside ${work}`,
    ]);
  });

  it("refuses a config file whose directory is a link into a directory the agent may write", async () => {
    await mkdir(join(work, "conf"));
    await writeFile(join(work, "conf", "orca.config.yaml"), "");
    await symlink(join(work, "conf"), join(root, "conf"));
    expect(codexExecGateLayoutProblems(layout({ configFile: join(root, "conf", "orca.config.yaml") }))).toEqual([
      `the directory of the config file ORCA loaded ${join(work, "conf")} is inside the workspace ${work}, which the agent may write`,
    ]);
  });

  it("takes a config file apart, and a link to one apart, as apart", async () => {
    const apart = join(root, "apart");
    const elsewhere = join(root, "elsewhere");
    await mkdir(apart);
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "orca.config.yaml"), "");
    await symlink(join(elsewhere, "orca.config.yaml"), join(apart, "orca.config.yaml"));
    expect(codexExecGateLayoutProblems(layout({ configFile: join(elsewhere, "orca.config.yaml") }))).toEqual([]);
    expect(codexExecGateLayoutProblems(layout({ configFile: join(apart, "orca.config.yaml") }))).toEqual([]);
  });

  it("refuses a config file that does not resolve, since what it names is not known", () => {
    expect(codexExecGateLayoutProblems(layout({ configFile: join(config, "gone.yaml") }))).toEqual([
      expect.stringMatching(/^the config file ORCA loaded .*gone\.yaml cannot be resolved \(ENOENT\)$/),
    ]);
  });

  it("compares by path component, not by the start of a name", async () => {
    // `work2` is not inside `work`; a directory named `..x` is a name, not a step up.
    const work2 = join(root, "work2");
    const dots = join(root, "..x");
    await mkdir(work2);
    await mkdir(dots);
    expect(codexExecGateLayoutProblems(layout({ configDir: work2, workspace: work }))).toEqual([
      expect.stringMatching(/^ORCA's store .*work2\/\.orca cannot be resolved/),
    ]);
    await mkdir(join(work2, ".orca"));
    expect(codexExecGateLayoutProblems(layout({ configDir: work2, workspace: work }))).toEqual([]);
    // A store in `..x` under the workspace's parent is inside that parent, and not inside `work`.
    await mkdir(join(dots, ".orca"));
    expect(codexExecGateLayoutProblems(layout({ configDir: dots, workspace: root }))).toEqual([
      `ORCA's config directory ${dots} is inside the workspace ${root}, which the agent may write`,
      `ORCA's store ${join(dots, ".orca")} is inside the workspace ${root}, which the agent may write`,
    ]);
    expect(codexExecGateLayoutProblems(layout({ configDir: dots, workspace: work }))).toEqual([]);
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
    host: goodHost,
    ...more,
  });

  it("refuses with the closed executor's standing shortfalls, and that the route is not wired, when all else holds", async () => {
    expect(await reasonsOf(() => admitCodexExecGateSession(admission()))).toEqual([
      ...CODEX_EXEC_NOT_CLOSED,
      "ORCA does not start Codex on this route yet (#1026)",
    ]);
  });

  it("names the layout's and the host's reasons first, then the same standing ones", async () => {
    expect(
      await reasonsOf(() =>
        admitCodexExecGateSession(
          admission({
            layout: { configDir: config, storeDir: ".orca", workspace: config },
            host: { ...goodHost, systemCodexConfig: ["config.toml"] },
          }),
        ),
      ),
    ).toEqual([
      expect.stringContaining("is ORCA's config directory"),
      expect.stringContaining("is inside the workspace"),
      expect.stringContaining("/etc/codex holds host-wide Codex configuration (config.toml)"),
      ...CODEX_EXEC_NOT_CLOSED,
      "ORCA does not start Codex on this route yet (#1026)",
    ]);
  });

  it("says every reason in its message, numbered, and that nothing falls back", () => {
    expect(() => admitCodexExecGateSession(admission())).toThrow(
      /^agent codex has codexExecGate: experimental, and ORCA refuses the session: \(1\) .*named pipe.*\(4\) ORCA does not start Codex on this route yet \(#1026\)\. Nothing falls back to running Codex without the gate; remove codexExecGate to run the agent without it\.$/,
    );
  });

  it("reads the host as it is when not given one", async () => {
    const reasons = await reasonsOf(() => admitCodexExecGateSession(admission({ host: undefined })));
    expect(reasons).toEqual([
      ...codexExecGateHostProblems(codexExecGateHost()),
      ...CODEX_EXEC_NOT_CLOSED,
      "ORCA does not start Codex on this route yet (#1026)",
    ]);
  });
});

describe("the session factory and the other entry points", () => {
  it("the factory refuses before anything opens, with the layout's reason first", async () => {
    const open = vi.fn(async (_: OpenSessionOptions) => {
      throw new Error("a session was opened");
    });
    const factory = makeSessionFactory({ configDir: config, storeDir: ".orca" }, open, undefined, { host: goodHost });
    const { host, spawned } = watchedHost();
    const reasons = await reasonsOf(factory({ host, agent: codex(), cwd: config }));
    expect(reasons[0]).toContain("is ORCA's config directory");
    expect(reasons.at(-1)).toBe("ORCA does not start Codex on this route yet (#1026)");
    expect(open).not.toHaveBeenCalled();
    expect(spawned).not.toHaveBeenCalled();
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

  it("openAcpSession refuses before the host starts anything, with session metadata or without", async () => {
    const { host, spawned } = watchedHost();
    const meta = vi.fn(async () => ({}));
    for (const withMeta of [{}, { sessionMeta: meta }])
      await expect(openAcpSession({ host, agent: codex(), cwd: work, ...withMeta })).rejects.toThrow(
        /codexExecGate: experimental, but ORCA does not launch Codex on this route yet \(#1026\); the session factory names every reason/,
      );
    expect(spawned).not.toHaveBeenCalled();
    expect(meta).not.toHaveBeenCalled();
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
