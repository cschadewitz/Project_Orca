/**
 * A stand-in for `claude --input-format stream-json --output-format stream-json`, the process
 * the Claude Agent SDK drives (#1120). It speaks the SDK's control protocol and plays a fixed
 * script per prompt, so no account and no model are involved.
 *
 * Startup: `STAND_IN_STARTUP` = `ok` (default), `silent` (never answers initialize), `exit`
 * (exits at once) or `old` (answers without hook `onFailure` support).
 * Turns: the first word of the prompt picks the script (see `turn` below).
 * `STAND_IN_REFUSE_CONFIG` refuses every model and effort change, `STAND_IN_REFUSE_SET_MODEL`
 * every model change, `STAND_IN_FLAGS_OK=n` every effort change after the first n;
 * `STAND_IN_CONFIG_DELAY_MS` answers changes that late.
 * `STAND_IN_STUBBORN`, when set, keeps it running after its input ends and through SIGTERM.
 * `STAND_IN_LOG`, when set, gets one JSON line per input line and the argv.
 * `STAND_IN_TRANSCRIPTS`, when set, is where sessions are kept: one file per `--session-id`,
 * holding its prompts, which `--resume <id>` continues and the `history` script reports. A resume
 * of an id with no file fails the way Claude Code does (an error result, then exit), and
 * `STAND_IN_RESUME_SILENT` makes a resume never answer initialize.
 * `STAND_IN_MCP_EARLY=<server>` lists that in-process MCP server's tools as initialize arrives,
 * before answering it (as Claude Code may), and logs the answer as `{ mcp }`.
 * `STAND_IN_MCP_ON_END=<server>` lists them once its input has ended.
 * `STAND_IN_CLAIM=<path>` makes it claim to be that program: its process title (so its
 * `/proc/<pid>/cmdline`) and what it says in `initialize` and its init message name the path.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const log = (o) => process.env.STAND_IN_LOG && appendFileSync(process.env.STAND_IN_LOG, JSON.stringify(o) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const SESSION = "stand-in-session";
const startup = process.env.STAND_IN_STARTUP ?? "ok";
const claim = process.env.STAND_IN_CLAIM;
if (claim) process.title = claim;
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, pid: process.pid });
if (startup === "exit") process.exit(3);

const argv = process.argv.slice(2);
const flag = (name) => {
  const joined = argv.find((a) => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  return argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
};
const resumed = flag("--resume");
const sessionFile = (() => {
  const dir = process.env.STAND_IN_TRANSCRIPTS;
  const sessionId = resumed ?? flag("--session-id");
  return dir && sessionId ? join(dir, sessionId) : undefined;
})();
if (resumed !== undefined && (!sessionFile || !existsSync(sessionFile))) {
  out({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: resumed,
    uuid: "resume-failed",
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: [`No conversation found with session ID: ${resumed} SENTINEL-resume-cli-text`],
  });
  process.exit(1);
}
/** The prompts this session (and the one it resumed) was sent. */
const history = () =>
  sessionFile && existsSync(sessionFile)
    ? readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
// Ignores the end of its input and SIGTERM, so only a kill stops it.
if (process.env.STAND_IN_STUBBORN) {
  setInterval(() => undefined, 1000);
  process.on("SIGTERM", () => undefined);
}

/** What `set_model` and `apply_flag_settings` changed, reported by the `config` turn. */
const state = { model: null, effort: null };
const MODELS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "the stand-in's default",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    displayName: "Sonnet\u0007 stand-in",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
  { value: "old-model", displayName: "Old", description: "x".repeat(500) },
  { value: "bad id with spaces", displayName: "refused row" },
  { value: "sonnet", displayName: "duplicate" },
];

/** How many `apply_flag_settings` succeed before the rest are refused (STAND_IN_FLAGS_OK). */
let flagsOk = process.env.STAND_IN_FLAGS_OK === undefined ? Infinity : Number(process.env.STAND_IN_FLAGS_OK);

let hookId;
let nextRequest = 0;
const pending = new Map();
let interrupted;
/** The last `can_use_tool` answer, with the hook's decision, for the `call` script. */
let lastAnswer;

/** List an in-process MCP server's tools through the SDK, and log what came back. */
const mcpList = (server) =>
  ask({
    subtype: "mcp_message",
    server_name: server,
    message: { jsonrpc: "2.0", id: nextRequest++, method: "tools/list" },
  }).then((r) => log({ mcp: r }));

/** Ask the SDK something (a hook callback or a permission) and wait for its answer. */
function ask(request) {
  const id = `req_${nextRequest++}`;
  out({ type: "control_request", request_id: id, request });
  return new Promise((resolve) => pending.set(id, resolve));
}

const assistant = (content, parent = null) =>
  out({
    type: "assistant",
    session_id: SESSION,
    uuid: `a${nextRequest++}`,
    parent_tool_use_id: parent,
    message: {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "stand-in",
      content,
      stop_reason: null,
      usage: {},
    },
  });
