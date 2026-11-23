/**
 * The #706 connected route for Claude: a real Claude Code, driven through the real Claude ACP
 * adapter, in a session ORCA opened the way the daemon opens it (`makeSessionFactory`, with
 * ORCA's pre-tool hook installed), against a model stand-in that makes exactly the tool calls a
 * case asks for. Claude Code's own settings allow every tool without asking: the worst case of
 * natively remembered grants, so whatever stops a call is ORCA.
 *
 * Every call is recorded with three things kept apart:
 *
 * - `refusal`: what the tool result handed back to the model said (ORCA's denial or block, the
 *   agent's own refusal text, or nothing);
 * - `approvals`: the permission asks that reached ORCA's human channel for this exact call,
 *   matched by the ACP tool call id (the model's tool_use id), and how each was answered;
 * - `effect`: `observed`, `none` or `indeterminate`, from evidence independent of the agent and
 *   of ORCA: the file's bytes, the MCP recorder's log (each answer names its log line), the
 *   shell recorder's log (`CLAUDE_CODE_SHELL_PREFIX`), a token seeded in a file to read, or the
 *   tool list of the request the call was made in. A refusal text alone never shows `none`.
 *
 * The outcome follows from the evidence: `allow` when the effect was observed; otherwise, only
 * with `none` proven, `deny` / `block` (ORCA's text), `ask` (an approval for this call), or
 * `unoffered` / `refused:<text>` (the agent's own). Anything without proof is `indeterminate`.
 * Surfaces are the tool results handed back to the model for the case's own calls.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import { LocalHost, openAcpSession } from "@orca/agents";
import { makeSessionFactory } from "../../../packages/cli/src/bootstrap.ts";
import { claudeShape } from "../world.js";

const RECORDER = fileURLToPath(new URL("./mcp-recorder.js", import.meta.url));
const SHELL_RECORDER = fileURLToPath(new URL("./shell-recorder.sh", import.meta.url));

/** The MCP servers and tools the cases call, each one a recorder. */
export const MCP_SERVERS = {
  github: ["create_issue", "delete_repo", "create_issue_comment"],
  gitlab: ["create_issue"],
  slack: ["post"],
  s: ["t"],
};
const MCP_TOOLS = Object.entries(MCP_SERVERS).flatMap(([s, tools]) => tools.map((t) => `mcp__${s}__${t}`));

/** Claude Code's own settings: every tool allowed, nothing asked. */
const CLAUDE_SETTINGS = {
  permissions: {
    allow: ["Bash", "Read", "Write", "Edit", ...Object.keys(MCP_SERVERS).map((s) => `mcp__${s}`)],
    defaultMode: "acceptEdits",
  },
};

