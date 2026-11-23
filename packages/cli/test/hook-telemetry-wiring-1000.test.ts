/**
 * The session factory's side of hook telemetry (#1000): an opted-in agent that keeps tool-call
 * telemetry gets a spool beside its hook context, handed to the session as `hookTelemetry` for
 * the engine to drain, and read a last time and removed when the session ends. Spools a stopped
 * process left behind are discarded before the first hooked session opens. No agent runs here;
 * the hook's own recording is in `@orca/agents`' `hook-telemetry-writer-1000.test.ts`.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, type HookTelemetryLine } from "@orca/core";
import {
  CLAUDE_HOOK_VERIFIED_ADAPTERS,
  CLAUDE_HOOK_VERIFIED_PAIRS,
  LocalHost,
  recordHookTelemetry,
  runClaudeRuntimeAttestation,
  type AgentSession,
} from "@orca/agents";
import { makeSessionFactory } from "../src/bootstrap.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const AGENT_PID = 4242;
const RUNTIME_PID = 4343;
const PINNED = CLAUDE_HOOK_VERIFIED_PAIRS[0]!.images["linux-x64"]!;
const CLAUDE = { name: "@agentclientprotocol/claude-agent-acp", version: CLAUDE_HOOK_VERIFIED_ADAPTERS[0]! };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "orca-1000-wiring-"));
  dirs.push(dir);
  const hookDir = join(dir, ".orca", "private-execution", "tool-hooks");
  const factory = makeSessionFactory(
    { configDir: dir, storeDir: ".orca" },
    async (options) => {
      const meta = (await options.sessionMeta?.(CLAUDE, async () => undefined, AGENT_PID)) as {
        claudeCode: { options: { settings: { hooks: { SessionStart: { hooks: { args: string[] }[] }[] } } } };
      };
      const attest = meta.claudeCode.options.settings.hooks.SessionStart[0]!.hooks[0]!.args;
      await runClaudeRuntimeAttestation(attest.slice(1), JSON.stringify({ hook_event_name: "SessionStart" }), {
        pid: RUNTIME_PID,
      });
      return { closed: new Promise<void>(() => undefined), close: async () => undefined } as unknown as AgentSession;
    },
    {
      runtime: "/usr/bin/node",
      script: "/opt/orca/claude-pre-tool-hook.mjs",
      platform: "linux",
      arch: "x64",
      imageDigest: async (pid, agentPid) =>
        agentPid === AGENT_PID && pid === RUNTIME_PID ? { sha256: PINNED } : { error: "not under the agent" },
    },
  );
  const open = (diagnostics?: { toolCalls: "off" | "keep" }) =>
    factory({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "claude",
        command: "claude-agent-acp",
        nativeToolHook: "experimental",
        ...(diagnostics ? { diagnostics } : {}),
      }),
      cwd: join(dir, "work"),
    });
  return { dir, hookDir, open };
}

const line: HookTelemetryLine = { v: 1, at: "2026-11-23T10:00:00.000Z", tool: "Bash", decision: "allow", latencyMs: 1 };

describe.runIf(process.platform !== "win32")("a hooked session's telemetry spool", () => {
  it("is made only when the agent keeps telemetry, named in the context, and drained to the end", async () => {
    const t = await setup();
    const plain = await t.open();
    expect(plain.hookTelemetry).toBeUndefined();
    expect((await readdir(t.hookDir)).some((f) => f.endsWith(".spool"))).toBe(false);
    await plain.close();

    const session = await t.open({ toolCalls: "keep" });
    const spool = session.hookTelemetry!;
    expect(spool).toBeDefined();
    const context = (await readdir(t.hookDir)).find((f) => f.endsWith(".json") && !f.endsWith(".runtime.json"))!;
    expect(JSON.parse(await readFile(join(t.hookDir, context), "utf8")).telemetry).toEqual(spool.target);
    const got: HookTelemetryLine[] = [];
    spool.attach(async (lines) => {
      got.push(...lines);
    });
    expect(recordHookTelemetry(spool.target, line)).toBe(true);
    await session.close();
    expect(got).toEqual([line]);
    expect(await readdir(t.hookDir)).toEqual([]);
  });

  it("discards spools a stopped process left behind, before the first hooked session", async () => {
    const t = await setup();
    await mkdir(t.hookDir, { recursive: true, mode: 0o700 });
    // A pid no process has: the highest Linux allows is far below this.
    const stale = join(t.hookDir, "tool-calls-99999999-00000000-0000-4000-8000-000000000000.spool");
    await writeFile(stale, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    const session = await t.open();
    expect(await readdir(t.hookDir)).not.toContain(stale.split("/").pop());
    await session.close();
  });
});
