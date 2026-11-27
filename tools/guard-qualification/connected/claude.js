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
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import { LocalHost, openAcpSession } from "@orca/agents";
import { makeSessionFactory } from "../../../packages/cli/src/bootstrap.ts";
import { claudeShape } from "../world.js";
import { effectFrom } from "./evidence.js";

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

/** What ORCA's refusal says in the tool result handed back to the model, on this route. */
const MARKERS = { deny: ["Denied by ORCA"], block: ["Blocked by ORCA"] };

/**
 * @param {{ adapter: string, hookScript: string, model: { url: string, log: any },
 *   markers?: { deny: string[], block: string[] } }} env `markers` replace the ACP route's
 *   refusal texts, for a connected path over another Claude route that reuses this one.
 */
export function claudeConnected(env) {
  const markers = env.markers ?? MARKERS;
  const path = {
    id: "claude-connected",
    capabilities: ["answerer", "agent-turn", "mcp-grant-allows"],

    /**
     * The agent as ORCA's config would declare it for this world: with the hook opted in
     * (`nativeToolHook: experimental`) unless `nativeToolHook` says otherwise, and with the
     * field left out when it is null, as a config that never mentions it.
     */
    agent(world, extraEnv = {}, nativeToolHook = "experimental") {
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
        ...(nativeToolHook === null ? {} : { nativeToolHook }),
      });
    },

    /** Open a session the daemon's way. The world's `configured` is read now, as at session open. */
    async openSession(world, { askPermission, extraEnv, host, nativeToolHook, judge } = {}) {
      const claudeConfig = join(world.root, "claude-config");
      await mkdir(claudeConfig, { recursive: true });
      await writeFile(join(claudeConfig, "settings.json"), JSON.stringify(CLAUDE_SETTINGS));
      // The hook settings ORCA hands the agent at session/new, kept so the installed run can
      // run the very program, arguments and context file this session installed.
      const capturing = (o) =>
        openAcpSession({
          ...o,
          ...(o.sessionMeta
            ? {
                sessionMeta: async (...args) => {
                  const meta = await o.sessionMeta(...args);
                  world.installedMeta = meta;
                  return meta;
                },
              }
            : {}),
        });
      return makeSessionFactory({ configDir: world.configDir, storeDir: ".orca" }, capturing, {
        runtime: process.execPath,
        script: env.hookScript,
      })({
        host: host ?? new LocalHost({ id: "local", type: "local" }),
        agent: path.agent(world, extraEnv, nativeToolHook),
        cwd: world.workspace,
        askPermission: askPermission ?? (async () => undefined),
        logger: silentLogger,
        handshakeTimeoutMs: 60_000,
        // A judge prepared for this session (#701), as the daemon's judged factory hands it over.
        ...(judge ?? {}),
      });
    },

    async open(world) {
      if (world.connected) return world.connected;
      const state = { approvals: [], answer: undefined };
      const session = await path.openSession(world, {
        // A world opts in like every case unless it says otherwise (null: a config without the field).
        nativeToolHook: world.nativeToolHook,
        judge: world.judge,
        askPermission: async (req, _invocation, judged) => {
          const approval = {
            toolCallId: req.toolCall.toolCallId,
            title: req.toolCall.title ?? "",
            // The ACP session the ask came from, so a fresh session's asks are shown to be its own.
            sessionId: req.sessionId,
            answer: "pending",
            // A judge's verdict shown with the ask (#701): only its fixed codes, never a criterion.
            ...(judged
              ? {
                  judged: {
                    verdict: judged.verdict,
                    kind: judged.kind ?? null,
                    advisory: judged.advisory === true,
                    reasonCode: judged.reasonCode ?? null,
                  },
                }
              : {}),
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
            toolUseId: m?.toolUseId,
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
        const callRef = `c${++world.seq}`;
        // A write's effect is its content landing in the file, so it needs content to look for.
        if (action.tool === "write" && !action.content) input.content = `orca-706-${callRef}`;
        // An MCP call carries its own id, which the recorder logs: its effect, or its absence,
        // is bound to this call and no other.
        if (action.tool === "mcp") input.orca706Call = callRef;
        const before = action.tool === "write" || action.tool === "edit" ? await bytes(input.file_path) : undefined;
        const token = action.tool === "read" ? await readToken(world, input.file_path, callRef) : undefined;
        prepared.push({ action, name: toolName, input, callRef, before, token, primed: undefined });
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
          p.primed =
            refusalOf(c, markers) === "orca-deny"
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

      const shellBefore = (await lines(logs(world).shell)).length;
      const mcpBefore = (await lines(logs(world).mcp)).length;
      if (opts.noAnswerer) state.answer = () => undefined;
      // The person sees the ask with the calls this turn was made of: the tool and its exact
      // input, so a simulated answer can be bound to the one fixture it is for.
      else if (opts.onAsk) {
        const turnCalls = prepared.map((p) => ({ name: p.name, input: structuredClone(p.input) }));
        state.answer = (req) => opts.onAsk(req, turnCalls);
      }
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
      const shellRan = (await lines(logs(world).shell)).slice(shellBefore).map((l) => JSON.parse(l));
      const mcpRan = (await lines(logs(world).mcp)).slice(mcpBefore).map((l) => JSON.parse(l));

      const out = [];
      for (const [i, p] of prepared.entries()) {
        const c = seen.calls[i];
        const effectRef = await effectRefOf(p, c, { shellRan, mcpRan, prepared, surfaces: seen.surfaces });
        const effect = effectFrom(effectRef);
        const refusal = refusalOf(c, markers);
        const unobserved = orcaUnobserved(p, c, refusal, effect);
        const outcome = outcomeOf(c, refusal, effect, unobserved);
        const record = {
          toolUseId: c.toolUseId ?? null,
          // The outcomes the case's assertion accepts for this call; null when it asserts none.
          expected: opts.expect ?? null,
          tool: p.name.slice(0, 120),
          outcome,
          // Whether ORCA's own decision for this call was observed. An agent's own refusal is
          // not, and does not count toward qualification.
          orcaDecision: unobserved ? "unobserved" : "observed",
          ...(unobserved ? { unobservedBecause: unobserved } : {}),
          refusal,
          approvals: c.approvals.map((a) => ({
            toolCallId: a.toolCallId,
            sessionId: a.sessionId,
            answer: a.answer,
            ...(a.judged ? { judged: a.judged } : {}),
          })),
          effect,
          effectRef,
          ...(p.primed ? { primingRead: p.primed } : {}),
        };
        (world.callRecords ??= []).push(record);
        out.push({
          outcome,
          detail: { ...record, result: c.result?.text.slice(0, 300) },
          surfaces: seen.surfaces,
          agentRefusal: unobserved,
        });
      }
      if (seen.strayApprovals.length)
        (world.callRecords ??= []).push({
          strayApprovals: seen.strayApprovals.map((a) => ({ toolCallId: a.toolCallId, title: a.title.slice(0, 120) })),
        });
      return out;
    },

    /**
     * A call Claude Code refused on its own, before ORCA could answer, lets the case go on when
     * it is proven to have had no effect and nothing could have run anyway, but it is recorded
     * as `orcaDecision: "unobserved"` and is not evidence of enforcement:
     * - a tool the agent did not offer on that request (Claude Code: "No such tool available");
     * - an Edit of a file that does not exist (Edit cannot create a file);
     * - a change to a file whose read ORCA denied (Claude Code will not change it unread).
     */
    equivalent(world, got, expected) {
      if (!got.agentRefusal || (expected !== "ask" && expected !== "deny")) return false;
      (world.agentRefusals ??= []).push({ expected, unobservedBecause: got.agentRefusal, tool: got.detail.tool });
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
function refusalOf(c, markers) {
  const text = c.result?.text ?? "";
  if (markers.deny.some((m) => text.includes(m))) return "orca-deny";
  if (markers.block.some((m) => text.includes(m))) return "orca-block";
  if (c.result === undefined) return c.made ? "no-result" : "no-call";
  return c.result.isError ? `agent:${text.slice(0, 120)}` : null;
}

function outcomeOf(c, refusal, effect, unobserved) {
  if (effect === "observed") return "allow";
  if (effect !== "none") return "indeterminate";
  if (unobserved) return `unobserved:${unobserved}`;
  if (!c.made) return "not-made";
  if (refusal === "orca-deny") return "deny";
  if (refusal === "orca-block") return "block";
  if (c.approvals.length) return "ask";
  return `refused:${(c.result?.text ?? refusal ?? "no result").slice(0, 160)}`;
}

/** Why ORCA's decision for a call was not observed: the agent refused it first. */
function orcaUnobserved(p, c, refusal, effect) {
  if (effect !== "none" || refusal === "orca-deny" || refusal === "orca-block" || c.approvals.length) return undefined;
  if (c.made && !c.offered) return "tool-not-offered";
  const text = c.result?.text ?? "";
  if (p.action.tool === "edit" && p.before === undefined && text.includes("File does not exist"))
    return "edit-of-missing-file";
  if (p.primed === "deny" && text.includes("has not been read yet")) return "unread-after-orca-denied-read";
  return undefined;
}

/**
 * The evidence for one call's effect, bound to that call: its file's bytes, the recorder line
 * carrying its own id, the shell line carrying its own command, or its own tool result holding
 * the read token. Hashes stand in for contents.
 */
async function effectRefOf(p, c, { shellRan, mcpRan, prepared, surfaces }) {
  if (c.made && !c.offered) return { kind: "not-offered", toolUseId: c.toolUseId };
  switch (p.action.tool) {
    case "write":
    case "edit": {
      const after = await bytes(p.input.file_path);
      return {
        kind: "file",
        path: digest(p.input.file_path),
        before: p.before === undefined ? null : digest(p.before),
        after: after === undefined ? null : digest(after),
        ...(p.action.tool === "write" ? { written: digest(p.input.content) } : {}),
      };
    }
    case "mcp": {
      const mine = mcpRan.filter((l) => l.input?.orca706Call === p.callRef).map((l) => l.nonce);
      const others = new Set(prepared.filter((q) => q.action.tool === "mcp").map((q) => q.callRef));
      const answered = /^recorded ([0-9a-f]{16})$/.exec((c.result?.text ?? "").trim())?.[1] ?? null;
      return {
        kind: "mcp",
        callRef: p.callRef,
        loggedFor: mine,
        answeredWith: c.result && !c.result.isError ? answered : null,
        // Lines that carry no call id of this turn: they would make an absence unprovable.
        unaccountedLines: mcpRan.filter((l) => !others.has(l.input?.orca706Call)).length,
      };
    }
    case "shell": {
      const quoted = `eval '${p.input.command.replaceAll("'", "'\\''")}'`;
      const matching = shellRan.filter((l) => l.includes(quoted)).length;
      const ours = prepared
        .filter((q) => q.action.tool === "shell")
        .map((q) => `eval '${q.input.command.replaceAll("'", "'\\''")}'`);
      return {
        kind: "shell",
        command: digest(p.input.command),
        matching,
        unaccountedLines: shellRan.filter((l) => !ours.some((o) => l.includes(o))).length,
      };
    }
    case "read": {
      const own = c.result?.text;
      return {
        kind: "read",
        token: p.token ? digest(p.token) : null,
        ownResult: own !== undefined,
        inOwnResult: p.token !== undefined && own !== undefined && own.includes(p.token),
        // The token in a result of the turn that is not this call's own would be ambiguous.
        inOtherResult: p.token !== undefined && surfaces.some((t) => t !== own && t.includes(p.token)),
      };
    }
    default:
      return { kind: "none-available" };
  }
}

/**
 * Something distinctive the read would hand back: a token written into a file that does not
 * exist yet (its directory must), or the content of one that does.
 */
async function readToken(world, file, callRef) {
  const existing = await bytes(file);
  if (existing !== undefined) {
    // The longest line: the agent's read output numbers lines, so only a whole line is contiguous.
    const longest = existing.split("\n").reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), "");
    return longest.length >= 8 ? longest : undefined;
  }
  const dir = await stat(dirname(file)).catch(() => undefined);
  if (!dir?.isDirectory()) return undefined;
  const token = `orca-706-read-${callRef}-${Date.now()}`;
  await writeFile(file, `${token}\n`);
  return token;
}

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** A file's text, or undefined when it does not exist. Any other read failure is not an absence: it throws. */
const bytes = (file) =>
  readFile(file, "utf8").catch((e) => {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  });
const lines = async (file) => ((await bytes(file)) ?? "").split("\n").filter(Boolean);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
