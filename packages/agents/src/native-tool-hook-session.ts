/**
 * Installing ORCA's pre-tool hook (`claude-pre-tool-hook.ts`) in an opted-in agent's session:
 * the Claude ACP adapter (#704) or the Codex ACP adapter (#705).
 *
 * `nativeToolHook: on` is a promise that the agent's tool calls are checked, so every session
 * this cannot guard is refused, never opened without the hook. It is also unavailable in every
 * build ORCA ships (`nativeToolHookUnavailable`) until a session can be held away from host
 * services until its runtime is admitted; only the hook's own suites install it.
 *
 * The two adapters take the hook at different moments, and ORCA knows which adapter it runs,
 * and at what version, only once the agent has answered `initialize`:
 *
 * - **Before the agent starts** (`prepare`): ORCA writes the session's context file (the
 *   rules, sidecars, workspace and protected paths the hook decides with) with owner-only
 *   permissions into a private directory ORCA protects from agents, and builds the
 *   environment that hands Codex its hook: `CODEX_CONFIG`, which the Codex ACP adapter passes
 *   to Codex as session flags. The hook goes there with its trust recorded beside it
 *   (`hooks.state`, keyed and hashed the way Codex 0.171 keys and hashes it), so Codex runs it
 *   without asking anybody to trust it and without writing to the user's Codex config. An
 *   agent that is not Codex ignores the variable.
 * - **After `initialize`** (`sessionMeta`):
 *   - **The Claude adapter** gets the hook in `session/new`'s
 *     `_meta.claudeCode.options.settings`, as an object, plus a session-start hook that
 *     records the process id of the Claude Code that ran it.
 *   - **The Codex adapter** has had it since it started; ORCA asks the adapter
 *     (`_codex/hooks/list`) and refuses the session unless Codex reports exactly ORCA's hook
 *     as trusted and enabled, and runs the hook once, through the same shell Codex will use,
 *     on a call it must block, and refuses unless it blocks and signs a receipt for that very
 *     call with the key in the session's context file (`probeCodexHook`). A Codex that hashed differently,
 *     a config that turned the hook off, or a shell that cannot run it would otherwise let
 *     every call through. ORCA also attests the Codex the adapter actually started, before
 *     the session is created.
 *   - **Anything else** is refused: another adapter, an agent that does not say who it is, an
 *     adapter version or a platform the acceptance tests do not run
 *     (`*_HOOK_VERIFIED_PAIRS`, `*_HOOK_VERIFIED_PLATFORMS`).
 * - **The runtime is attested on ORCA's own evidence**, never on what the adapter or the
 *   runtime says about itself. A report only points at a process; ORCA executes nothing it
 *   names. From its own side ORCA checks that the process is a live descendant of the agent
 *   process it started, and hashes the image that process actually runs (`/proc/<pid>/exe`,
 *   the kernel's handle on the running file, not a path) against the digest pinned for the
 *   adapter's verified pair on this platform and architecture. For Claude that happens in
 *   `verifyRuntime`, after the session starts and before it is given work; for Codex it
 *   happens in `sessionMeta`, before the session is created.
 *
 * The verified pairs are the ones `claude-hook-acceptance.yml` and `codex-hook-acceptance.yml`
 * install and run against the real agent. Another version may behave differently (an older
 * Claude Code may ignore `onFailure: "block"`; another Codex may hash its hooks differently),
 * so a session there would only look guarded.
 *
 * The hook runs on the agent's machine, so this applies to agents on the daemon's own host.
 * The factory refuses an opted-in agent on an SSH host before anything starts. `cleanup`
 * removes the context file and the runtime record when the session ends.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OrcaError, type ConfiguredPermissionPolicy } from "@orca/core";
import {
  CLAUDE_PRE_TOOL_TIMEOUT_SECONDS,
  claudePreToolHookSettings,
  claudeRuntimeAttestationFile,
  CODEX_PROBE_TOOL_USE_ID,
  codexProbeReceipt,
  type ClaudeHookContext,
  type ClaudeRuntimeAttestation,
} from "./claude-pre-tool-hook.js";
import { openHookTelemetrySpool, type HookTelemetrySpool } from "./hook-telemetry.js";
import type { ProtectedPaths } from "./permissions.js";

/**
 * Whether `nativeToolHook: on` can be used at all. It cannot, in any build ORCA ships, until a
 * session can be held away from host services until its runtime is admitted (#704): every
 * entry point that starts agent work refuses such an agent before anything starts, the
 * session factory, `openAcpSession` itself, and remote delegation. Only the hook's own test
 * suites turn it on, through the session factory's `activation`, which no config reaches.
 */
