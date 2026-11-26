/**
 * The approval policy ORCA offers a Codex app-server session (#1269), against the real pinned
 * `codex app-server` when ORCA_CODEX_BIN names it (skipped otherwise). Codex 0.171.0 refuses
 * `approval_policy = "untrusted"` at startup:
 *
 * - ORCA refuses a session asked for `untrusted` itself, before it starts Codex;
 * - when Codex exits before the handshake (here, its CODEX_HOME does not exist), ORCA's failure
 *   says it exited and why, with a fixed diagnosis, and repeats nothing Codex printed.
 *
 * (A profile that sets `untrusted` does not stop Codex: ORCA's `-c approval_policy="on-request"`
 * outranks it, and #1160's config check names any layer that sets the policy.)
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, OrcaError, silentLogger } from "@orca/core";
import { LocalHost, openCodexAppServerSession, type OpenCodexAppServerSessionOptions } from "@orca/agents";

const CODEX = process.env.ORCA_CODEX_BIN;

describe.skipIf(!CODEX)("the approval policy against the real pinned Codex", () => {
  let root: string;
  let workspace: string;
  let codexHome: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1269-")));
    workspace = join(root, "work");
    codexHome = join(root, "codex-home");
    await mkdir(workspace);
    await mkdir(codexHome);
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const open = (thread: OpenCodexAppServerSessionOptions["thread"], home = codexHome) => {
    const host = new LocalHost({ id: "local", type: "local" });
    let spawned = 0;
    const spawnAgent = host.spawnAgent.bind(host);
    host.spawnAgent = (...args: Parameters<typeof spawnAgent>) => (spawned++, spawnAgent(...args));
    const opened = openCodexAppServerSession({
      host,
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: CODEX,
        driver: "codex-app-server",
        env: { CODEX_HOME: home },
        permissions: { default: "ask" },
      }),
      cwd: workspace,
      thread,
      logger: silentLogger,
    });
    return { opened, spawned: () => spawned };
  };
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => expect.unreachable("the session opened"),
      (error: unknown) => error as OrcaError,
    );

  it("refuses a session asked for untrusted before starting Codex", async () => {
    const s = open({ approvalPolicy: "untrusted", sandbox: "workspace-write" } as never);
    const error = await failure(s.opened);
    expect(error).toBeInstanceOf(OrcaError);
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toMatch(/on-request \(Codex no longer supports untrusted\)/);
    expect(s.spawned()).toBe(0);
  });

  it("says why when Codex exits before the handshake", async () => {
    const missing = join(root, "no-such-codex-home");
    const s = open({ approvalPolicy: "on-request", sandbox: "workspace-write" }, missing);
    const error = await failure(s.opened);
    expect(s.spawned()).toBe(1);
    expect(error.code).toBe("AGENT_TRANSPORT");
    expect(error.message).toMatch(
      /exited with code \d+ before ORCA's handshake finished: CODEX_HOME does not name an existing directory/,
    );
    expect(error.details).toMatchObject({ reason: "codex-home-missing", exited: true, signal: null });
    expect(JSON.stringify(error) + error.message).not.toContain(missing);
  });
});
