/**
 * The live runner for Codex's hook route (#1026): a real Codex, driven through the real Codex ACP
 * adapter, in a session ORCA opened the way the daemon opens it (`makeSessionFactory`, with
 * ORCA's pre-tool hook installed through `CODEX_CONFIG`), against a model stand-in that makes
 * exactly the tool calls a case asks for (`codex-model-stand-in.js`). Codex runs in the adapter's
 * full-access mode, with no sandbox and no approvals of its own: every call would run unasked,
 * so whatever stops a call is ORCA's hook.
 *
 * Each call is recorded as `connected/claude.js` records it, with three things kept apart:
 *
 * - `refusal`: what the tool output handed back to the model said (ORCA's denial or block, or
 *   Codex's own refusal text);
 * - `approvals`: always empty on Codex. Codex cannot pause a call for a person from a hook, so
 *   ORCA answers an ask with a block (exit 2 and "Blocked by ORCA: its policy asks a person
 *   first"), and nothing reaches ORCA's human channel. Such a call is recorded with outcome
 *   `block`, `orcaAnswer: "ask"`, and the inventory (`assertions.json`, `codex-connected`)
 *   accepts `block` wherever the case asserts an ask;
 * - `effect`: from evidence independent of the agent and of ORCA: the file's bytes, the MCP
 *   recorder's log, the shell recorder's log, or a token in an image a read hands back.
 *
 * The shell recorder is the login profile of the shell Codex runs commands in: each session
 * gets its own `HOME` whose `.bash_profile` and `.profile` append the command line
 * (`$BASH_EXECUTION_STRING`) to the world's log before it runs. Codex's shell snapshot is turned
 * off so the profile runs for every command, not once.
 *
 * Reads: Codex reads files through its shell; the one read it hooks by name is `view_image`,
 * which hands the image's bytes back to the model. A read's target is made a small PNG carrying
 * a token, so the token in that call's own output shows the read took effect.
 *
 * Surfaces are ORCA's part of each output. Codex wraps a hook's reason as `Command blocked by
 * PreToolUse hook: <reason>. Command: <the call's own input>`; the echo of the model's own
 * input is Codex's, so only `<reason>` is ORCA's answer. The whole output stays in the record.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import { LocalHost, openAcpSession } from "@orca/agents";
import { makeSessionFactory } from "../../../packages/cli/src/bootstrap.ts";
import { effectFrom } from "./evidence.js";

const RECORDER = fileURLToPath(new URL("./mcp-recorder.js", import.meta.url));

/** The MCP servers and tools the cases call, each one a recorder (as for Claude). */
export const MCP_SERVERS = {
  github: ["create_issue", "delete_repo", "create_issue_comment"],
  gitlab: ["create_issue"],
  slack: ["post"],
  s: ["t"],
};

const MCP_TOOLS = Object.entries(MCP_SERVERS).flatMap(([s, tools]) => tools.map((t) => `mcp__${s}__${t}`));
/** How Codex hands a hook's block back to the model, by tool. */
const BLOCKED = /^(?:Command|Tool call) blocked by PreToolUse hook: /;
const MARKERS = { deny: "Denied by ORCA: ", block: "Blocked by ORCA: ", ask: "Blocked by ORCA: its policy asks a person first" };

/** A patch in Codex's `apply_patch` format, as the model would write it. */
function codexPatch(op, path, content = "") {
  const body = op === "add" ? content.split("\n").map((l) => `+${l}`) : ["@@", "-a", "+b"];
  return ["*** Begin Patch", `*** ${op === "add" ? "Add" : "Update"} File: ${path}`, ...body, "*** End Patch", ""].join(
    "\n",
  );
}

/**
 * The call the model makes for an action: the tool Codex offers and its input. `name` is also
 * the name ORCA's hook sees, except a shell command, which Codex reports to the hook as `Bash`.
 */