export function nativeToolHookUnavailable(agent: {
  id: string;
  nativeToolHook?: "on" | "off" | undefined;
}): OrcaError | undefined {
  if (agent.nativeToolHook !== "on") return undefined;
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agent.id} has nativeToolHook: on, but ORCA's native tool hook is not available in this build yet (#704). ` +
      `ORCA refuses the session rather than run it unguarded; remove nativeToolHook: on to run it without the hook.`,
    { agentId: agent.id },
  );
}

/** The names the Claude ACP adapter reports in `initialize`'s `agentInfo`. */
export const CLAUDE_ADAPTER_NAMES: readonly string[] = [
  "@agentclientprotocol/claude-agent-acp",
  "@zed-industries/claude-code-acp",
];

/**
 * The adapter and Claude Code pairs whose installed hook behaviour `claude-hook-acceptance.yml`
 * observes, each one installed and run there: the adapter version `initialize` reports, the
 * Claude Code version it runs, and the SHA-256 of that Claude Code's executable image for each
 * `<platform>-<arch>` the acceptance run covers. ORCA hashes the image the session's runtime
 * process actually runs and accepts only the pinned digest of the adapter's pair; the
 * adapter's own report says nothing about the runtime (an environment variable can point it
 * at another Claude Code). Adding a pair or an image is a reviewed change to both.
 */
export const CLAUDE_HOOK_VERIFIED_PAIRS: readonly {
  adapter: string;
  runtime: string;
  images: Readonly<Record<string, string>>;
}[] = [
  {
    adapter: "0.109.1",
    runtime: "2.1.330",
    // @anthropic-ai/claude-agent-sdk-linux-x64@0.3.330, `claude`.
    images: { "linux-x64": "f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb" },
  },
];

/** The adapter versions in `CLAUDE_HOOK_VERIFIED_PAIRS`. */
export const CLAUDE_HOOK_VERIFIED_ADAPTERS: readonly string[] = CLAUDE_HOOK_VERIFIED_PAIRS.map((p) => p.adapter);

/** The platforms (`process.platform`) that workflow runs the acceptance test on. */
export const CLAUDE_HOOK_VERIFIED_PLATFORMS: readonly NodeJS.Platform[] = ["linux"];

/**
 * Where the hook program is, as built: `bin/claude-pre-tool-hook.js` beside this module in
 * the package's `dist`, or `claude-pre-tool-hook.mjs` beside the bundled daemon
 * (`packages/app/scripts/build-daemon.js`). Undefined when neither exists, which is the case
 * when this runs from source.
 */
