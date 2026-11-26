/**
 * The factory's Codex app-server options (#1154) against the real pinned `codex app-server` and
 * the shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex (skipped otherwise):
 * with ORCA's files bound as the factory binds them, a session runs a turn whose command Codex
 * asks about and ORCA's answerer accepts, and a workspace that holds ORCA's own files is refused,
 * since Codex's sandbox could write them.
 */
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger, type OrcaError } from "@orca/core";
import { LocalHost, openCodexAppServerSession, permissionPolicyPath, type OpenSessionOptions } from "@orca/agents";
import { orcaProtectedPaths } from "../src/bootstrap.js";
import { codexAppServerSessionOptions } from "../src/codex-app-server-factory.js";
import { modelStandIn, script, type ModelStandIn } from "./codex-model-stand-in.js";

type AskRequest = Parameters<NonNullable<OpenSessionOptions["askPermission"]>>[0];
const CODEX = process.env.ORCA_CODEX_BIN;

describe.skipIf(!CODEX)("the factory's Codex app-server options against the real pinned Codex", () => {
  let model: ModelStandIn;
  let root: string;
  let codexHome: string;
  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(() => model?.server.close());
  beforeEach(async () => {
    // Not under /tmp: Codex's workspace-write sandbox can write /tmp and $TMPDIR, so ORCA's files
    // there would overlap a writable root and the session would be refused (#1160).
    root = await realpath(await mkdtemp(join(homedir(), ".orca-1154-")));
    codexHome = join(root, "codex-home");
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
        `env_key = "ORCA_1154_KEY"`,
      ].join("\n") + "\n",
    );
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const open = (configDir: string, workspace: string, asked: AskRequest[]) => {
    const layout = { configDir, storeDir: ".orca" };
    return openCodexAppServerSession(
      codexAppServerSessionOptions(
        {
          host: new LocalHost({ id: "local", type: "local" }),
          agent: AgentSpecSchema.parse({
            id: "codex",
            command: CODEX,
            driver: "codex-app-server",
            env: {
              CODEX_HOME: codexHome,
              ORCA_1154_KEY: "sk-orca-1154-test",
              NO_PROXY: "127.0.0.1",
              no_proxy: "127.0.0.1",
            },
            permissions: { default: "ask" },
          }),
          cwd: workspace,
          logger: silentLogger,
          permissionFiles: [permissionPolicyPath(configDir)],
          protectedPaths: orcaProtectedPaths(layout),
          askPermission: async (req) => (asked.push(req), "accept"),
        },
        "0.0.0-test",
      ),
    );
  };

  it("runs a turn whose command ORCA's answerer accepts", async () => {
    const configDir = join(root, "config");
    const workspace = join(root, "work");
    await mkdir(configDir);
    await mkdir(workspace);
    const asked: AskRequest[] = [];
    const session = await open(configDir, workspace, asked);
    try {
      const turn = await session.prompt(
        script({
          tool: "exec_command",
          args: {
            cmd: "touch made.txt",
            sandbox_permissions: "require_escalated",
            justification: "ORCA's factory test",
          },
        }),
        { timeoutMs: 60_000 },
      );
      expect(turn.stopReason).toBe("end_turn");
    } finally {
      await session.close();
    }
    expect(asked.map((r) => r.toolCall.kind)).toEqual(["execute"]);
    await expect(access(join(workspace, "made.txt"))).resolves.toBeUndefined();
  }, 120_000);

  it("refuses a workspace that holds ORCA's own files, which Codex's sandbox could write", async () => {
    const workspace = join(root, "work");
    await mkdir(workspace);
    const error = (await open(workspace, workspace, []).catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toMatch(/overlaps ORCA's protected .*ORCA refuses the session/);
  }, 60_000);
});
