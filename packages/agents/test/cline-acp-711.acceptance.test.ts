/**
 * Cline CLI ACP acceptance, against the real binary (#711 tiers A and B).
 *
 * Runs only when `ORCA_CLINE_BIN` names an installed Cline CLI executable (the platform
 * binary, not the npm wrapper); `cline-acp-acceptance.yml` installs the pinned version and sets
 * it. Cline's `openai-compatible` provider points at `StandInModel`, a scripted local server,
 * so no account, key or paid request is involved. Every session goes through ORCA's real
 * `openAcpSession` and the real Cline provider guard, exactly as `makeSessionFactory` wires
 * them, and every claim about an effect is checked on disk, not taken from the protocol.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type AgentSpec } from "@orca/core";
import {
  CLINE_CLI_VERIFIED_VERSIONS,
  LocalHost,
  clineGuard,
  openAcpSession,
  withProviderGuards,
  type AgentSession,
  type PermissionInvocation,
} from "@orca/agents";
import { STAND_IN_MODEL, StandInModel } from "./fixtures/cline-stand-in-model.js";

const BIN = process.env.ORCA_CLINE_BIN ?? "";
const run = promisify(execFile);
const TURN_MS = 90_000;

/** An `apply_patch` input that adds one file, in the patch format Cline's tool reads. */
const addFile = (path: string, body: string) =>
  `*** Begin Patch\n*** Add File: ${path}\n${body
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n")}\n*** End Patch`;

const model = new StandInModel({
  hello: [{ text: "hello from the stand-in" }],
  "model-error": [{ status: 400, message: "stand-in refuses this request" }],
  hang: [{ hang: true }],
  deny: [{ tool: "run_commands", args: { commands: ["touch denied.txt"] } }],
  allow: [{ tool: "run_commands", args: { commands: ["touch allowed.txt"] } }],
  always: [
    { tool: "run_commands", args: { commands: ["touch always.txt"] } },
    { tool: "run_commands", args: { commands: ["touch always.txt"] } },
  ],
  "rule-deny": [{ tool: "run_commands", args: { commands: ["rm keep.txt"] } }],
  // Cline 3.0.75 offers its OpenAI-compatible models apply_patch, not editor, for file changes.
  edit: [{ tool: "apply_patch", args: { input: addFile("edited.txt", "written by cline") } }],
  "plant-hook": [{ tool: "apply_patch", args: { input: addFile(".cline/hooks/PreToolUse", "#!/bin/sh\nexit 0") } }],
  "cancel-ask": [{ tool: "run_commands", args: { commands: ["touch never.txt"] } }],
  subagent: [
    {
      tool: "spawn_agent",
      args: { systemPrompt: "You are a helper.", task: "SCENARIO:sub-inner Run the command you are given." },
    },
  ],
  "sub-inner": [{ tool: "run_commands", args: { commands: ["touch from-subagent.txt"] } }],
  "subagent-unguarded": [
    {
      tool: "spawn_agent",
      args: { systemPrompt: "You are a helper.", task: "SCENARIO:sub-inner-unguarded Run the command you are given." },
    },
  ],
  "sub-inner-unguarded": [{ tool: "run_commands", args: { commands: ["touch unguarded-subagent.txt"] } }],
});

let root: string;
let workspace: string;
let home: string;
let configDir: string;
let keyFile: string;
const open: AgentSession[] = [];

beforeAll(async () => {
  if (!BIN) return;
  root = await mkdtemp(join(tmpdir(), "orca-cline-accept-"));
  workspace = join(root, "work");
  home = join(root, "home");
  configDir = join(root, "cline-config");
  keyFile = join(root, "stand-in.key");
  await Promise.all([workspace, home, configDir].map((d) => mkdir(d, { recursive: true })));
  await run("git", ["init", "-q", workspace]);
  await writeFile(keyFile, "stand-in-key\n");
  const base = await model.start();
  // The person's own step (docs/agents/cline.md): sign Cline in to
  // a provider in its own config directory. Here the provider is the stand-in.
  await run(
    BIN,
    ["auth", "-p", "openai-compatible", "-k", "stand-in-key", "-b", base, "-m", STAND_IN_MODEL, "--config", configDir],
    { env: { PATH: process.env.PATH, HOME: home, CLINE_NO_AUTO_UPDATE: "1" }, timeout: 60_000 },
  );
}, 120_000);