export function claudePreToolHookScript(): string | undefined {
  for (const rel of ["./bin/claude-pre-tool-hook.js", "./claude-pre-tool-hook.mjs"]) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** The name the Codex ACP adapter reports in `initialize`'s `agentInfo`. */
export const CODEX_ADAPTER_NAMES: readonly string[] = ["@agentclientprotocol/codex-acp"];

/**
 * The Codex adapter and Codex pairs `codex-hook-acceptance.yml` installs and runs: the adapter
 * version `initialize` reports, the Codex version it runs, and the SHA-256 of that Codex's
 * executable image for each `<platform>-<arch>` the acceptance run covers. ORCA hashes the
 * image the Codex process the adapter started actually runs and accepts only the pinned
 * digest; `CODEX_PATH` can point the adapter at another Codex, and nothing Codex says about
 * itself is taken as evidence. Adding a pair or an image is a reviewed change to both.
 */
export const CODEX_HOOK_VERIFIED_PAIRS: readonly {
  adapter: string;
  runtime: string;
  images: Readonly<Record<string, string>>;
}[] = [
  {
    adapter: "2.9.0",
    runtime: "0.171.0",
    // @openai/codex-linux-x64@0.171.0, vendor/x86_64-unknown-linux-musl/bin/codex.
    images: { "linux-x64": "b76a027d6b210f9a8da7aaf321dd235c700f0ef7a794d4a5314b9af6c134f0f0" },
  },
];

/** The adapter versions in `CODEX_HOOK_VERIFIED_PAIRS`. */
export const CODEX_HOOK_VERIFIED_ADAPTERS: readonly string[] = CODEX_HOOK_VERIFIED_PAIRS.map((p) => p.adapter);

/**
 * The Codex process the adapter (process `agentPid`) actually runs: its descendant started
 * with `app-server` that has no such descendant of its own (the native binary, under the Node
 * wrapper when the adapter uses its bundled Codex). Only the pid is found here; the image it
 * runs is attested by `processImageDigest`, which is ORCA's own evidence. Linux only, which is
 * the only platform the hook is installed on.
 */
export async function codexRuntimeProcess(agentPid: number | undefined): Promise<{ pid: number } | { error: string }> {
  if (agentPid === undefined) return { error: "the agent's process id is unknown" };
  const table = await processTable();
  const below = (pid: number, root: number): boolean => {
    for (let p = table.get(pid)?.ppid, hops = 0; p !== undefined && hops < 64; p = table.get(p)?.ppid, hops++)
      if (p === root) return true;
    return false;
  };
  const servers = [...table.entries()]
    .filter(([pid, p]) => p.argv.includes("app-server") && below(pid, agentPid))
    .map(([pid]) => pid);
  const leaves = servers.filter((pid) => !servers.some((other) => other !== pid && below(other, pid)));
  if (leaves.length !== 1)
    return {
      error:
        leaves.length === 0
          ? "no Codex app-server runs under the adapter"
          : "several Codex app-servers run under the adapter",
    };
  return { pid: leaves[0]! };
}

/** The platforms that workflow runs on. */
export const CODEX_HOOK_VERIFIED_PLATFORMS: readonly NodeJS.Platform[] = ["linux"];

/** Codex's own timeout for the hook, in seconds; a hook that runs out lets the call through. */
export const CODEX_PRE_TOOL_TIMEOUT_SECONDS = 30;

/** One word for a POSIX shell, quoted so nothing in it is interpreted. */
const shellWord = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The command line Codex runs (through `$SHELL -lc`) for the hook. */
export function codexPreToolHookCommand(runtime: string, script: string, contextFile: string): string {
  return [runtime, script, "--codex", contextFile].map(shellWord).join(" ");
}

/** Sorted keys, as `serde_json`'s `sort_all_objects` leaves them. */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

/**
 * The hash Codex 0.171 trusts a `PreToolUse` command hook by (`hook_hash` in
 * `codex-rs/hooks/src/engine/discovery.rs`, `version_for_toml` in `codex-rs/config`): SHA-256
 * of the hook's normalized identity as JSON with sorted keys. ORCA checks after `initialize`
 * that Codex agrees, so a Codex that hashes differently is refused, not trusted blindly.
 */
export function codexHookTrustHash(command: string, timeoutSeconds: number): string {
  const identity = {
    event_name: "pre_tool_use",
    matcher: "*",
    hooks: [{ type: "command", command, timeout: timeoutSeconds, async: false }],
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortKeys(identity)))
    .digest("hex")}`;
}

/** The key Codex lists a session-flag hook under: its source, event, group and handler. */
export const CODEX_HOOK_KEY = "/<session-flags>/config.toml:pre_tool_use:0:0";

/**
 * `CODEX_CONFIG` with ORCA's hook in it, trusted, beside whatever the agent's own
 * `CODEX_CONFIG` set, and Codex's hosted web search turned off (it runs at the model
 * provider, so no hook sees it). Undefined when the agent's own already sets hooks: ORCA's
 * would not be the one Codex lists first, and ORCA does not reorder somebody else's.
 */
export function codexHookConfig(base: string | undefined, command: string): string | undefined {
  let config: Record<string, unknown> = {};
  if (base !== undefined && base !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(base);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || "hooks" in parsed) return undefined;
    config = parsed as Record<string, unknown>;
  }
  return JSON.stringify({
    ...config,
    // Codex's web search runs at the model provider, where no hook sees it, so it is off.
    web_search: "disabled",
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: CODEX_PRE_TOOL_TIMEOUT_SECONDS }] }],
      state: { [CODEX_HOOK_KEY]: { trusted_hash: codexHookTrustHash(command, CODEX_PRE_TOOL_TIMEOUT_SECONDS) } },
    },
  });
}

/** What the Codex adapter's `_codex/hooks/list` says about one hook (the fields ORCA reads). */
interface CodexListedHook {
  key?: unknown;
  eventName?: unknown;
  command?: unknown;
  matcher?: unknown;
  enabled?: unknown;
  trustStatus?: unknown;
  currentHash?: unknown;
}

/** Why Codex's list does not show ORCA's hook in force, or undefined when it does. */
export function codexHookListProblem(listed: unknown, command: string): string | undefined {
  const hooks = (listed as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooks)) return "the adapter did not list its hooks";
  const ours = (hooks as CodexListedHook[]).filter((h) => h.key === CODEX_HOOK_KEY);
  if (ours.length !== 1) return "Codex does not list ORCA's hook";
  const h = ours[0]!;
  if (h.eventName !== "preToolUse" || h.command !== command || h.matcher !== "*")
    return "Codex lists a different hook where ORCA's should be";
  if (h.enabled !== true) return "Codex lists ORCA's hook as turned off";
  if (h.trustStatus !== "trusted")
    return `Codex does not trust ORCA's hook (it reports ${String(h.trustStatus)}, hash ${String(h.currentHash)})`;
  return undefined;
}

