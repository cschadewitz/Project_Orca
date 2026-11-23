/**
 * The #706 connected route for Claude: a real Claude Code, driven through the real Claude ACP
 * adapter, in a session ORCA opened the way the daemon opens it (`makeSessionFactory`, with
 * ORCA's pre-tool hook installed), against a model stand-in that makes exactly the tool calls a
 * case asks for. Claude Code's own settings allow every tool without asking: the worst case of
 * natively remembered grants, so whatever stops a call is ORCA.
 *
 * One outcome per call, read from what happened, not from what ORCA says it decided:
 *
 * - `deny` / `block`: the tool result the model got back is ORCA's denial or block;
 * - `allow`: the call took effect (the file holds what was written, the MCP recorder answered,
 *   the read or command returned without error), whether or not anybody was asked;
 * - `ask`: a permission ask reached ORCA's human channel and the call did not take effect;
 * - `unoffered`: the agent did not offer the tool, so ORCA was never consulted;
 * - `refused:<text>`: the agent refused the call itself, before or without ORCA.
 *
 * Surfaces are the tool results handed back to the model for the case's own calls.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import { LocalHost, openAcpSession } from "@orca/agents";
import { makeSessionFactory } from "../../../packages/cli/src/bootstrap.ts";
import { claudeShape } from "../world.js";

const RECORDER = fileURLToPath(new URL("./mcp-recorder.js", import.meta.url));

/** The MCP servers and tools the cases call, each one a recorder. */
export const MCP_SERVERS = {
  github: ["create_issue", "delete_repo", "create_issue_comment"],
  gitlab: ["create_issue"],
  slack: ["post"],
  s: ["t"],
};

/** Claude Code's own settings: every tool allowed, nothing asked. */
const CLAUDE_SETTINGS = {
  permissions: {
    allow: ["Bash", "Read", "Write", "Edit", ...Object.keys(MCP_SERVERS).map((s) => `mcp__${s}`)],
    defaultMode: "acceptEdits",
  },
};

const MARKERS = { deny: "Denied by ORCA", block: "Blocked by ORCA" };
const RECORDED = "recorded";

/**
 * @param {{ adapter: string, hookScript: string, model: { url: string, log: any } }} env
 */