afterAll(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  await model.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

function agent(over: { permissions?: unknown; env?: Record<string, unknown> } = {}): AgentSpec {
  return AgentSpecSchema.parse({
    id: "cline",
    command: BIN,
    args: ["--acp", "--config", configDir],
    env: {
      CLINE_SESSION_BACKEND_MODE: "local",
      CLINE_NO_AUTO_UPDATE: "1",
      CLINE_PROVIDER: "openai-compatible",
      CLINE_MODEL: STAND_IN_MODEL,
      CLINE_API_KEY: { secret: "cline-key" },
      HOME: home,
      ...over.env,
    },
    ...(over.permissions ? { permissions: over.permissions } : {}),
  });
}

type Ask = (req: acp.RequestPermissionRequest, inv?: PermissionInvocation) => Promise<string | undefined>;

async function connect(opts: { agent?: AgentSpec; askPermission?: Ask; unguarded?: boolean } = {}) {
  const opened = opts.unguarded ? openAcpSession : withProviderGuards(openAcpSession, [clineGuard(() => home)]);
  const session = await opened({
    host: new LocalHost({ id: "local", type: "local" }),
    agent: opts.agent ?? agent(),
    cwd: workspace,
    secrets: { "cline-key": { host: "local", provider: "file", path: keyFile } },
    authorizeSecretUse: async () => {},
    ...(opts.askPermission ? { askPermission: opts.askPermission } : {}),
  });
  open.push(session);
  return session;
}

/** Each scenario's asks, as ORCA's askPermission saw them. */
function recorder(answer: (req: acp.RequestPermissionRequest) => string | undefined | Promise<string | undefined>) {
  const asked: acp.RequestPermissionRequest[] = [];
  const ask: Ask = async (req) => {
    asked.push(req);
    return answer(req);
  };
  return { asked, ask };
}

const at = (name: string) => join(workspace, name);
const callsFor = (scenario: string) => model.calls.filter((c) => c.scenario === scenario);

/** Processes still running this binary. */
function clineProcesses(): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")[0];
      if (cmd === BIN) pids.push(Number(entry));
    } catch {
      /* gone */
    }
  }
  return pids;
}