/** The most stderr the probe reads; a hook that says more than this has not answered it. */
const PROBE_STDERR_LIMIT = 16 * 1024;

/**
 * Run the hook's command line the way Codex does (`$SHELL -lc`, in the session's directory)
 * on a call that ORCA's own protected paths must block, and say whether ORCA's hook blocked
 * it. An exit status alone is not taken as proof: a profile, an alias or another program on
 * the shell's path can exit 2 too. The probe's frame carries a fresh nonce, and the session
 * counts as guarded only if the command exits 2 and its stderr, read up to a fixed bound
 * within the hook's timeout, carries the receipt line the hook signs with the context's
 * `probeKey` for that nonce (`codexProbeReceipt`). A matching receipt proves that whatever
 * the command ran could read this session's context file and answered this very call with a
 * block in ORCA's format, which is what ORCA's hook does. It is not proof of which program
 * that was: another process under the same OS account could read the file too. What it rules
 * out is a shell, profile or program that exits 2 without having made ORCA's decision. A
 * shell or runtime that cannot run the hook fails here instead of letting calls through.
 *
 * The deadline bounds the caller, not only the shell: when it passes, the probe settles as a
 * refusal at once, kills the command's whole process group and closes its streams, so a
 * descendant still holding a descriptor cannot keep the session's startup waiting.
 */