const toolResult = (id, content, isError) =>
  out({
    type: "user",
    session_id: SESSION,
    uuid: `u${nextRequest++}`,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  });
const result = (extra = {}) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    stop_reason: "end_turn",
    session_id: SESSION,
    uuid: `r${nextRequest++}`,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    ...extra,
  });

/**
 * Run one tool use through the SDK the way Claude Code does: hook first; a hook `allow` skips the
 * permission check, a hook `ask` always asks, no decision leaves it to Claude's rules, which may
 * ask (`asks`). `extra` goes on the ask (`agent_id`, `decision_reason`, …); `parent` is the
 * tool call that started the subagent making this one.
 */
async function tool(id, name, input, asks = false, extra = {}, parent = null, cwd = process.cwd()) {
  assistant([{ type: "tool_use", id, name, input }], parent);
  const hook = await ask({
    subtype: "hook_callback",
    callback_id: hookId,
    tool_use_id: id,
    input: {
      hook_event_name: "PreToolUse",
      tool_name: name,
      tool_input: input,
      tool_use_id: id,
      session_id: SESSION,
      cwd,
    },
  });
  const decision = hook?.hookSpecificOutput?.permissionDecision;
  if (decision === "deny") {
    toolResult(id, hook.hookSpecificOutput.permissionDecisionReason, true);
    return "denied";
  }
  if (decision === "ask" || (asks && decision !== "allow")) {
    const answer = await ask({ subtype: "can_use_tool", tool_name: name, input, tool_use_id: id, ...extra });
    lastAnswer = { hook: decision ?? null, ...answer };
    toolResult(id, answer.message ?? "allowed", answer.behavior !== "allow");
    return answer.behavior;
  }
  toolResult(id, `ran ${name}`, false);
  return "ran";
}

async function turn(text) {
  const word = text.split(/\s+/)[0];
  interrupted = undefined;
  out({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    uuid: "init",
    cwd: process.cwd(),
    ...(claim ? { executable: claim, claude_code_path: claim } : {}),
    tools: [],
    model: "stand-in",
    permissionMode: "default",
  });
  switch (word) {
    case "call": {
      // `call {"name":…,"input":…,"asks":true,"extra":{…},"parent":"…","cwd":"…"}`: one tool
      // use (run in `cwd`, its own by default), and what the hook and the permission answer were.
      const c = JSON.parse(text.slice("call ".length));
      lastAnswer = undefined;
      const ran = await tool(
        `c${nextRequest++}`,
        c.name,
        c.input,
        c.asks ?? false,
        c.extra ?? {},
        c.parent ?? null,
        c.cwd ?? process.cwd(),
      );
      assistant([{ type: "text", text: JSON.stringify({ ran, answer: lastAnswer ?? null }) }]);
      return result();
    }
    case "history":
      assistant([{ type: "text", text: JSON.stringify(history()) }]);
      return result();
    case "config":
      assistant([{ type: "text", text: JSON.stringify(state) }]);
      return result();
    case "hello":
      assistant([{ type: "thinking", thinking: "thinking about it", signature: "" }]);
      assistant([{ type: "text", text: `you said: ${text}` }]);
      return result();
    case "tools": {
      const read = await tool("t1", "Read", { file_path: text.split(/\s+/)[1] });
      const bash = await tool("t2", "Bash", { command: "echo hi" });
      const grep = await tool("t2g", "Grep", { pattern: "x", path: process.cwd() });
      const todo = await tool("t3", "TodoWrite", {
        todos: [
          { content: "look", status: "completed", activeForm: "looking" },
          { content: "write", status: "in_progress", activeForm: "writing" },
        ],
      });
      assistant([{ type: "text", text: JSON.stringify({ read, bash, grep, todo }) }]);
      return result();
    }
    case "ask": {
      // A read outside the working directory: the hook lets it through, Claude Code then asks.
      const answer = await tool("t4", "Read", { file_path: "/etc/hostname" }, true);
      assistant([{ type: "text", text: answer }]);
      return result();
    }
    case "env":
      assistant([{ type: "text", text: JSON.stringify(process.env) }]);
      return result();
    case "slow":
    case "wedge":
      assistant([{ type: "text", text: "working" }]);
      await new Promise((r) => (interrupted = r));
      if (word === "wedge") return; // never ends the turn
      return out({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        stop_reason: null,
        session_id: SESSION,
        uuid: "rc",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        errors: [],
      });
    case "fail":
      return result({ is_error: true, result: `API Error: ${text}` });
    case "usage": {
      // `usage [utilization]`: a turn's usage, and the subscription limit close when given.
      const utilization = text.split(/\s+/)[1];
      if (utilization)
        out({
          type: "rate_limit_event",
          session_id: SESSION,
          uuid: `rl${nextRequest++}`,
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: Number(utilization),
            resetsAt: 1795000000,
          },
        });
      out({
        type: "assistant",
        session_id: SESSION,
        uuid: `a${nextRequest++}`,
        parent_tool_use_id: null,
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "claude-stand-in",
          content: [{ type: "text", text: "counted" }],
          stop_reason: null,
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 30000,
            cache_creation_input_tokens: 500,
            output_tokens: 300,
          },
        },
      });
      return result({
        total_cost_usd: 0.4249,
        modelUsage: {
          "claude-stand-in": {
            inputTokens: 1200,
            outputTokens: 300,
            cacheReadInputTokens: 30000,
            cacheCreationInputTokens: 500,
            webSearchRequests: 0,
            costUSD: 0.4249,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        },
      });
    }
    case "usagejson": {
      // `usagejson {"model":…|null,"modelUsage":{…}}`: a call by that model (none for null), then
      // a result with those per-model totals.
      const u = JSON.parse(text.slice("usagejson ".length));
      if (u.model)
        out({
          type: "assistant",
          session_id: SESSION,
          uuid: `a${nextRequest++}`,
          parent_tool_use_id: null,
          message: {
            id: "msg",
            type: "message",
            role: "assistant",
            model: u.model,
            content: [{ type: "text", text: "counted" }],
            stop_reason: null,
            usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
          },
        });
      return result({ total_cost_usd: 0.01, modelUsage: u.modelUsage });
    }
    case "limit":
    case "throttle": {
      // `limit [resetsAt]`: the subscription limit is reached; `throttle`: an API key's HTTP 429.
      if (word === "limit") {
        const at = text.split(/\s+/)[1];
        out({
          type: "rate_limit_event",
          session_id: SESSION,
          uuid: `rl${nextRequest++}`,
          rate_limit_info: {
            status: "rejected",
            rateLimitType: text.split(/\s+/)[2] ?? "seven_day",
            ...(at === "none" ? {} : { resetsAt: Number(at ?? 1795000000) }),
          },
        });
      }
      out({
        type: "assistant",
        session_id: SESSION,
        uuid: `a${nextRequest++}`,
        parent_tool_use_id: null,
        error: "rate_limit",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "SENTINEL-1127-cli-text limit reached" }],
          stop_reason: "stop_sequence",
          usage: {},
        },
      });
      return result({ is_error: true, api_error_status: 429, result: "SENTINEL-1127-cli-text limit reached" });
    }
    case "maxturns":
      return result({ subtype: "error_max_turns", is_error: true, errors: [] });
    case "die":
      assistant([{ type: "text", text: "about to go" }]);
      return process.exit(7);
    case "grandchild": {
      const c = spawn("sleep", ["300"], { stdio: "ignore" });
      assistant([{ type: "text", text: String(c.pid) }]);
      return result();
    }
    default:
      assistant([{ type: "text", text: `unknown script ${word}` }]);
      return result();
  }
}

