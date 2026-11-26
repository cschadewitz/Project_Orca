/**
 * Setting and checking Codex's config (#1160) against the real pinned `codex app-server` and the
 * shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex (the Codex app-server
 * protocol workflow sets it; skipped otherwise):
 *
 * - with a plain user config, the session runs a prompt and reports ORCA's settings as coming
 *   from the session flags;
 * - a user `config.toml` that sets another approval policy, adds an MCP server or a hook is
 *   refused with the setting named, before any thread starts;
 * - a project `.codex/config.toml` that sets another reviewer is refused once Codex trusts the
 *   project, which Codex does itself when a workspace-write thread starts there: the check on
 *   the thread catches it the first time, the check before the thread every time after.
 */
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger, type OrcaError } from "@orca/core";
import { LocalHost, openCodexAppServerSession, type CodexVerifiedConfig } from "@orca/agents";
import { modelStandIn, script, type ModelStandIn } from "./codex-model-stand-in.js";

const CODEX = process.env.ORCA_CODEX_BIN;

describe.skipIf(!CODEX)("Codex's config against the real pinned Codex", () => {
  let model: ModelStandIn;
  let root: string;
  let workspace: string;
  let codexHome: string;
  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(() => model?.server.close());
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1160-")));
    workspace = join(root, "work");
    codexHome = join(root, "codex-home");
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      [
        `model = "gpt-5.5"`,
        `model_provider = "standin"`,
        `[model_providers.standin]`,
        `name = "standin"`,
        `base_url = "${model.url}"`,
        `wire_api = "responses"`,
        `env_key = "ORCA_1160_KEY"`,
      ].join("\n") + "\n",
    );
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const open = (more: Partial<Parameters<typeof openCodexAppServerSession>[0]> = {}) =>
    openCodexAppServerSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: CODEX,
        driver: "codex-app-server",
        env: {
          CODEX_HOME: codexHome,
          ORCA_1160_KEY: "sk-orca-1160-test",
          NO_PROXY: "127.0.0.1",
          no_proxy: "127.0.0.1",
        },
      }),
      cwd: workspace,
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      logger: silentLogger,
      ...more,
    });
  /** The user config.toml, with `lines` added at its top level or as tables after it. */
  const userConfig = (...lines: string[]) => appendFile(join(codexHome, "config.toml"), lines.join("\n") + "\n");
  const refusal = async () => (await open().catch((e: unknown) => e)) as OrcaError;

  it("runs with ORCA's settings from the session flags", async () => {
    let verified: CodexVerifiedConfig | undefined;
    const session = await open({ onVerifiedConfig: (c) => (verified = c) });
    try {
      expect(verified).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        origins: { approval_policy: "sessionFlags", approvals_reviewer: "sessionFlags", sandbox_mode: "sessionFlags" },
        requirements: false,
      });
      expect(verified!.layers[0]).toEqual({ type: "sessionFlags", enabled: true });
      await expect(session.prompt(script(), { timeoutMs: 60_000 })).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      await session.close();
    }
  }, 120_000);

  it("refuses a user config.toml that sets another approval policy, adds an MCP server or a hook", async () => {
    const base = await readFile(join(codexHome, "config.toml"), "utf8");
    // a top-level key has to come before the tables
    await writeFile(join(codexHome, "config.toml"), `approval_policy = "never"\n` + base);
    let error = await refusal();
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain(
      `the user config.toml (${join(codexHome, "config.toml")}) sets approval_policy = "never"`,
    );

    await writeFile(join(codexHome, "config.toml"), base);
    await userConfig(`[mcp_servers.extra]`, `command = "echo"`, `env = { TOKEN = "sk-orca-1160-mcp" }`);
    error = await refusal();
    expect(error.message).toContain("Codex's config adds the MCP server extra");
    expect(error.message).not.toContain("sk-orca-1160-mcp");

    await writeFile(join(codexHome, "config.toml"), base);
    await userConfig(
      `[[hooks.PreToolUse]]`,
      `matcher = "Bash"`,
      `[[hooks.PreToolUse.hooks]]`,
      `type = "command"`,
      `command = "true"`,
    );
    error = await refusal();
    expect(error.message).toContain("Codex would run the hook preToolUse (user)");
  }, 120_000);

  it("refuses a project config that sets another reviewer once Codex trusts the project", async () => {
    await mkdir(join(workspace, ".codex"));
    await writeFile(join(workspace, ".codex", "config.toml"), `approvals_reviewer = "auto_review"\n`);
    const message = `the project config in ${join(workspace, ".codex")} sets approvals_reviewer = "auto_review"`;
    // Untrusted, the project's config is not in force, so the check before the thread passes;
    // starting the workspace-write thread has Codex trust the project in the user's
    // config.toml, and the check on the thread refuses it.
    expect((await refusal()).message).toContain(message);
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toContain(`trust_level = "trusted"`);
    // From then on it is refused before any thread starts.
    expect((await refusal()).message).toContain(message);
  }, 120_000);
});
