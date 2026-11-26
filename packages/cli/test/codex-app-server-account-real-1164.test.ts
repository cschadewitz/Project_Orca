/**
 * Account status and usage limits (#1164) against the real pinned `codex app-server` and the
 * shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex (the Codex app-server
 * protocol workflow sets it; skipped otherwise): a model answering as OpenAI does for a login
 * whose usage limit is reached fails the turn with the window and its reset time named, Codex's
 * reported limits reach ORCA, and the next turn runs once the limit allows.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger, type OrcaError } from "@orca/core";
import { LocalHost, openCodexAppServerSession, type CodexAccountStatus, type CodexRateLimits } from "@orca/agents";
import { modelStandIn, script, type ModelStandIn } from "./codex-model-stand-in.js";

const CODEX = process.env.ORCA_CODEX_BIN;

describe.skipIf(!CODEX)("account and usage limits against the real pinned Codex", () => {
  let model: ModelStandIn;
  let root: string;
  let workspace: string;
  let codexHome: string;
  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(() => model?.server.close());
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1164-")));
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
        `env_key = "ORCA_1164_KEY"`,
        // one attempt, so the 429 is the turn's answer
        `request_max_retries = 0`,
        `stream_max_retries = 0`,
      ].join("\n") + "\n",
    );
    return () => {
      delete model.usageLimit;
      return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    };
  });

  it("fails a turn on the usage limit with the window and reset time, then runs once it allows", async () => {
    const accounts: CodexAccountStatus[] = [];
    const limits: (CodexRateLimits | null)[] = [];
    const session = await openCodexAppServerSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: CODEX,
        driver: "codex-app-server",
        env: {
          CODEX_HOME: codexHome,
          ORCA_1164_KEY: "sk-orca-1164-test",
          NO_PROXY: "127.0.0.1",
          no_proxy: "127.0.0.1",
        },
      }),
      cwd: workspace,
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      logger: silentLogger,
      onAccount: (a) => accounts.push(a),
      onRateLimits: (l) => limits.push(l),
    });
    try {
      expect(accounts).toHaveLength(1);
      const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
      model.usageLimit = { usedPercent: 100, windowMinutes: 300, resetsAt };
      const error = (await session.prompt(script(), { timeoutMs: 60_000 }).catch((e: unknown) => e)) as OrcaError;
      expect(error.message).toContain(
        `the usage limit of its login is reached: the 5-hour window is 100% used and resets at ${new Date(resetsAt * 1000).toISOString()}`,
      );
      expect(error.details).toMatchObject({ reason: "codex-usage-limit" });
      expect(limits.at(-1)?.primary).toEqual({ usedPercent: 100, windowDurationMins: 300, resetsAt });

      delete model.usageLimit;
      await expect(session.prompt(script(), { timeoutMs: 60_000 })).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      await session.close();
    }
  }, 120_000);
});
