/**
 * The Codex app-server driver option (#1154), as this step ships it: `driver: codex-app-server`
 * is accepted by config only where it can mean something, every entry point refuses the
 * session before anything starts (session factory, ACP launch, delegation), the launch finds
 * the user's own Codex CLI and passes the agent's environment through unchanged, and the login
 * check maps Codex's `account/read` answer onto "run `codex login`".
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, type OrcaError } from "@orca/core";
import {
  CODEX_ACCOUNT_READ_PARAMS,
  codexAccountKind,
  codexAppServerLaunch,
  codexAppServerRefused,
  codexAppServerRequested,
  codexLoginRefused,
  LocalHost,
  openAcpSession,
  type AgentHost,
} from "@orca/agents";
import { delegatingSessionFactory } from "@orca/daemon";
import { makeSessionFactory } from "../src/bootstrap.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orca-1154-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

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
  AgentSpecSchema.parse({ id: "codex", command: "codex", driver: "codex-app-server", ...more });

const issuesOf = (spec: Record<string, unknown>): string[] => {
  const parsed = AgentSpecSchema.safeParse(spec);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("the option as config sees it", () => {
  it("is ACP unless asked for, and accepted on an ACP-type agent", () => {
    expect(codexAppServerRequested(codex())).toBe(true);
    expect(codexAppServerRequested(codex({ driver: "acp" }))).toBe(false);
    expect(codexAppServerRequested(AgentSpecSchema.parse({ id: "codex", command: "codex-acp" }))).toBe(false);
    expect(AgentSpecSchema.parse({ id: "codex", command: "codex-acp" }).driver).toBeUndefined();
  });

  it("refuses an unknown driver, a missing command, a remote daemon, and either other Codex route", () => {
    expect(issuesOf({ id: "c", command: "codex", driver: "codex-sdk" })).not.toEqual([]);
    expect(issuesOf({ id: "c", driver: "codex-app-server" })).toEqual([
      "command: driver: codex-app-server needs the Codex CLI to start (codex, or a path to it)",
    ]);
    expect(issuesOf({ id: "c", type: "orca-daemon", profile: "p", workflow: "w", driver: "codex-app-server" })).toEqual(
      [
        "driver: an orca-daemon agent runs the remote daemon's own agents; the Codex app-server driver does not apply to it",
      ],
    );
    expect(issuesOf({ id: "c", command: "codex", driver: "codex-app-server", nativeToolHook: "experimental" })).toEqual(
      ["driver: driver: codex-app-server does not take nativeToolHook yet (#1161); an agent takes one of them"],
    );
    expect(issuesOf({ id: "c", command: "codex", driver: "codex-app-server", codexExecGate: "experimental" })).toEqual([
      "driver: driver: codex-app-server does not take codexExecGate yet (#1171); an agent takes one of them",
    ]);
    // The hook and gate settings that mean "off" stay compatible.
    expect(issuesOf({ id: "c", command: "codex", driver: "codex-app-server", nativeToolHook: "off" })).toEqual([]);
    expect(issuesOf({ id: "c", command: "codex", driver: "codex-app-server", codexExecGate: "off" })).toEqual([]);
  });
});

describe("every entry point refuses the session before anything starts", () => {
  it("the session factory, on this machine: the driver is not built yet", async () => {
    const open = vi.fn();
    const factory = makeSessionFactory({ configDir: root, storeDir: ".orca" }, open);
    const { host, spawned } = watchedHost();
    const error = (await factory({ host, agent: codex(), cwd: root }).catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toBe(
      "agent codex has driver: codex-app-server, but ORCA does not answer Codex's approval asks (#1159) or verify the config Codex runs with (#1160) yet. " +
        "ORCA refuses the session; remove driver, and set command back to the ACP adapter (for example codex-acp) " +
        "if it names the Codex CLI, to run Codex through its ACP adapter.",
    );
    expect(open).not.toHaveBeenCalled();
    expect(spawned).not.toHaveBeenCalled();
  });

  it("the session factory, on another machine: local only for now", async () => {
    const open = vi.fn();
    const factory = makeSessionFactory({ configDir: root, storeDir: ".orca" }, open);
    const ssh = new LocalHost({ id: "box", type: "ssh" } as never);
    await expect(factory({ host: ssh, agent: codex(), cwd: root })).rejects.toThrow(
      /runs on ssh host box, and the driver runs only on ORCA's own machine for now \(#1166\)/,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("the session factory leaves an agent on the ACP route to the ACP launch", async () => {
    const open = vi.fn(async () => {
      throw new Error("opened");
    });
    const factory = makeSessionFactory({ configDir: root, storeDir: ".orca" }, open);
    await expect(
      factory({ host: watchedHost().host, agent: codex({ driver: "acp", command: "codex-acp" }), cwd: root }),
    ).rejects.toThrow("opened");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("openAcpSession starts nothing for the driver, with session metadata or without", async () => {
    const { host, spawned } = watchedHost();
    const meta = vi.fn(async () => ({}));
    for (const withMeta of [{}, { sessionMeta: meta }])
      await expect(openAcpSession({ host, agent: codex(), cwd: root, ...withMeta })).rejects.toThrow(
        /driver: codex-app-server, but ORCA's ACP launch would start the Codex CLI as an ACP agent, and this driver is not ACP/,
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
      driver: "codex-app-server" as const,
    };
    await expect(factory({ host: watchedHost().host, agent, cwd: root })).rejects.toThrow(
      /driver: codex-app-server, but it is an orca-daemon agent/,
    );
    expect(base).not.toHaveBeenCalled();
    expect(remotes).not.toHaveBeenCalled();
  });

  it("an agent that does not ask for the driver is refused nowhere", () => {
    const acp = AgentSpecSchema.parse({ id: "codex", command: "codex-acp" });
    for (const where of ["session-factory", "non-local-host", "launch", "remote-delegation"] as const)
      expect(codexAppServerRefused(acp, where)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("the launch: the user's own Codex CLI", () => {
  async function fakeCodex(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "codex");
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    await chmod(file, 0o755);
    return file;
  }

  it("finds codex on the PATH the agent sees, and appends app-server after the agent's own arguments", async () => {
    const bin = await fakeCodex(join(root, "bin"));
    const agent = codex({ args: ["-c", "model=gpt-5"] });
    const launch = await codexAppServerLaunch(agent, { cwd: root, env: { PATH: join(root, "bin") } });
    expect(launch).toEqual({ command: bin, args: ["-c", "model=gpt-5", "app-server"], env: {} });
  });

  it("prefers the PATH in the agent's own environment, and takes a configured path as it is", async () => {
    const mine = await fakeCodex(join(root, "mine"));
    await fakeCodex(join(root, "system"));
    const agent = codex({ env: { PATH: join(root, "mine") } });
    expect((await codexAppServerLaunch(agent, { cwd: root, env: { PATH: join(root, "system") } })).command).toBe(mine);
    const pinned = await fakeCodex(join(root, "pinned"));
    expect((await codexAppServerLaunch(codex({ command: pinned }), { cwd: root, env: { PATH: "" } })).command).toBe(
      pinned,
    );
  });

  it("passes the agent's environment through exactly, CODEX_HOME and secret references included", async () => {
    await fakeCodex(join(root, "bin"));
    const env = { PATH: join(root, "bin"), CODEX_HOME: join(root, "home"), OPENAI_API_KEY: { secret: "openai" } };
    const launch = await codexAppServerLaunch(codex({ env }), { cwd: root });
    expect(launch.env).toEqual(env);
    expect(Object.keys(launch.env).sort()).toEqual(["CODEX_HOME", "OPENAI_API_KEY", "PATH"]);
  });

  it("refuses, naming what to do, when no Codex CLI is found", async () => {
    await expect(
      codexAppServerLaunch(codex(), { cwd: root, env: { PATH: join(root, "nothing") } }),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message:
        'agent codex has driver: codex-app-server, but ORCA found no Codex CLI at "codex" on the agent\'s PATH. ' +
        "Install Codex (npm install -g @openai/codex) or set command to the path of its codex executable.",
    });
    const missing = join(root, "nowhere", "codex");
    await expect(codexAppServerLaunch(codex({ command: missing }), { cwd: root })).rejects.toThrow(
      `found no Codex CLI at ${JSON.stringify(missing)}. Install Codex`,
    );
  });

  it("does not take a file that is not executable", async () => {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "codex"), "not a program");
    await expect(codexAppServerLaunch(codex(), { cwd: root, env: { PATH: join(root, "bin") } })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});

describe("the login check over account/read", () => {
  it("asks Codex for nothing beyond the account: no token refresh", () => {
    expect(CODEX_ACCOUNT_READ_PARAMS).toEqual({});
    expect(Object.isFrozen(CODEX_ACCOUNT_READ_PARAMS)).toBe(true);
  });

  it("passes every kind of account Codex 0.171.0 reports, reading only its kind", () => {
    const answers = [
      { account: { type: "apiKey" }, userId: null, requiresOpenaiAuth: true },
      {
        account: { type: "chatgpt", email: "a@example.com", planType: "plus", workspaceName: null },
        userId: "u",
        requiresOpenaiAuth: true,
      },
      {
        account: { type: "amazonBedrock", usesCodexManagedCredentials: false },
        userId: null,
        requiresOpenaiAuth: false,
      },
      { account: { type: "gcp" }, userId: null, requiresOpenaiAuth: false },
    ];
    for (const answer of answers) expect(codexLoginRefused("codex", answer)).toBeUndefined();
    expect(answers.map(codexAccountKind)).toEqual(["apiKey", "chatgpt", "amazonBedrock", "gcp"]);
  });

  it("passes a provider that needs no OpenAI sign-in", () => {
    const answer = { account: null, userId: null, requiresOpenaiAuth: false };
    expect(codexLoginRefused("codex", answer)).toBeUndefined();
    expect(codexAccountKind(answer)).toBe("none");
  });

  it("refuses a Codex that needs a login and has none, naming codex login", () => {
    const error = codexLoginRefused("codex", { account: null, userId: null, requiresOpenaiAuth: true });
    expect(error?.code).toBe("NOT_SUPPORTED");
    expect(error?.details).toEqual({ agentId: "codex", reason: "codex-login-required" });
    expect(error?.message).toBe(
      "agent codex: Codex is not signed in. Run `codex login` as the account ORCA runs Codex as " +
        "(with the same CODEX_HOME), then start the run again. ORCA does not sign in to Codex itself.",
    );
  });

  it("refuses an answer of any other shape, rather than guess", () => {
    for (const answer of [
      undefined,
      null,
      [],
      "signed in",
      {},
      { account: null },
      { account: null, requiresOpenaiAuth: "yes" },
      { account: { type: "oauth" }, requiresOpenaiAuth: true },
      { account: {}, requiresOpenaiAuth: true },
      { account: [], requiresOpenaiAuth: false },
      { account: "apiKey", requiresOpenaiAuth: false },
    ]) {
      expect(codexLoginRefused("codex", answer)?.code, JSON.stringify(answer)).toBe("AGENT_PROTOCOL");
      expect(codexAccountKind(answer)).toBeUndefined();
    }
  });
});
