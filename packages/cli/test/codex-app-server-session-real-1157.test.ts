/**
 * The Codex app-server session driver (#1157) against the real pinned `codex app-server` and
 * the shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex (the Codex app-server
 * protocol workflow sets it, with ORCA_CODEX_ADAPTER for the ACP route; skipped otherwise):
 *
 * - one turn with a command, a patch and a message reports the same sequence of session
 *   updates the ACP route (codex-acp 2.9.0 over the same Codex and the same script) reports;
 * - cancelling during a running command ends the turn as cancelled.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger, type AgentUpdateSummary } from "@orca/core";
import {
  LocalHost,
  openAcpSession,
  openCodexAppServerSession,
  type AgentSession,
  type SessionUpdateEvent,
} from "@orca/agents";
import { modelStandIn, patch, script, shell, type ModelStandIn } from "./codex-model-stand-in.js";

const CODEX = process.env.ORCA_CODEX_BIN;
const ADAPTER = process.env.ORCA_CODEX_ADAPTER;
const host = () => new LocalHost({ id: "local", type: "local" });

/** What both routes are compared on: each tool call and message, in order. */
const comparable = (events: SessionUpdateEvent[]) =>
  events
    .map((e) => e.summary)
    .filter((s: AgentUpdateSummary) =>
      ["tool_call", "tool_call_update", "agent_message_chunk", "plan"].includes(s.kind),
    )
    .map((s) => ({
      kind: s.kind,
      ...(s.toolKind ? { toolKind: s.toolKind } : {}),
      ...(s.status ? { status: s.status } : {}),
      ...(s.title && s.kind === "tool_call" ? { title: s.title } : {}),
      ...(s.kind === "agent_message_chunk" ? { text: s.text } : {}),
    }));

describe.skipIf(!CODEX)("the driver against the real pinned Codex", () => {
  let model: ModelStandIn;
  let root: string;
  let workspace: string;
  let codexHome: string;
  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(() => model?.server.close());
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1157-")));
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
        `env_key = "ORCA_1157_KEY"`,
      ].join("\n") + "\n",
    );
    model.outputs.length = 0;
    onTestFailed(() => console.error(`tool outputs Codex sent the model:\n${model.outputs.join("\n")}`));
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const env = () => ({
    CODEX_HOME: codexHome,
    ORCA_1157_KEY: "sk-orca-1157-test",
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
  });

  const driverSession = () =>
    openCodexAppServerSession({
      host: host(),
      agent: AgentSpecSchema.parse({ id: "codex", command: CODEX, driver: "codex-app-server", env: env() }),
      cwd: workspace,
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      logger: silentLogger,
    });

  const acpSession = () =>
    openAcpSession({
      host: host(),
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: process.execPath,
        args: [ADAPTER],
        env: { ...env(), CODEX_PATH: CODEX, INITIAL_AGENT_MODE: "agent-full-access" },
      }),
      cwd: workspace,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
      askPermission: async (req) => req.options.find((o) => o.kind === "reject_once")?.optionId,
    });

  async function run(open: () => Promise<AgentSession>, prompt: string) {
    const session = await open();
    const events: SessionUpdateEvent[] = [];
    session.onUpdate((e) => events.push(e));
    try {
      const result = await session.prompt(prompt, { timeoutMs: 60_000 });
      return { result, events };
    } finally {
      await session.close();
    }
  }

  const SCRIPT = script(shell("echo orca-1157 > shell.txt"), patch("*** Add File: patched.txt", "+orca-1157"));

  it("runs a turn with a command, a patch and a message", async () => {
    const { result, events } = await run(driverSession, SCRIPT);
    expect(result.stopReason).toBe("end_turn");
    expect(await readFile(join(workspace, "shell.txt"), "utf8")).toBe("orca-1157\n");
    expect(await readFile(join(workspace, "patched.txt"), "utf8")).toBe("orca-1157\n");
    expect(comparable(events)).toEqual([
      { kind: "tool_call", toolKind: "execute", status: "in_progress", title: "echo orca-1157 > shell.txt" },
      { kind: "tool_call_update", status: "completed" },
      { kind: "tool_call", toolKind: "edit", status: "in_progress", title: "Editing files" },
      { kind: "tool_call_update", status: "completed" },
      { kind: "agent_message_chunk", text: "done" },
    ]);
  }, 120_000);

  it.skipIf(!ADAPTER)(
    "reports the same sequence as the ACP route for the same script",
    async () => {
      const driver = await run(driverSession, SCRIPT);
      await rm(join(workspace, "shell.txt"));
      await rm(join(workspace, "patched.txt"));
      const acp = await run(acpSession, SCRIPT);
      expect(acp.result.stopReason).toBe(driver.result.stopReason);
      expect(comparable(driver.events)).toEqual(comparable(acp.events));
    },
    180_000,
  );

  it("ends the turn as cancelled when cancelled during a running command", async () => {
    const session = await driverSession();
    try {
      let started!: () => void;
      const running = new Promise<void>((r) => (started = r));
      session.onUpdate((e) => {
        if (e.summary.kind === "tool_call" && e.summary.toolKind === "execute") started();
      });
      const turn = session.prompt(script(shell("sleep 60")), { timeoutMs: 90_000 });
      await running;
      const at = Date.now();
      await session.cancel();
      await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(Date.now() - at).toBeLessThan(15_000);
    } finally {
      await session.close();
    }
  }, 120_000);
});