export function probeCodexHook(opts: {
  command: string;
  cwd: string;
  contextFile: string;
  /** The `probeKey` written into the context file the command names. */
  probeKey: string;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
}): Promise<{ blocked: boolean; detail: string }> {
  const env = opts.env ?? process.env;
  const shell = env["SHELL"] || "/bin/sh";
  const nonce = randomBytes(16).toString("hex");
  const toolUseId = `orca-hook-probe:${nonce}`;
  if (!CODEX_PROBE_TOOL_USE_ID.test(toolUseId)) throw new Error("probe id does not match the hook's pattern");
  const frame = JSON.stringify({
    session_id: "orca-hook-probe",
    hook_event_name: "PreToolUse",
    tool_name: "view_image",
    // The context file sits under ORCA's private store, which no rule opens to an agent.
    tool_input: { path: opts.contextFile },
    tool_use_id: toolUseId,
    cwd: opts.cwd,
  });
  const expected = Buffer.from(codexProbeReceipt(opts.probeKey, nonce), "utf8");
  const receipted = (stderr: string): boolean =>
    stderr.split("\n").some((line) => {
      const got = Buffer.from(line, "utf8");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    const child = spawn(shell, ["-lc", opts.command], {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "ignore", "pipe"],
      // Its own process group, so everything the command starts can be stopped with it.
      detached: true,
    });
    const stop = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stderr.destroy();
    };
    const settle = (result: { blocked: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(result);
    };
    const timeoutMs = opts.timeoutMs ?? CODEX_PRE_TOOL_TIMEOUT_SECONDS * 1000;
    const timer = setTimeout(
      () => settle({ blocked: false, detail: `the hook did not answer within ${timeoutMs} ms` }),
      timeoutMs,
    );
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (Buffer.byteLength(stderr, "utf8") > PROBE_STDERR_LIMIT)
        settle({ blocked: false, detail: "the hook wrote more than the probe reads" });
    });
    child.stderr.on("error", () => undefined);
    child.on("error", (e) => settle({ blocked: false, detail: e.message }));
    child.on("close", (code, signal) => {
      const said = stderr.trim().slice(0, 300);
      if (signal) settle({ blocked: false, detail: `killed by ${signal}` });
      else if (code !== 2) settle({ blocked: false, detail: `exit ${code}: ${said}` });
      else if (!receipted(stderr))
        settle({ blocked: false, detail: `exit 2 without ORCA's hook's receipt for this call: ${said}` });
      else settle({ blocked: true, detail: "blocked, with the hook's receipt" });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(frame);
  });
}

/* ------------------------------------ both ------------------------------------ */

export interface NativeToolHookSessionOptions {
  agentId: string;
  permissions: ConfiguredPermissionPolicy;
  permissionFiles: readonly string[];
  workspaceCwd: string;
  additionalDirectories?: readonly string[] | undefined;
  protectedPaths?: ProtectedPaths | undefined;
  /** A directory only ORCA uses, protected from agents; the context file is written here. */
  contextDir: string;
  /** The runtime and the hook program, both absolute. No program: the session is refused. */
  runtime: string;
  script: string | undefined;
  /** The platform and architecture the agent runs on; `process`'s unless a test says otherwise. */
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  /** How a process's image is attested; `processImageDigest` unless a test says otherwise. */
  imageDigest?:
    ((pid: number, agentPid: number | undefined) => Promise<{ sha256: string } | { error: string }>) | undefined;
  /** How the Codex process an adapter runs is found; `codexRuntimeProcess` unless a test says otherwise. */
  codexProcess?: ((agentPid: number | undefined) => Promise<{ pid: number } | { error: string }>) | undefined;
  /**
   * The environment the agent is spawned with (the daemon's, then the agent's own), which
   * the Codex hook's `CODEX_CONFIG` builds on and its probe runs in.
   */
  agentEnv: NodeJS.ProcessEnv;
  /**
   * Whether the hook records each call it answers (#1000): `keep` makes a telemetry spool
   * beside the context file and gives the hook its path. Off unless the agent keeps it.
   */
  toolCallTelemetry?: "off" | "keep" | undefined;
}

export type NativeToolHookStatus = "pending" | "claude" | "claude-verified" | "codex";

/** A process's parent and start time, from `/proc/<pid>/stat` (Linux). */
async function procStat(pid: number): Promise<{ ppid: number; start: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After the name: state, ppid, ...; starttime is field 22 overall, 20 here.
    return { ppid: Number(fields[1]), start: fields[19]! };
  } catch {
    return undefined;
  }
}

/** Reads `/proc` (Linux): each process's parent and argument list. */
async function processTable(): Promise<Map<number, { ppid: number; argv: string[] }>> {
  const table = new Map<number, { ppid: number; argv: string[] }>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const argv = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0").filter((a) => a !== "");
      table.set(Number(name), { ppid, argv });
    } catch {
      // Gone, or not ours to read.
    }
  }
  return table;
}