export function codexCall(action) {
  switch (action.tool) {
    case "shell":
      return {
        name: "exec_command",
        hookName: "Bash",
        input: { cmd: action.command, ...(action.cwd ? { workdir: action.cwd } : {}) },
      };
    case "write":
      return { name: "apply_patch", hookName: "apply_patch", input: codexPatch("add", action.path, action.content) };
    case "edit":
      return { name: "apply_patch", hookName: "apply_patch", input: codexPatch("update", action.path) };
    case "read":
      return { name: "view_image", hookName: "view_image", input: { path: action.path } };
    case "mcp":
      return {
        name: `mcp__${action.server}__${action.name}`,
        hookName: `mcp__${action.server}__${action.name}`,
        input: action.input ?? {},
      };
    case "unknown":
      return { name: action.name, hookName: action.name, input: action.input ?? {} };
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
}

/**
 * @param {{ adapter: string, hookScript: string, model: { url: string, log: any } }} env
 */
export function codexConnected(env) {
  /** Codex pointed at the stand-in, with no sandbox, no approvals and every recorder. */
  const codexConfig = (world, extra = {}) => ({
    model: "gpt-5.5",
    model_provider: "standin",
    model_providers: {
      standin: { name: "standin", base_url: env.model.url, wire_api: "responses", env_key: "ORCA_1026_KEY" },
    },
    sandbox_mode: "danger-full-access",
    approval_policy: "never",
    // The profile records every command only if each command runs it. Plugins are cloned in
    // the background into CODEX_HOME, which only races the world's cleanup; no case uses one.
    features: { shell_snapshot: false, plugins: false, remote_plugin: false },
    mcp_servers: Object.fromEntries(
      Object.entries(MCP_SERVERS).map(([name, tools]) => [
        name,
        {
          command: process.execPath,
          args: [RECORDER, name, tools.join(",")],
          env: { ORCA_706_MCP_LOG: logs(world).mcp },
          default_tools_approval_mode: "approve",
        },
      ]),
    ),
    ...extra,
  });

  const path = {
    id: "codex-connected",
    capabilities: ["agent-turn", "mcp-grant-allows"],
    codexConfig,

    /** The agent as ORCA's config would declare it for this world. */
    agent(world, extraEnv = {}) {
      return AgentSpecSchema.parse({
        id: world.agentId,
        command: process.execPath,
        args: [env.adapter],
        env: {
          CODEX_HOME: join(world.root, "codex-home"),
          HOME: join(world.root, "home"),
          CODEX_CONFIG: JSON.stringify(codexConfig(world)),
          // The adapter takes sandbox and approvals from its session mode, not CODEX_CONFIG.
          INITIAL_AGENT_MODE: "agent-full-access",
          ORCA_1026_KEY: "sk-orca-1026-test",
          ORCA_706_SHELL_LOG: logs(world).shell,
          NO_PROXY: "127.0.0.1",
          no_proxy: "127.0.0.1",
          ...extraEnv,
        },
        permissions: world.configured,
        nativeToolHook: "experimental",
      });
    },

    /** Open a session the daemon's way. The world's `configured` is read now, as at session open. */
    async openSession(world, { askPermission, extraEnv, host, codexProcess } = {}) {
      await mkdir(join(world.root, "codex-home"), { recursive: true });
      patientDispose(world);
      await writeShellRecorder(world);
      // The CODEX_CONFIG ORCA hands the agent, hook included, kept so the installed run can run
      // the very command line and context file this session installed.
      const capturing = (o) => {
        world.installedCodexConfig = o.env?.["CODEX_CONFIG"];
        return openAcpSession(o);
      };
      return makeSessionFactory({ configDir: world.configDir, storeDir: ".orca" }, capturing, {
        runtime: process.execPath,
        script: env.hookScript,
        ...(codexProcess ? { codexProcess } : {}),
      })({
        host: host ?? new LocalHost({ id: "local", type: "local" }),
        agent: path.agent(world, extraEnv),
        cwd: world.workspace,
        askPermission: askPermission ?? (async () => undefined),
        logger: silentLogger,
        handshakeTimeoutMs: 60_000,
      });
    },

    async open(world) {
      if (world.connected) return world.connected;
      const state = { approvals: [] };
      const session = await path.openSession(world, {
        askPermission: async (req) => {
          // Codex in full-access mode never asks; an ask here would be recorded against its call.
          state.approvals.push({ toolCallId: req.toolCall.toolCallId, title: req.toolCall.title ?? "", answer: "reject_once" });
          world.asked.push(req.toolCall.title ?? "");
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

    /** Tool calls in one model response, and what came back to the model for each. */
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
        surfaces: results.map((r) => orcaPart(r.text)),
        outputs: results.map((r) => r.text),
        strayApprovals: approvals,
        calls: calls.map((c, i) => {
          const m = made[i];
          return {
            toolUseId: m?.toolUseId,
            made: m !== undefined && m.name === c.name,
            // Codex defers MCP tools behind tool_search for this model: a recorder's tool is
            // offered though it is not in the request's tool list.
            offered: m === undefined ? false : m.offered.includes(c.name) || MCP_TOOLS.includes(c.name),
            result: m ? results.find((r) => r.toolUseId === m.toolUseId) : undefined,
            // Codex never sends ORCA an ask for a hooked call; any that came is stray.
            approvals: [],
          };
        }),
      };
    },

    async decide(world, action, opts = {}) {
      const [got] = await path.decideAll(world, [action], opts);
      return got;
    },

    /** Several actions in one model response, so Codex may run them at the same time. */
    async decideAll(world, actions, opts = {}) {
      await path.open(world);
      const prepared = [];
      const restores = [];
      try {
        return await path.decidePrepared(world, actions, opts, prepared, restores);
      } finally {
        // A file a read was pointed at gets its own bytes back once the turn is over.
        for (const restore of restores.reverse()) await restore();
      }
    },

    async decidePrepared(world, actions, opts, prepared, restores) {
      for (const action of actions) {
        const call = codexCall(action);
        const callRef = `c${++world.seq}`;
        const input = typeof call.input === "string" ? call.input : { ...call.input };
        let content;
        // A write's effect is its content landing in the file, so it needs content to look for.
        if (action.tool === "write") {
          content = action.content ?? `orca-1026-${callRef}`;
        }
        const patchInput =
          action.tool === "write" ? codexPatch("add", action.path, content) : action.tool === "edit" ? input : undefined;
        // An MCP call carries its own id, which the recorder logs.
        if (action.tool === "mcp") input.orca706Call = callRef;
        const before = action.tool === "write" || action.tool === "edit" ? await bytes(action.path) : undefined;
        const read = action.tool === "read" ? await readToken(action.path, callRef) : undefined;
        const token = read?.token;
        if (read?.restore) restores.push(read.restore);
        prepared.push({
          action,
          name: call.name,
          hookName: call.hookName,
          input: patchInput ?? input,
          content,
          callRef,
          before,
          token,
        });
      }

      const shellBefore = (await lines(logs(world).shell)).length;
      const mcpBefore = (await lines(logs(world).mcp)).length;
      const seen = await path.turn(
        world,
        prepared.map((p) => ({ name: p.name, input: p.input })),
        opts,
      );
      const shellLines = (await lines(logs(world).shell)).slice(shellBefore).map((l) => JSON.parse(l));
      // Codex's own shell snapshot (one login shell it starts after its first command, to copy
      // the environment) is not a call; it is counted apart, by its fixed script.
      const shellRan = shellLines.filter((l) => !isCodexSnapshot(l));
      const snapshots = shellLines.length - shellRan.length;
      const mcpRan = (await lines(logs(world).mcp)).slice(mcpBefore).map((l) => JSON.parse(l));

      const out = [];
      for (const [i, p] of prepared.entries()) {
        const c = seen.calls[i];
        const effectRef = await effectRefOf(p, c, { shellRan, snapshots, mcpRan, prepared, outputs: seen.outputs });
        const effect = effectFrom(effectRef);
        const refusal = refusalOf(c);
        const unobserved = orcaUnobserved(c, refusal, effect);
        const orcaAnswer = orcaAnswerOf(c);
        const outcome = outcomeOf(c, refusal, effect, unobserved);
        const record = {
          toolUseId: c.toolUseId ?? null,
          // The outcomes the case's assertion accepts for this call, as Codex can show them: an
          // ORCA ask is a block on Codex. Null when the case asserts none.
          expected: opts.expect ? codexExpected(opts.expect) : null,
          tool: p.hookName.slice(0, 120),
          outcome,
          ...(orcaAnswer ? { orcaAnswer } : {}),
          orcaDecision: unobserved ? "unobserved" : "observed",
          ...(unobserved ? { unobservedBecause: unobserved } : {}),
          refusal,
          approvals: [],
          effect,
          effectRef,
        };
        (world.callRecords ??= []).push(record);
        out.push({
          // What the case asserts on: ORCA's answer, which on Codex an ask shows only as its text.
          outcome: outcome === "block" && orcaAnswer === "ask" ? "ask" : outcome,
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
     * A call Codex refused on its own before ORCA could answer (a tool it does not offer:
     * "unsupported call") lets the case go on when it is proven to have had no effect, recorded
     * as `orcaDecision: "unobserved"`; it is not evidence of enforcement.
     */
    equivalent(world, got, expected) {
      if (!got.agentRefusal || (expected !== "ask" && expected !== "deny")) return false;
      (world.agentRefusals ??= []).push({ expected, unobservedBecause: got.agentRefusal, tool: got.detail.tool });
      return true;
    },
  };
  return path;
}

/**
 * Codex may still be writing its home (skills, caches) as a session closes, so the world's
 * removal is retried until that settles. Installed once per world.
 */
function patientDispose(world) {
  if (world.patientDispose) return;
  world.patientDispose = true;
  const dispose = world.dispose;
  world.dispose = async () => {
    for (let i = 0; ; i++) {
      try {
        return await dispose();
      } catch (error) {
        if (i >= 20 || error?.code !== "ENOTEMPTY") throw error;
        await sleep(250);
      }
    }
  };
}

/** On Codex an ORCA ask is a block, so an assertion that accepts an ask accepts that block. */
export function codexExpected(expected) {
  return [...new Set(expected.map((e) => (e === "ask" ? "block" : e)))];
}

/** Where the recorders write, per world. */
function logs(world) {
  return { mcp: join(world.root, "mcp-calls.jsonl"), shell: join(world.root, "shell-calls.jsonl") };
}

/**
 * The login profile of this world's `HOME`: it appends the command line of the shell Codex
 * started (one JSON string per line) to the world's shell log, before the command runs. A
 * command that ran leaves a line, read independently of anything Codex or ORCA says.
 */
async function writeShellRecorder(world) {
  const home = join(world.root, "home");
  await mkdir(home, { recursive: true });
  const record = [
    "# #1026 shell recorder: every command Codex runs is logged before it runs.",
    'if [ -n "${ORCA_706_SHELL_LOG:-}" ] && [ -n "${BASH_EXECUTION_STRING:-}" ]; then',
    `  ${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify(process.argv[1]) + "\\n")' "$BASH_EXECUTION_STRING" >>"$ORCA_706_SHELL_LOG" || exit 97`,
    "fi",
    "",
  ].join("\n");
  await writeFile(join(home, ".bash_profile"), record);
  await writeFile(join(home, ".profile"), record);
}

/** Codex 0.171.0's shell snapshot script, which it runs in a login shell of its own. */
const isCodexSnapshot = (line) =>
  line.includes("__codex_snapshot_command()") && line.includes("echo '# Snapshot file'");

/** ORCA's part of a tool output: the hook's reason, without Codex's echo of the call. */
export function orcaPart(text) {
  const head = BLOCKED.exec(text)?.[0];
  if (head === undefined) return text;
  const rest = text.slice(head.length);
  const echo = rest.indexOf(". Command: ");
  return echo < 0 ? rest : rest.slice(0, echo);
}

/** ORCA's answer as its hook's reason names it, when the output carries one. */
function orcaAnswerOf(c) {
  const reason = BLOCKED.test(c.result?.text ?? "") ? orcaPart(c.result.text) : "";
  if (reason.startsWith(MARKERS.deny)) return "deny";
  if (reason.startsWith(MARKERS.ask)) return "ask";
  if (reason.startsWith(MARKERS.block)) return "block";
  return undefined;
}

/** What the tool output said, kept apart from what happened. */
function refusalOf(c) {
  const answer = orcaAnswerOf(c);
  if (answer === "deny") return "orca-deny";
  if (answer === "ask" || answer === "block") return "orca-block";
  if (c.result === undefined) return c.made ? "no-result" : "no-call";
  const text = c.result.text;
  return /^unsupported call|^unable to |verification failed|blocked by PreToolUse hook|^aborted/.test(text)
    ? `agent:${text.slice(0, 120)}`
    : null;
}

function outcomeOf(c, refusal, effect, unobserved) {
  if (effect === "observed") return "allow";
  if (effect !== "none") return "indeterminate";
  if (unobserved) return `unobserved:${unobserved}`;
  if (!c.made) return "not-made";
  if (refusal === "orca-deny") return "deny";
  if (refusal === "orca-block") return "block";
  return `refused:${(c.result?.text ?? refusal ?? "no result").slice(0, 160)}`;
}

/** Why ORCA's decision for a call was not observed: Codex refused it first. */
function orcaUnobserved(c, refusal, effect) {
  if (effect !== "none" || refusal === "orca-deny" || refusal === "orca-block") return undefined;
  if (c.made && !c.offered && (c.result?.text ?? "").startsWith("unsupported call")) return "tool-not-offered";
  return undefined;
}

/**
 * The evidence for one call's effect, bound to that call (as in `connected/claude.js`): its
 * file's bytes, the recorder line carrying its own id, the shell line carrying its own command,
 * or its own output holding the read token. Hashes stand in for contents.
 */
async function effectRefOf(p, c, { shellRan, snapshots, mcpRan, prepared, outputs }) {
  if (c.made && !c.offered) return { kind: "not-offered", toolUseId: c.toolUseId };
  switch (p.action.tool) {
    case "write":
    case "edit": {
      const after = await bytes(p.action.path);
      return {
        kind: "file",
        path: digest(p.action.path),
        before: p.before === undefined ? null : digest(p.before),
        after: after === undefined ? null : digest(after),
        ...(p.action.tool === "write" ? { written: digest(`${p.content}\n`) } : {}),
      };
    }
    case "mcp": {
      const mine = mcpRan.filter((l) => l.input?.orca706Call === p.callRef).map((l) => l.nonce);
      const others = new Set(prepared.filter((q) => q.action.tool === "mcp").map((q) => q.callRef));
      // Codex puts its own timing lines before the server's answer.
      const answered = /(?:^|\n)recorded ([0-9a-f]{16})$/.exec((c.result?.text ?? "").trim())?.[1] ?? null;
      return {
        kind: "mcp",
        callRef: p.callRef,
        loggedFor: mine,
        answeredWith: answered,
        unaccountedLines: mcpRan.filter((l) => !others.has(l.input?.orca706Call)).length,
      };
    }
    case "shell": {
      const ours = prepared.filter((q) => q.action.tool === "shell").map((q) => q.action.command);
      return {
        kind: "shell",
        command: digest(p.action.command),
        matching: shellRan.filter((l) => l === p.action.command).length,
        unaccountedLines: shellRan.filter((l) => !ours.includes(l)).length,
        codexSnapshots: snapshots,
      };
    }
    case "read": {
      const own = c.result?.text;
      return {
        kind: "read",
        token: p.token ? digest(p.token) : null,
        ownResult: own !== undefined,
        inOwnResult: p.token !== undefined && own !== undefined && own.includes(p.token),
        inOtherResult: p.token !== undefined && outputs.some((t) => t !== own && t.includes(p.token)),
      };
    }
    default:
      return { kind: "none-available" };
  }
}

/**
 * Something distinctive the read would hand back: `view_image` hands the model the image's
 * bytes, so the read's target becomes a 1x1 PNG carrying a token in a text chunk. A file that
 * does not exist yet (its directory must) is created; one that exists has its bytes swapped for
 * the image for this one turn and put back after it (`restore`). ORCA decides a read by its
 * path, never by the file's bytes, so the swap changes nothing ORCA reads; it only makes the
 * read's effect visible.
 */
async function readToken(file, callRef) {
  const dir = await stat(dirname(file)).catch(() => undefined);
  if (!dir?.isDirectory()) return {};
  const existing = await readFile(file).catch((error) => (error.code === "ENOENT" ? undefined : error));
  if (existing instanceof Error) return {};
  const token = `orca-1026-read-${callRef}-${Date.now()}`;
  await writeFile(file, tokenPng(token));
  return {
    token,
    restore: existing === undefined ? () => rm(file, { force: true }) : () => writeFile(file, existing),
  };
}

/** A 1x1 PNG with `token` in a tEXt chunk. */
export function tokenPng(token) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`orca\0${token}`, "latin1")),
    chunk("IDAT", deflateSync(Buffer.from([0, 0xff, 0xff, 0xff]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const bytes = (file) => readFile(file, "utf8").catch(() => undefined);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const lines = async (file) => ((await bytes(file)) ?? "").split("\n").filter(Boolean);
