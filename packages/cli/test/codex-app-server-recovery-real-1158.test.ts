/**
 * Recovery and resume of the Codex app-server driver (#1158) against the real pinned
 * `codex app-server` and the shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex
 * (the Codex app-server protocol workflow sets it; skipped otherwise):
 *
 * - killing the app-server mid-turn fails that turn, and the next prompt runs on the same thread
 *   in a new app-server;
 * - a new session that resumes the thread, as after a daemon restart, replays its history and
 *   takes a prompt on it.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import {
  LocalHost,
  openCodexAppServerSession,
  type AgentHost,
  type AgentProcessHandle,
  type CodexSessionContinuity,
  type SessionUpdateEvent,
} from "@orca/agents";
import { modelStandIn, script, shell, type ModelStandIn } from "./codex-model-stand-in.js";

const CODEX = process.env.ORCA_CODEX_BIN;

describe.skipIf(!CODEX)("recovery and resume against the real pinned Codex", () => {
  let model: ModelStandIn;
  let root: string;
  let workspace: string;
  let codexHome: string;
  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(() => model?.server.close());
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1158-")));
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
        `env_key = "ORCA_1158_KEY"`,
      ].join("\n") + "\n",
    );
    model.outputs.length = 0;
    onTestFailed(() => console.error(`tool outputs Codex sent the model:\n${model.outputs.join("\n")}`));
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** The local host, keeping every app-server process it starts. */
  function watchedHost() {
    const inner = new LocalHost({ id: "local", type: "local" });
    const spawned: AgentProcessHandle[] = [];
    const host = Object.create(inner) as AgentHost;
    host.spawnAgent = async (agent, options) => {
      const handle = await inner.spawnAgent(agent, options);
      spawned.push(handle);
      return handle;
    };
    return { host, spawned };
  }

  const open = (host: AgentHost, more: Partial<Parameters<typeof openCodexAppServerSession>[0]> = {}) =>
    openCodexAppServerSession({
      host,
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: CODEX,
        driver: "codex-app-server",
        env: {
          CODEX_HOME: codexHome,
          ORCA_1158_KEY: "sk-orca-1158-test",
          NO_PROXY: "127.0.0.1",
          no_proxy: "127.0.0.1",
        },
      }),
      cwd: workspace,
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      logger: silentLogger,
      ...more,
    });

  it("fails the turn when the app-server is killed mid-turn, and runs the next prompt on the same thread", async () => {
    const { host, spawned } = watchedHost();
    const session = await open(host);
    try {
      let started!: () => void;
      const running = new Promise<void>((r) => (started = r));
      session.onUpdate((e) => {
        if (e.summary.kind === "tool_call" && e.summary.toolKind === "execute") started();
      });
      const turn = session.prompt(script(shell("sleep 60")), { timeoutMs: 90_000 });
      await running;
      expect(spawned).toHaveLength(1);
      process.kill(spawned[0]!.pid!, "SIGKILL");
      await expect(turn).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
      await spawned[0]!.exited;

      const texts: string[] = [];
      session.onUpdate((e) => {
        if (e.summary.kind === "agent_message_chunk" && e.summary.text) texts.push(e.summary.text);
      });
      await expect(session.prompt(script(), { timeoutMs: 60_000 })).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(texts.join("")).toBe("done");
      expect(spawned).toHaveLength(2);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("resumes the thread in a new session, replays its history, and takes a prompt on it", async () => {
    const first = await open(watchedHost().host);
    const threadId = first.acpSessionId;
    try {
      await expect(first.prompt(script(shell("echo orca-1158")), { timeoutMs: 60_000 })).resolves.toMatchObject({
        stopReason: "end_turn",
      });
    } finally {
      await first.close();
    }

    const history: SessionUpdateEvent[] = [];
    let continuity: CodexSessionContinuity | undefined;
    const second = await open(watchedHost().host, {
      resumeThreadId: threadId,
      requireContextRecovery: true,
      onUpdate: (e) => history.push(e),
      onSessionContinuity: (c) => (continuity = c),
    });
    try {
      expect(second.acpSessionId).toBe(threadId);
      expect(continuity).toEqual({ mode: "loaded", reason: "load-supported" });
      expect(
        history.map((e) => [e.summary.kind, e.summary.toolKind, e.summary.status, e.summary.text?.slice(0, 8)]),
      ).toEqual([
        ["user_message_chunk", undefined, undefined, "SCRIPT: "],
        ["tool_call", "execute", "in_progress", undefined],
        ["tool_call_update", undefined, "completed", undefined],
        ["agent_message_chunk", undefined, undefined, "done"],
      ]);
      await expect(second.prompt(script(), { timeoutMs: 60_000 })).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      await second.close();
    }
  }, 120_000);
});