export function claudeConnected(env) {
  const path = {
    id: "claude-connected",
    capabilities: ["answerer", "agent-turn"],

    /** The agent as ORCA's config would declare it for this world. */
    agent(world, extraEnv = {}) {
      return AgentSpecSchema.parse({
        id: world.agentId,
        command: process.execPath,
        args: [env.adapter],
        env: {
          ...extraEnv,
          ANTHROPIC_BASE_URL: env.model.url,
          ANTHROPIC_API_KEY: "sk-orca-706-test",
          CLAUDE_CONFIG_DIR: join(world.root, "claude-config"),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          // Every tool is offered on every request, MCP tools included, rather than found by search.
          ENABLE_TOOL_SEARCH: "false",
        },
        mcpServers: Object.entries(MCP_SERVERS).map(([name, tools]) => ({
          name,
          command: process.execPath,
          args: [RECORDER, name, tools.join(",")],
          env: { ORCA_706_MCP_LOG: join(world.root, "mcp-calls.jsonl") },
        })),
        permissions: world.configured,
        nativeToolHook: "on",
      });
    },

    /** Open a session the daemon's way. The world's `configured` is read now, as at session open. */
    async openSession(world, { askPermission, extraEnv } = {}) {
      const claudeConfig = join(world.root, "claude-config");
      await mkdir(claudeConfig, { recursive: true });
      await writeFile(join(claudeConfig, "settings.json"), JSON.stringify(CLAUDE_SETTINGS));
      return makeSessionFactory({ configDir: world.configDir, storeDir: ".orca" }, openAcpSession, {
        runtime: process.execPath,
        script: env.hookScript,
        activation: "acceptance-only",
      })({
        host: new LocalHost({ id: "local", type: "local" }),
        agent: path.agent(world, extraEnv),
        cwd: world.workspace,
        askPermission: askPermission ?? (async () => undefined),
        logger: silentLogger,
        handshakeTimeoutMs: 60_000,
      });
    },

    async open(world) {
      if (world.connected) return world.connected;
      const state = { asks: [], answer: undefined };
      const session = await path.openSession(world, {
        askPermission: async (req) => {
          const title = req.toolCall.title ?? "";
          state.asks.push(title);
          world.asked.push(title);
          if (state.answer) return state.answer(req);
          return req.options.find((o) => o.kind === "reject_once")?.optionId;
        },
      });
      const dispose = world.dispose;
      world.dispose = async () => {
        await session.close().catch(() => undefined);
        await dispose();
      };
      world.connected = { session, state };
      return world.connected;
    },

    /** Tool calls in one model message, and what came back to the model for each. */
    async turn(world, calls, { signal } = {}) {
      const { session, state } = await path.open(world);
      const log = env.model.log;
      const marks = { asks: state.asks.length, calls: log.calls.length, results: log.results.length };
      const payload = calls.length === 1 ? calls[0] : calls;
      const turn = session.prompt(`CALL:${JSON.stringify(payload)}`);
      if (signal) {
        const cancel = () => void session.cancel().catch(() => undefined);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      }
      await turn;
      const offered = log.offered[log.offered.length - 1] ?? [];
      const made = log.calls.slice(marks.calls);
      const results = log.results.slice(marks.results);
      return {
        asked: state.asks.slice(marks.asks),
        surfaces: results.map((r) => r.text),
        calls: calls.map((c, i) => ({
          offered: offered.includes(c.name),
          result: made[i] ? results.find((r) => r.toolUseId === made[i].toolUseId) : undefined,
        })),
      };
    },

    async decide(world, action, opts = {}) {
      const [got] = await path.decideAll(world, [action], opts);
      return got;
    },

    /** Several actions in one model message, so the agent may run them at the same time. */
    async decideAll(world, actions, opts = {}) {
      const { state } = await path.open(world);
      const prepared = [];
      for (const action of actions) {
        const { toolName, toolInput } = claudeShape(action);
        const input = { ...toolInput };
        // A write's effect is its content landing in the file, so it needs content to look for.
        if (action.tool === "write" && !action.content) input.content = `orca-706-${++world.seq}`;
        const before = action.tool === "write" || action.tool === "edit" ? await text(input.file_path) : undefined;
        prepared.push({ action, name: toolName, input, before, primed: undefined });
      }

      // Claude Code refuses to change a file it has not read, before any hook runs. An agent
      // after ORCA's files would read first, so the path does: a person allows that one read
      // if ORCA asks. What ORCA answers to the read is recorded with the call.
      for (const p of prepared) {
        if (p.before === undefined) continue;
        state.answer = (req) => req.options.find((o) => o.kind === "allow_once")?.optionId;
        try {
          const read = await path.turn(world, [{ name: "Read", input: { file_path: p.input.file_path } }]);
          p.primed = classify(read.calls[0], read.asked, false) ?? "allow";
        } finally {
          state.answer = undefined;
        }
      }

      if (opts.noAnswerer) state.answer = () => undefined;
      else if (opts.onAsk) state.answer = opts.onAsk;
      let seen;
      try {
        seen = await path.turn(
          world,
          prepared.map((p) => ({ name: p.name, input: p.input })),
          opts,
        );
      } finally {
        state.answer = undefined;
      }

      const out = [];
      for (const [i, p] of prepared.entries()) {
        const { result } = seen.calls[i];
        const took = await tookEffect(p, result);
        const outcome =
          classify(seen.calls[i], seen.asked, took) ?? `refused:${(result?.text ?? "no result").slice(0, 160)}`;
        out.push({
          outcome,
          detail: {
            tool: p.name,
            result: result?.text.slice(0, 300),
            asked: seen.asked,
            ...(p.primed ? { primingRead: p.primed } : {}),
          },
          surfaces: seen.surfaces,
          agentRefusal: agentRefusal(p, outcome),
        });
      }
      return out;
    },

    /**
     * A call Claude Code refused on its own, before ORCA could answer, still counts for a case
     * that expects ask or deny when nothing could have run anyway, and each one is recorded:
     * - a tool the agent does not offer (Claude Code answers "No such tool available");
     * - an Edit of a file that does not exist (Edit cannot create a file);
     * - a change to a file whose read ORCA denied (Claude Code will not change it unread).
     */
    equivalent(world, got, expected) {
      if (!got.agentRefusal || (expected !== "ask" && expected !== "deny")) return false;
      (world.agentRefusals ??= []).push({ expected, reason: got.agentRefusal, tool: got.detail.tool });
      return true;
    },
  };
  return path;
}

/** ORCA's answer as the agent saw it, or `undefined` when the agent refused the call itself. */
function classify({ offered, result }, asked, took) {
  if (!offered) return "unoffered";
  if (result?.text.includes(MARKERS.deny)) return "deny";
  if (result?.text.includes(MARKERS.block)) return "block";
  if (took) return "allow";
  if (asked.length) return "ask";
  return undefined;
}

function agentRefusal(p, outcome) {
  if (outcome === "unoffered") return "tool-not-offered";
  if (!outcome.startsWith("refused:")) return undefined;
  if (p.action.tool === "edit" && p.before === undefined && outcome.includes("File does not exist"))
    return "edit-of-missing-file";
  if (p.primed === "deny" && outcome.includes("has not been read yet")) return "unread-after-orca-denied-read";
  return undefined;
}

/** Whether the call did what it asks, judged from the world, not from what anyone reports. */
async function tookEffect(p, result) {
  if (result === undefined) return false;
  switch (p.action.tool) {
    case "write":
      return (await text(p.input.file_path)) === p.input.content;
    case "edit":
      return p.before !== undefined && (await text(p.input.file_path)) !== p.before;
    case "mcp":
      return !result.isError && result.text.includes(RECORDED);
    default:
      return !result.isError;
  }
}

const text = (file) => readFile(file, "utf8").catch(() => undefined);