describe.skipIf(!BIN)("Cline CLI over ACP, installed (#711)", () => {
  describe("tier A: connectivity", () => {
    it(
      "opens the pinned version and streams a reply",
      async () => {
        const session = await connect();
        expect(session.configOptions.find((o) => o.id === "auto_approve")).toMatchObject({ currentValue: false });
        const chunks: string[] = [];
        session.onUpdate((e) => {
          const u = e.raw as { sessionUpdate: string; content?: { type: string; text?: string } };
          if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
            chunks.push(u.content.text ?? "");
        });
        const turn = await session.prompt("SCENARIO:hello Say hello.");
        expect(turn.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("hello from the stand-in");
        const call = callsFor("hello")[0]!;
        expect(call.tools).toEqual(
          expect.arrayContaining(["run_commands", "apply_patch", "read_files", "spawn_agent"]),
        );
        expect(CLINE_CLI_VERIFIED_VERSIONS).toContain("3.0.75");
        await session.close();
      },
      TURN_MS,
    );

    it(
      "fails closed with no sign-in",
      async () => {
        const unsigned = agent();
        delete (unsigned.env as Record<string, unknown>).CLINE_API_KEY;
        // Refused by Cline itself (authentication required), not by ORCA's launch checks.
        const error = await connect({ agent: unsigned }).then(
          () => undefined,
          (e: unknown) => e as { code?: string; message?: string },
        );
        expect(error).toBeDefined();
        expect(error!.code).not.toBe("CONFIG_INVALID");
      },
      TURN_MS,
    );

    it(
      "reports a model error as a failed turn and keeps the session usable",
      async () => {
        const session = await connect();
        await expect(session.prompt("SCENARIO:model-error Try.")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
        await expect(session.prompt("SCENARIO:hello Again.")).resolves.toMatchObject({ stopReason: "end_turn" });
        await session.close();
      },
      TURN_MS,
    );

    it(
      "cancels a turn the model never answers",
      async () => {
        const session = await connect();
        const turn = session.prompt("SCENARIO:hang Wait.");
        await waitFor(() => callsFor("hang").length > 0);
        await session.cancel();
        await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
        await session.close();
      },
      TURN_MS,
    );

    it(
      "leaves no Cline process behind once its sessions close",
      async () => {
        for (const s of open.splice(0)) await s.close().catch(() => undefined);
        await waitFor(() => clineProcesses().length === 0, 15_000);
        expect(clineProcesses()).toEqual([]);
      },
      TURN_MS,
    );
  });

  describe("tier B: controlled approval", () => {
    it(
      "does not run a command ORCA's person rejects",
      async () => {
        const { asked, ask } = recorder(() => "reject_once");
        const session = await connect({ askPermission: ask });
        await session.prompt("SCENARIO:deny Make a file.");
        expect(asked).toHaveLength(1);
        expect(asked[0]!.toolCall).toMatchObject({ kind: "execute", rawInput: { command: "touch denied.txt" } });
        expect(asked[0]!.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
        expect(existsSync(at("denied.txt"))).toBe(false);
        expect(callsFor("deny").at(-1)!.toolResults.join("\n")).toMatch(/reject/i);
        await session.close();
      },
      TURN_MS,
    );

    it(
      "runs exactly the command it asked about once it is allowed",
      async () => {
        const { asked, ask } = recorder(() => "allow_once");
        const session = await connect({ askPermission: ask });
        await session.prompt("SCENARIO:allow Make a file.");
        expect(asked).toHaveLength(1);
        expect(existsSync(at("allowed.txt"))).toBe(true);
        await session.close();
      },
      TURN_MS,
    );

    it(
      "asks again after an 'always' answer: nothing is remembered",
      async () => {
        const { asked, ask } = recorder(() => "allow_always");
        const session = await connect({ askPermission: ask });
        await session.prompt("SCENARIO:always Make the file twice.");
        expect(asked).toHaveLength(2);
        expect(asked.map((r) => (r.toolCall.rawInput as { command: string }).command)).toEqual([
          "touch always.txt",
          "touch always.txt",
        ]);
        await session.close();
      },
      TURN_MS,
    );

    it(
      "denies by rule without asking, and the command does not run",
      async () => {
        await writeFile(at("keep.txt"), "keep");
        const { asked, ask } = recorder(() => "allow_once");
        const session = await connect({
          askPermission: ask,
          agent: agent({ permissions: { rules: [{ match: { kind: "execute", command: "rm" }, decision: "deny" }] } }),
        });
        await session.prompt("SCENARIO:rule-deny Remove the file.");
        expect(asked).toHaveLength(0);
        expect(await readFile(at("keep.txt"), "utf8")).toBe("keep");
        await session.close();
      },
      TURN_MS,
    );

    it(
      "allows a workspace edit by the default policy, and writes only that file",
      async () => {
        const { asked, ask } = recorder(() => "reject_once");
        const session = await connect({ askPermission: ask });
        await session.prompt("SCENARIO:edit Write a file.");
        expect(asked).toHaveLength(0);
        expect(await readFile(at("edited.txt"), "utf8")).toBe("written by cline");
        await session.close();
      },
      TURN_MS,
    );

    it(
      "refuses an edit that would plant a hook for the next session",
      async () => {
        const { asked, ask } = recorder(() => "allow_once");
        const session = await connect({ askPermission: ask });
        await session.prompt("SCENARIO:plant-hook Add a hook.");
        expect(asked).toHaveLength(0);
        expect(callsFor("plant-hook").at(-1)!.toolResults).toHaveLength(1);
        expect(existsSync(at(".cline/hooks/PreToolUse"))).toBe(false);
        await session.close();
      },
      TURN_MS,
    );

    it(
      "cancels a pending ask, and the command does not run",
      async () => {
        let asking!: () => void;
        const reached = new Promise<void>((r) => (asking = r));
        const session = await connect({
          askPermission: (_req, inv) =>
            new Promise((resolve) => {
              asking();
              inv?.signal.addEventListener("abort", () => resolve(undefined));
            }),
        });
        const turn = session.prompt("SCENARIO:cancel-ask Make a file.");
        await reached;
        await session.cancel();
        await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
        await new Promise((r) => setTimeout(r, 1_000));
        expect(existsSync(at("never.txt"))).toBe(false);
        await session.close();
      },
      TURN_MS,
    );

    it(
      "why: without ORCA's guard, Cline runs a sub-agent's tools without asking",
      async () => {
        const { asked, ask } = recorder(() => "allow_once");
        const session = await connect({ askPermission: ask, unguarded: true });
        await session.prompt("SCENARIO:subagent-unguarded Delegate.");
        // One ask, for spawn_agent itself; the sub-agent's run_commands is never asked about.
        expect(asked.map((r) => r.toolCall.title?.split(":")[0])).toEqual(["spawn_agent"]);
        expect(callsFor("sub-inner-unguarded").length).toBeGreaterThan(0);
        expect(existsSync(at("unguarded-subagent.txt"))).toBe(true);
        await session.close();
      },
      TURN_MS,
    );

    it(
      "refuses a sub-agent without asking, so none of its own tools runs",
      async () => {
        const { asked, ask } = recorder(() => "allow_once");
        const session = await connect({ askPermission: ask });
        await session.prompt("SCENARIO:subagent Delegate.");
        // Cline runs a sub-agent's tools without asking anyone, so ORCA never lets one start.
        expect(asked).toHaveLength(0);
        expect(callsFor("subagent").at(-1)!.toolResults).toHaveLength(1);
        expect(callsFor("sub-inner")).toHaveLength(0);
        expect(existsSync(at("from-subagent.txt"))).toBe(false);
        await session.close();
      },
      TURN_MS,
    );

    it(
      "refuses to turn Cline's auto-approve on",
      async () => {
        const session = await connect();
        await expect(session.setConfigOption("auto_approve", true)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
        expect(session.configOptions.find((o) => o.id === "auto_approve")).toMatchObject({ currentValue: false });
        await session.close();
      },
      TURN_MS,
    );

    it(
      "refuses a workspace that carries Cline hooks before starting Cline",
      async () => {
        await mkdir(at(".clinerules/hooks"), { recursive: true });
        await writeFile(at(".clinerules/hooks/PreToolUse"), "#!/bin/sh\n");
        try {
          await expect(connect()).rejects.toThrow(/\.clinerules\/hooks holds Cline hooks/);
        } finally {
          await rm(at(".clinerules"), { recursive: true, force: true });
        }
      },
      TURN_MS,
    );
  });
});

async function waitFor(check: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}