const MARKERS = { deny: "Denied by ORCA", block: "Blocked by ORCA" };

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
          CLAUDE_CODE_SHELL_PREFIX: SHELL_RECORDER,
          ORCA_706_SHELL_LOG: logs(world).shell,
        },
        mcpServers: Object.entries(MCP_SERVERS).map(([name, tools]) => ({
          name,
          command: process.execPath,
          args: [RECORDER, name, tools.join(",")],
          env: { ORCA_706_MCP_LOG: logs(world).mcp },
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
      const state = { approvals: [], answer: undefined };
      const session = await path.openSession(world, {
        askPermission: async (req) => {
          const approval = {
            toolCallId: req.toolCall.toolCallId,
            title: req.toolCall.title ?? "",
            answer: "pending",
          };
          state.approvals.push(approval);
          world.asked.push(approval.title);
          const optionId = state.answer
            ? await state.answer(req)
            : req.options.find((o) => o.kind === "reject_once")?.optionId;
          approval.answer =
            optionId === undefined
              ? "no-answer"
              : (req.options.find((o) => o.optionId === optionId)?.kind ??
                `not-offered:${String(optionId).slice(0, 40)}`);
          return optionId;
        },
      });
      const dispose = world.dispose;
      world.dispose = async () => {
        await session.close().catch(() => undefined);
        await dispose();
      };
      world.connected = { session, state };
      // MCP servers connect in the background; the cases start once every recorder is offered.
      for (let i = 0; i < 20 && !MCP_TOOLS.every((t) => env.model.log.offered.includes(t)); i++) {
        await session.prompt("ready?");
        if (!MCP_TOOLS.every((t) => env.model.log.offered.includes(t))) await sleep(250);
      }
      if (!MCP_TOOLS.every((t) => env.model.log.offered.includes(t)))
        throw new Error(`the MCP recorders were never offered: ${env.model.log.offered.join(",")}`);
      return world.connected;
    },

    /** Tool calls in one model message, and what came back to the model for each. */
    async turn(world, calls, { signal } = {}) {
      const { session, state } = await path.open(world);
      const log = env.model.log;
      const marks = { approvals: state.approvals.length, calls: log.calls.length, results: log.results.length };
      const payload = calls.length === 1 ? calls[0] : calls;
      const turn = session.prompt(`CALL:${JSON.stringify(payload)}`);
      if (signal) {
        const cancel = () => void session.cancel().catch(() => undefined);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      }
      await turn;
      const made = log.calls.slice(marks.calls);
      const results = log.results.slice(marks.results);
      const approvals = state.approvals.slice(marks.approvals);
      return {
        surfaces: results.map((r) => r.text),
        strayApprovals: approvals.filter((a) => !made.some((m) => m.toolUseId === a.toolCallId)),
        calls: calls.map((c, i) => {
          const m = made[i];
          return {
            made: m !== undefined && m.name === c.name,
            offered: m?.offered.includes(c.name) ?? false,
            result: m ? results.find((r) => r.toolUseId === m.toolUseId) : undefined,
            approvals: m ? approvals.filter((a) => a.toolCallId === m.toolUseId) : [],
          };
        }),
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
        const before = action.tool === "write" || action.tool === "edit" ? await bytes(input.file_path) : undefined;
        const token = action.tool === "read" ? await readToken(world, input.file_path) : undefined;
        prepared.push({ action, name: toolName, input, before, token, primed: undefined });
      }

      // Claude Code refuses to change a file it has not read, before any hook runs. An agent
      // after ORCA's files would read first, so the path does: a person allows that one read
      // if ORCA asks. What ORCA answered to the read is recorded with the call.
      for (const p of prepared) {
        if (p.before === undefined) continue;
        state.answer = (req) => req.options.find((o) => o.kind === "allow_once")?.optionId;
        try {
          const read = await path.turn(world, [{ name: "Read", input: { file_path: p.input.file_path } }]);
          const c = read.calls[0];
          p.primed = c.result?.text.includes(MARKERS.deny)
            ? "deny"
            : c.approvals.length
              ? `asked:${c.approvals.map((a) => a.answer).join(",")}`
              : c.result && !c.result.isError
                ? "allow"
                : "refused";
        } finally {
          state.answer = undefined;
        }
      }

      const shellBefore = await lines(logs(world).shell);
      const mcpBefore = await lines(logs(world).mcp);
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
      const shellRan = (await lines(logs(world).shell)).slice(shellBefore.length);
      const mcpRan = (await lines(logs(world).mcp)).slice(mcpBefore.length).map((l) => JSON.parse(l).nonce);

      const effects = await Promise.all(prepared.map((p, i) => effectOf(p, seen.calls[i], seen.surfaces)));
      settleCounted(prepared, seen, effects, "mcp", mcpRan.length);
      settleCounted(prepared, seen, effects, "shell", shellRan.length);

      const out = [];
      for (const [i, p] of prepared.entries()) {
        const c = seen.calls[i];
        const effect = effects[i];
        const refusal = refusalOf(c);
        const outcome = outcomeOf(c, refusal, effect);
        const record = {
          tool: p.name.slice(0, 120),
          outcome,
          refusal,
          approvals: c.approvals.map((a) => a.answer),
          effect: effect.effect,
          evidence: effect.evidence,
          ...(p.primed ? { primingRead: p.primed } : {}),
        };
        (world.callRecords ??= []).push(record);
        out.push({
          outcome,
          detail: { ...record, result: c.result?.text.slice(0, 300) },
          surfaces: seen.surfaces,
          agentRefusal: agentRefusal(p, outcome, effect),
        });
      }
      if (seen.strayApprovals.length)
        (world.callRecords ??= []).push({ strayApprovals: seen.strayApprovals.map((a) => a.title) });
      return out;
    },

    /**
     * A call Claude Code refused on its own, before ORCA could answer, still counts for a case
     * that expects ask or deny only when it is proven to have had no effect and nothing could
     * have run anyway; each one is recorded:
     * - a tool the agent did not offer on that request (Claude Code: "No such tool available");
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

/** Where the recorders write, per world. */
function logs(world) {
  return { mcp: join(world.root, "mcp-calls.jsonl"), shell: join(world.root, "shell-calls.jsonl") };
}

/** What the tool result said, kept apart from what happened. */
function refusalOf(c) {
  const text = c.result?.text ?? "";
  if (text.includes(MARKERS.deny)) return "orca-deny";
  if (text.includes(MARKERS.block)) return "orca-block";
  if (c.result === undefined) return c.made ? "no-result" : "no-call";
  return c.result.isError ? `agent:${text.slice(0, 120)}` : null;
}

function outcomeOf(c, refusal, effect) {
  if (effect.effect === "observed") return "allow";
  if (effect.effect !== "none") return "indeterminate";
  if (!c.made) return "not-made";
  if (!c.offered) return "unoffered";
  if (refusal === "orca-deny") return "deny";
  if (refusal === "orca-block") return "block";
  if (c.approvals.length) return "ask";
  return `refused:${(c.result?.text ?? refusal ?? "no result").slice(0, 160)}`;
}

function agentRefusal(p, outcome, effect) {
  if (effect.effect !== "none") return undefined;
  if (outcome === "unoffered") return "tool-not-offered";
  if (!outcome.startsWith("refused:")) return undefined;
  if (p.action.tool === "edit" && p.before === undefined && outcome.includes("File does not exist"))
    return "edit-of-missing-file";
  if (p.primed === "deny" && outcome.includes("has not been read yet")) return "unread-after-orca-denied-read";
  return undefined;
}

/**
 * The call's effect, from evidence the agent and ORCA do not write. MCP and shell calls are
 * settled after the turn by counting their recorder's lines (`settleCounted`).
 */
async function effectOf(p, c, surfaces) {
  if (c.made && !c.offered) return { effect: "none", evidence: "the tool was not offered on the request" };
  switch (p.action.tool) {
    case "write": {
      const after = await bytes(p.input.file_path);
      if (after === p.input.content) return { effect: "observed", evidence: "the file holds the written content" };
      if (after === p.before)
        return {
          effect: "none",
          evidence: p.before === undefined ? "the file still does not exist" : "the file is unchanged",
        };
      return { effect: "indeterminate", evidence: "the file changed to something else" };
    }
    case "edit": {
      const after = await bytes(p.input.file_path);
      if (after === p.before)
        return {
          effect: "none",
          evidence: p.before === undefined ? "the file still does not exist" : "the file is unchanged",
        };
      return { effect: "observed", evidence: "the file changed" };
    }
    case "read": {
      if (!p.token) return { effect: "indeterminate", evidence: "no distinctive content to look for" };
      return surfaces.some((s) => s.includes(p.token))
        ? { effect: "observed", evidence: "the file's content reached the model" }
        : { effect: "none", evidence: "the file's content is in no tool result of the turn" };
    }
    case "mcp":
    case "shell":
      return { effect: "pending", evidence: "" };
    default:
      return { effect: "indeterminate", evidence: "no independent evidence for this tool" };
  }
}

/**
 * MCP and shell calls by their recorder's log: an MCP answer names its log line, so a call whose
 * result names a new line ran; the rest of the turn's calls of that kind ran nowhere only if the
 * new lines are exactly the ones accounted for. Otherwise they are indeterminate.
 */
function settleCounted(prepared, seen, effects, tool, newLines) {
  const idx = prepared
    .map((p, i) => (p.action.tool === tool && effects[i].effect === "pending" ? i : -1))
    .filter((i) => i >= 0);
  if (idx.length === 0) return;
  if (tool === "mcp") {
    for (const i of idx) {
      const text = seen.calls[i].result?.text ?? "";
      if (!seen.calls[i].result?.isError && /^recorded [0-9a-f]{16}$/.test(text.trim()))
        effects[i] = { effect: "observed", evidence: "the MCP recorder logged and answered this call" };
    }
  }
  const observed = idx.filter((i) => effects[i].effect === "observed").length;
  for (const i of idx) {
    if (effects[i].effect === "observed") continue;
    if (tool === "shell" && newLines === idx.length)
      effects[i] = { effect: "observed", evidence: "the shell recorder logged every command of the turn" };
    else if (newLines === observed)
      effects[i] = { effect: "none", evidence: `the ${tool} recorder logged no other call in the turn` };
    else
      effects[i] = {
        effect: "indeterminate",
        evidence: `${newLines} ${tool} recorder lines for ${observed} matched calls`,
      };
  }
}

/**
 * Something distinctive the read would hand back: a token written into a file that does not
 * exist yet (its directory must), or the content of one that does.
 */
async function readToken(world, file) {
  const existing = await bytes(file);
  if (existing !== undefined) {
    // The longest line: the agent's read output numbers lines, so only a whole line is contiguous.
    const longest = existing.split("\n").reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), "");
    return longest.length >= 8 ? longest : undefined;
  }
  const dir = await stat(dirname(file)).catch(() => undefined);
  if (!dir?.isDirectory()) return undefined;
  const token = `orca-706-read-${++world.seq}-${Date.now()}`;
  await writeFile(file, `${token}\n`);
  return token;
}

const bytes = (file) => readFile(file, "utf8").catch(() => undefined);
const lines = async (file) => ((await bytes(file)) ?? "").split("\n").filter(Boolean);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