let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("close", () => {
  if (process.env.STAND_IN_MCP_ON_END) void mcpList(process.env.STAND_IN_MCP_ON_END);
});
lines.on("line", (line) => {
  const m = JSON.parse(line);
  log({ in: m });
  if (m.type === "control_response") {
    const resolve = pending.get(m.response.request_id);
    pending.delete(m.response.request_id);
    resolve?.(m.response.response);
    return;
  }
  if (m.type === "control_request") {
    const req = m.request;
    if (req.subtype === "initialize") {
      if (process.env.STAND_IN_MCP_EARLY) void mcpList(process.env.STAND_IN_MCP_EARLY);
      if (startup === "silent" || (resumed && process.env.STAND_IN_RESUME_SILENT)) return;
      hookId = req.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
      return out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: MODELS,
            account: {},
            hooks_applied: true,
            hook_on_failure_supported: startup !== "old",
            mcp_servers_applied: true,
            ...(claim ? { executable: claim, path: claim } : {}),
          },
        },
      });
    }
    if (req.subtype === "interrupt") interrupted?.();
    if (req.subtype === "set_model" || req.subtype === "apply_flag_settings") {
      const refuse =
        process.env.STAND_IN_REFUSE_CONFIG ||
        (req.subtype === "set_model" && process.env.STAND_IN_REFUSE_SET_MODEL) ||
        (req.subtype === "apply_flag_settings" && flagsOk-- <= 0);
      if (process.env.STAND_IN_CONFIG_DELAY_MS && !refuse) {
        const id = m.request_id;
        const apply = () => {
          if (req.subtype === "set_model") state.model = req.model;
          else if ("effortLevel" in req.settings) state.effort = req.settings.effortLevel;
          out({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
        };
        return void setTimeout(apply, Number(process.env.STAND_IN_CONFIG_DELAY_MS));
      }
      if (refuse)
        return out({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: m.request_id,
            error: `${process.env.STAND_IN_REFUSE_CONFIG ?? "SENTINEL-7c1e-cli-text"} refused`,
          },
        });
      if (req.subtype === "set_model") state.model = req.model;
      else if ("effortLevel" in req.settings) state.effort = req.settings.effortLevel;
    }
    return out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
  }
  if (m.type === "user") {
    const content = m.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ");
    if (sessionFile) appendFileSync(sessionFile, JSON.stringify(text) + "\n");
    queue = queue.then(() => turn(text));
  }
});
