/**
 * Codex's asks through ORCA's policy (#1159) against the real pinned `codex app-server` and the
 * shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex (skipped otherwise). Under
 * `on-request`, Codex asks before each command the model wants to run outside the sandbox:
 *
 * - each ask reaches ORCA's answerer with Codex's reason and directory, and an accepted command
 *   asks again on the next identical call and in a new thread (Codex stored no grant);
 * - a declined command does not run.
 */
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import { LocalHost, openCodexAppServerSession, type OpenCodexAppServerSessionOptions } from "@orca/agents";

type AskRequest = Parameters<NonNullable<OpenCodexAppServerSessionOptions["askPermission"]>>[0];
import { modelStandIn, script, type ModelStandIn, type Step } from "./codex-model-stand-in.js";

/** A command the model asks to run outside the sandbox, which Codex asks about under `on-request`. */
const escalated = (cmd: string): Step => ({
  tool: "exec_command",
  args: { cmd, sandbox_permissions: "require_escalated", justification: "ORCA's ask bridge test" },
});

const CODEX = process.env.ORCA_CODEX_BIN;
const host = () => new LocalHost({ id: "local", type: "local" });

describe.skipIf(!CODEX)("asks through ORCA's policy against the real pinned Codex", () => {
  let model: ModelStandIn;
  let root: string;
  let workspace: string;
  let codexHome: string;
  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(() => model?.server.close());
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1159-")));
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
        `env_key = "ORCA_1159_KEY"`,
      ].join("\n") + "\n",
    );
    model.outputs.length = 0;
    onTestFailed(() => console.error(`tool outputs Codex sent the model:\n${model.outputs.join("\n")}`));
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const env = () => ({
    CODEX_HOME: codexHome,
    ORCA_1159_KEY: "sk-orca-1159-test",
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
  });

  const session = (answer: (req: AskRequest) => string | undefined) => {
    const asked: AskRequest[] = [];
    const opened = openCodexAppServerSession({
      host: host(),
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: CODEX,
        driver: "codex-app-server",
        env: env(),
        permissions: { default: "ask" },
      }),
      cwd: workspace,
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      logger: silentLogger,
      askPermission: async (req) => (asked.push(req), answer(req)),
    });
    return { opened, asked };
  };
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const commands = (asked: AskRequest[]) =>
    asked.filter((r) => r.toolCall.kind === "execute").map((r) => (r.toolCall.rawInput as { command: string }).command);

  it("asks for every command, again for the same command and in a new thread", async () => {
    const first = session(() => "accept");
    const s = await first.opened;
    try {
      const turn = await s.prompt(script(escalated("touch asked.txt"), escalated("touch asked.txt")), {
        timeoutMs: 60_000,
      });
      expect(turn.stopReason).toBe("end_turn");
    } finally {
      await s.close();
    }
    expect(await exists(join(workspace, "asked.txt"))).toBe(true);
    const ran = commands(first.asked);
    expect(ran).toHaveLength(2);
    expect(ran[0]).toContain("touch asked.txt");
    expect(ran[1]).toBe(ran[0]);
    expect(first.asked[0]!.toolCall.rawInput).toMatchObject({ cwd: workspace });
    expect(first.asked[0]!.options.map((o) => o.optionId)).toEqual(["accept", "decline"]);
    // a new thread on the same Codex home asks again
    const second = session(() => "accept");
    const t = await second.opened;
    try {
      await t.prompt(script(escalated("touch asked.txt")), { timeoutMs: 60_000 });
    } finally {
      await t.close();
    }
    expect(commands(second.asked)).toEqual([ran[0]]);
    // and Codex's own config holds no rule or grant ORCA's answers made
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).not.toMatch(/prefix_rule|trust_level|allow/);
  }, 180_000);

  it("does not run a command ORCA declines", async () => {
    const declined = session(() => "decline");
    const s = await declined.opened;
    try {
      await s.prompt(script(escalated("touch declined.txt")), { timeoutMs: 60_000 });
    } finally {
      await s.close();
    }
    expect(commands(declined.asked)).toHaveLength(1);
    expect(await exists(join(workspace, "declined.txt"))).toBe(false);
  }, 120_000);
});