/**
 * ORCA's own evidence for the image a process runs (Linux): the process must be a live
 * descendant of `agentPid`, the agent process ORCA started, and the same process (same start
 * time) before and after its image is read; the digest is of `/proc/<pid>/exe`, which opens
 * the file the kernel is running for it, wherever that is now and whatever is at its old
 * path. Nothing is executed.
 */
export async function processImageDigest(
  pid: number,
  agentPid: number | undefined,
): Promise<{ sha256: string } | { error: string }> {
  if (agentPid === undefined) return { error: "the agent's process id is unknown" };
  if (!Number.isInteger(pid) || pid <= 1 || pid === agentPid) return { error: `process ${pid} is not the runtime` };
  const lineage = async (): Promise<string | undefined> => {
    const self = await procStat(pid);
    if (!self) return undefined;
    for (let p = self.ppid, hops = 0; p > 1 && hops < 64; hops++) {
      if (p === agentPid) return self.start;
      const up = await procStat(p);
      if (!up) return undefined;
      p = up.ppid;
    }
    return undefined;
  };
  const before = await lineage();
  if (before === undefined) return { error: `process ${pid} is not running under the agent ORCA started` };
  let sha256: string;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(`/proc/${pid}/exe`)) hash.update(chunk as Buffer);
    sha256 = hash.digest("hex");
  } catch (error) {
    return { error: `its image cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if ((await lineage()) !== before) return { error: `process ${pid} changed while its image was read` };
  return { sha256 };
}

export interface NativeToolHookSession {
  /** Write the context file and build the agent's extra environment. Call once, before spawning. */
  prepare: () => Promise<{ env: Record<string, string> }>;
  /** For `OpenSessionOptions.sessionMeta`. Throws (refusing the session) unless the hook is in force. */
  sessionMeta: (
    agentInfo: { name: string; version: string } | undefined,
    ext: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    agentPid: number | undefined,
  ) => Promise<Record<string, unknown> | undefined>;
  /** Which agent took the hook, and whether its runtime has been attested. */
  status: () => NativeToolHookStatus;
  /**
   * Check, once the session has started and before it is given work, that the runtime it runs
   * is the image pinned for the adapter's version. Claude only: Codex's runtime is attested in
   * `sessionMeta`, before the session is created, so this does nothing there. Throws (refusing
   * the session) when the runtime did not report itself, is not under the agent ORCA started,
   * or runs another image.
   */
  verifyRuntime: () => Promise<void>;
  /**
   * The session's telemetry spool (#1000), once `prepare` has made one: only with
   * `toolCallTelemetry: keep`. The session factory hands it to the session as `hookTelemetry`.
   */
  telemetry: () => HookTelemetrySpool | undefined;
  /**
   * Remove the context file and the runtime record, if written, after the telemetry spool's
   * last drain. Safe to call more than once.
   */
  cleanup: () => Promise<void>;
}

/** The hook, ready to be installed in one opted-in session. */
export function nativeToolHookSession(opts: NativeToolHookSessionOptions): NativeToolHookSession {
  let status: NativeToolHookStatus = "pending";
  let file: string | undefined;
  let adapterVersion: string | undefined;
  let agentProcess: number | undefined;
  let codexCommand: string | undefined;
  /** The key the hook signs its probe receipt with; written into the context file only. */
  let probeKey: string | undefined;
  let codexEnv: string | undefined;
  let spool: HookTelemetrySpool | undefined;
  /** The pinned image for one adapter version, and the digest of what a process really runs. */
  const attest = async (
    pairs: readonly { adapter: string; runtime: string; images: Readonly<Record<string, string>> }[],
    adapter: string,
    pid: number,
    agent: string,
  ) => {
    const pair = pairs.find((p) => p.adapter === adapter);
    const pinned = pair?.images[target()];
    if (!pair || pinned === undefined)
      throw refuse(`ORCA has no verified ${agent} image for adapter ${adapter} on ${target()}`);
    const image = await (opts.imageDigest ?? processImageDigest)(pid, agentProcess);
    if ("error" in image) throw refuse(`ORCA could not attest the ${agent} the session runs (${image.error})`, { pid });
    if (image.sha256 !== pinned)
      throw refuse(
        `the ${agent} the session runs is not the one ORCA verified with adapter ${adapter} (${agent} ${pair.runtime}, image ${pinned.slice(0, 12)}…, not ${image.sha256.slice(0, 12)}…)`,
        { adapter, image: image.sha256, pinned },
      );
  };
  const target = () => `${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`;
  const refuse = (why: string, details: Record<string, unknown> = {}) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `agent ${opts.agentId} has nativeToolHook: on, but ${why}, so ORCA cannot check its tool calls. ` +
        `ORCA refuses the session rather than run it unguarded; remove nativeToolHook: on to run it without the hook.`,
      { agentId: opts.agentId, ...details },
    );
  const verified = (
    agentInfo: { name: string; version: string },
    versions: readonly string[],
    platforms: readonly NodeJS.Platform[],
    platform: NodeJS.Platform,
  ) => {
    if (!versions.includes(agentInfo.version))
      throw refuse(
        `it runs ${agentInfo.name} ${agentInfo.version}, and ORCA has verified the hook only with ${versions.join(", ")}`,
        { adapter: agentInfo.name, version: agentInfo.version, verified: [...versions] },
      );
    if (!platforms.includes(platform))
      throw refuse(
        `ORCA has verified the hook with ${agentInfo.name} only on ${platforms.join(", ")}, not ${platform}`,
        {
          platform,
        },
      );
  };
  return {
    status: () => status,
    telemetry: () => spool,
    cleanup: async () => {
      // The hook writes nothing once the agent is gone; the last lines are read before the
      // context goes. `finish` never throws and is idempotent.
      if (spool !== undefined) await spool.finish();
      if (file === undefined) return;
      const f = file;
      file = undefined;
      await rm(f, { force: true });
      await rm(claudeRuntimeAttestationFile(f), { force: true });
    },
    verifyRuntime: async () => {
      if (status === "codex") return;
      if (status !== "claude" || file === undefined || adapterVersion === undefined)
        throw refuse("the hook was not installed in the session");
      let attestation: Partial<ClaudeRuntimeAttestation>;
      try {
        attestation = JSON.parse(
          await readFile(claudeRuntimeAttestationFile(file), "utf8"),
        ) as Partial<ClaudeRuntimeAttestation>;
      } catch {
        throw refuse("the Claude Code runtime did not report itself when the session started");
      }
      if (attestation.version !== 1 || typeof attestation.pid !== "number")
        throw refuse("the Claude Code runtime's report is unreadable");
      await attest(CLAUDE_HOOK_VERIFIED_PAIRS, adapterVersion, attestation.pid, "Claude Code");
      status = "claude-verified";
    },
    prepare: async () => {
      if (opts.script === undefined) throw refuse("ORCA's hook program is missing from this build");
      probeKey = randomBytes(32).toString("hex");
      const context: ClaudeHookContext = {
        version: 1,
        agentId: opts.agentId,
        permissions: opts.permissions,
        permissionFiles: [...opts.permissionFiles],
        workspaceCwd: opts.workspaceCwd,
        ...(opts.additionalDirectories?.length ? { additionalDirectories: [...opts.additionalDirectories] } : {}),
        // The hook program is read-only to the agent's native tools too, beside ORCA's own files.
        protectedPaths: {
          readOnly: [...(opts.protectedPaths?.readOnly ?? []), opts.script],
          noAccess: [...(opts.protectedPaths?.noAccess ?? [])],
          ...(opts.protectedPaths?.agentAreas ? { agentAreas: [...opts.protectedPaths.agentAreas] } : {}),
        },
        // Signs the hook's receipt for the startup probe of a Codex session.
        probeKey,
      };
      await mkdir(opts.contextDir, { recursive: true, mode: 0o700 });
      if (opts.toolCallTelemetry === "keep") {
        // Beside the context, in ORCA's agent-denied directory; refused (and the session with
        // it) when that directory is not one.
        spool = await openHookTelemetrySpool({
          dir: opts.contextDir,
          protectedPaths: { readOnly: [], noAccess: [...(opts.protectedPaths?.noAccess ?? [])] },
        });
        context.telemetry = spool.target;
      }
      file = join(opts.contextDir, `${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(context), { encoding: "utf8", mode: 0o600, flag: "wx" });
      codexCommand = codexPreToolHookCommand(opts.runtime, opts.script, file);
      codexEnv = codexHookConfig(opts.agentEnv["CODEX_CONFIG"], codexCommand);
      return { env: codexEnv === undefined ? {} : { CODEX_CONFIG: codexEnv } };
    },
    sessionMeta: async (agentInfo, ext, agentPid) => {
      if (file === undefined || opts.script === undefined || codexCommand === undefined || probeKey === undefined)
        throw refuse("the hook was not prepared before the agent started");
      const key = probeKey;
      if (!agentInfo) throw refuse("the agent did not say at initialize which adapter it is");
      agentProcess = agentPid;
      const platform = opts.platform ?? process.platform;

      if (CLAUDE_ADAPTER_NAMES.includes(agentInfo.name)) {
        verified(agentInfo, CLAUDE_HOOK_VERIFIED_ADAPTERS, CLAUDE_HOOK_VERIFIED_PLATFORMS, platform);
        // The image is pinned per architecture; one the acceptance run does not cover is refused.
        if (CLAUDE_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === agentInfo.version)?.images[target()] === undefined)
          throw refuse(`ORCA has no verified Claude Code image for ${target()}`, { platform: target() });
        status = "claude";
        adapterVersion = agentInfo.version;
        return {
          claudeCode: {
            options: {
              settings: claudePreToolHookSettings({
                command: opts.runtime,
                args: [opts.script, file],
                attestArgs: [opts.script, "--attest", file],
                timeoutSeconds: CLAUDE_PRE_TOOL_TIMEOUT_SECONDS,
              }),
            },
          },
        };
      }

      if (CODEX_ADAPTER_NAMES.includes(agentInfo.name)) {
        verified(agentInfo, CODEX_HOOK_VERIFIED_ADAPTERS, CODEX_HOOK_VERIFIED_PLATFORMS, platform);
        if (CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === agentInfo.version)?.images[target()] === undefined)
          throw refuse(`ORCA has no verified Codex image for ${target()}`, { platform: target() });
        if (codexEnv === undefined)
          throw refuse(
            "the agent's own CODEX_CONFIG already sets hooks, or is not a JSON object, so ORCA cannot add its own",
          );
        let listed: unknown;
        try {
          listed = await ext("_codex/hooks/list", { cwd: opts.workspaceCwd });
        } catch (error) {
          throw refuse(
            `the adapter could not list its hooks (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        const problem = codexHookListProblem(listed, codexCommand);
        if (problem !== undefined) throw refuse(problem);
        // The adapter has started Codex by now (it answered from it); attest that process.
        const found = await (opts.codexProcess ?? codexRuntimeProcess)(agentPid);
        if ("error" in found) throw refuse(`ORCA could not tell which Codex the adapter runs (${found.error})`);
        await attest(CODEX_HOOK_VERIFIED_PAIRS, agentInfo.version, found.pid, "Codex");
        const probe = await probeCodexHook({
          command: codexCommand,
          cwd: opts.workspaceCwd,
          contextFile: file,
          probeKey: key,
          env: { ...opts.agentEnv, CODEX_CONFIG: codexEnv },
        });
        if (!probe.blocked)
          throw refuse(`the hook did not block a call it must block when run as Codex runs it (${probe.detail})`);
        status = "codex";
        adapterVersion = agentInfo.version;
        return undefined;
      }

      throw refuse(`it runs ${agentInfo.name}, which does not take ORCA's hook`, { adapter: agentInfo.name });
    },
  };
}
