/**
 * Offline GitHub Copilot CLI ACP fixtures (#709).
 *
 * Nothing here starts a process. `ScriptedCopilotPeer` is two in-memory pipes that speak
 * newline-delimited JSON-RPC to ORCA's real `openAcpSession`, through a `LocalHost` whose
 * `spawnAgent` is replaced. Every wire value that stands in for Copilot is labelled in
 * `FIXTURE_PROVENANCE`: registry-probed values come from the pinned ACP registry protocol
 * matrix, documented ones from the pinned vendor docs or changelog, and everything else is
 * synthetic. Synthetic permission option IDs in particular are not Copilot's actual IDs —
 * those are unknown until an installed run observes them.
 *
 * `copilotProfileFindings` is a test-only preflight over an `AgentSpec`. It is not wired into
 * the CLI, daemon or app, so production registration and defaults are unchanged.
 */
import { isAbsolute } from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { literalEnv, type AgentSpec } from "@orca/core";
import { LocalHost, stdioAcpStream, type ProcessExit } from "@orca/agents";

export const COPILOT_VERSION = "1.0.103";
export const COPILOT_SESSION_ID = "copilot-fixture-session-1";

/** Where each scripted value comes from; see docs/preparation/copilot-cli-acp-709/source-pins.json. */
export const FIXTURE_PROVENANCE = {
  "initialize.protocolVersion": "registry-probed",
  "initialize.agentInfo.version": "registry-probed",
  "initialize.agentInfo.name": "synthetic",
  "initialize.agentCapabilities.loadSession": "registry-probed",
  "initialize.agentCapabilities.sessionCapabilities.list": "registry-probed",
  "initialize.authMethods[].type": "registry-probed",
  "initialize.authMethods[].id/name/args": "synthetic",
  "session/new unauthenticated -32000": "registry-probed",
  "session/new configOptions allow_all": "documented name (changelog 1.0.39, 1.0.60); id, shape and value synthetic",
  "session/update variants": "documented kinds (acp-server.md, changelog); payloads synthetic",
  "permission options": "synthetic",
  "prompt errors": "synthetic",
} as const;

export const COPILOT_INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
  agentInfo: { name: "copilot-fixture", version: COPILOT_VERSION },
  authMethods: [{ id: "fixture-terminal-login", name: "Log in with Copilot CLI", type: "terminal", args: ["login"] }],
};

export const COPILOT_NEW_SESSION_RESULT = {
  sessionId: COPILOT_SESSION_ID,
  configOptions: [
    {
      id: "allow_all",
      name: "Allow all",
      type: "boolean",
      currentValue: false,
    },
  ],
};

/** Synthetic option set in the four ACP kinds; IDs are deliberately not Copilot-looking. */
export const SYNTHETIC_OPTIONS = [
  { optionId: "fixture-allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "fixture-allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "fixture-reject-once", name: "Reject", kind: "reject_once" },
] as const;

export interface WireMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Handler = (message: WireMessage, peer: ScriptedCopilotPeer) => void;

/** A Copilot-shaped ACP agent with no process behind it. */
export class ScriptedCopilotPeer {
  /** What ORCA reads: the agent's stdout. */
  readonly agentStdout = new PassThrough();
  /** What ORCA writes: the agent's stdin. */
  readonly agentStdin = new PassThrough();
  /** Every message ORCA sent, in order. */
  readonly fromClient: WireMessage[] = [];
  private buffered = "";
  private nextId = 9000;
  private readonly handlers = new Map<string, Handler>();
  private readonly responses = new Map<number | string, (m: WireMessage) => void>();
  private readonly waiters: { match: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void }[] = [];

  constructor(opts: { authenticated?: boolean } = {}) {
    this.handle("initialize", (m) => this.reply(m.id!, COPILOT_INITIALIZE_RESULT));
    this.handle("session/new", (m) =>
      opts.authenticated === false
        ? this.fail(m.id!, -32000, "Authentication required")
        : this.reply(m.id!, COPILOT_NEW_SESSION_RESULT),
    );
    this.agentStdin.on("data", (chunk: Buffer) => {
      this.buffered += chunk.toString("utf8");
      for (let nl = this.buffered.indexOf("\n"); nl >= 0; nl = this.buffered.indexOf("\n")) {
        const line = this.buffered.slice(0, nl);
        this.buffered = this.buffered.slice(nl + 1);
        if (line.trim() !== "") this.receive(JSON.parse(line) as WireMessage);
      }
    });
  }

  handle(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  send(message: Omit<WireMessage, "jsonrpc">): void {
    this.agentStdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  reply(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  fail(id: number | string, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  update(update: Record<string, unknown>, sessionId = COPILOT_SESSION_ID): void {
    this.notify("session/update", { sessionId, update });
  }

  /** An agent-to-client request; resolves with ORCA's response message. */
  request(method: string, params: Record<string, unknown>): Promise<WireMessage> {
    const id = this.nextId++;
    const answered = new Promise<WireMessage>((resolve) => this.responses.set(id, resolve));
    this.send({ id, method, params });
    return answered;
  }

  /** A permission ask in the current turn, with the synthetic options unless told otherwise. */
  askPermission(
    toolCall: Record<string, unknown>,
    options: readonly object[] = SYNTHETIC_OPTIONS,
    sessionId = COPILOT_SESSION_ID,
  ) {
    return this.request("session/request_permission", { sessionId, toolCall, options });
  }

  /** The first message ORCA sent with `method` at or after `from`, waiting for it if need be. */
  waitFor(method: string, from = 0): Promise<WireMessage> {
    const match = (m: WireMessage) => m.method === method;
    const seen = this.fromClient.slice(from).find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  sent(method: string): WireMessage[] {
    return this.fromClient.filter((m) => m.method === method);
  }

  private receive(message: WireMessage): void {
    this.fromClient.push(message);
    if (message.method === undefined && message.id !== undefined) {
      const resolve = this.responses.get(message.id);
      this.responses.delete(message.id);
      resolve?.(message);
      return;
    }
    for (const waiter of [...this.waiters])
      if (waiter.match(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    if (message.method) this.handlers.get(message.method)?.(message, this);
  }
}

/** A local host whose `spawnAgent` hands ORCA the peer's pipes instead of a child process. */
export function scriptedHost(peer: ScriptedCopilotPeer) {
  const host = new LocalHost({ id: "local", type: "local" });
  let exit!: (e: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    exit = resolve;
  });
  const kill = vi.fn((signal?: NodeJS.Signals) => {
    exit({ code: null, signal: signal ?? "SIGTERM" });
    peer.agentStdout.end();
  });
  const spawn = vi.spyOn(host, "spawnAgent").mockResolvedValue({
    stream: stdioAcpStream(peer.agentStdout, peer.agentStdin),
    pid: undefined,
    exited,
    stderrTail: () => "",
    kill,
  });
  return { host, spawn, kill, exited };
}

/* -------------------------------------------------------------------------- *
 * Test-only profile preflight
 * -------------------------------------------------------------------------- */

export const PLACEHOLDER = "/REPLACE-WITH-ABSOLUTE-PREFIX";

/** Launch options that grant, widen or bypass Copilot's own permission asks (cli-command-reference.md). */
const GRANTING_FLAGS = [
  "--allow-all",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-all-urls",
  "--yolo",
  "--allow-tool",
  "--allow-url",
  "--autopilot",
  "--no-sandbox",
  "--trust-folder",
];
const REQUIRED_ARGS = ["--acp", "--stdio", "--no-auto-update"];
const TOKEN_VARIABLES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_API_KEY_COMMAND",
];
/** COPILOT_ALLOW_ALL's documented falsey spellings; anything else, including absence, is unsafe. */
const FALSEY = new Set(["false", "0", "no", "off", "n", ""]);

const flagName = (arg: string) => arg.split("=", 1)[0]!;

/**
 * Problems with a Copilot ACP profile as ORCA's LocalHost would launch it: the agent's
 * `env` laid over `ambient` (the daemon's own environment), exactly as `spawnAgent` merges
 * them. An empty list is not a qualification; it only means none of these known hazards.
 */
export function copilotProfileFindings(spec: AgentSpec, ambient: Record<string, string | undefined> = {}): string[] {
  const findings: string[] = [];
  const env = { ...ambient, ...literalEnv(spec.env) };
  const placeholder = (value: string | undefined) => value?.includes(PLACEHOLDER) ?? false;

  if (placeholder(spec.command) || placeholder(env.COPILOT_HOME))
    findings.push("placeholder: replace the absolute prefix");
  if (!isAbsolute(spec.command)) findings.push("command: not an absolute path");
  if (!spec.command.split("/").includes(COPILOT_VERSION)) findings.push(`command: not a ${COPILOT_VERSION} directory`);
  if (/(^|\/)(npx|npm|pnpm|bunx)$/.test(spec.command)) findings.push("command: resolves the package at launch");
  if (spec.hostId !== "local") findings.push("host: only a local stdio child is prepared");

  const flags = spec.args.map(flagName);
  for (const required of REQUIRED_ARGS) if (!flags.includes(required)) findings.push(`args: missing ${required}`);
  if (flags.includes("--port")) findings.push("args: --port selects TCP; ORCA speaks stdio");
  for (const flag of GRANTING_FLAGS) if (flags.includes(flag)) findings.push(`args: ${flag} grants or widens approval`);
  const mode = spec.args.findIndex((a) => a === "--mode" || a.startsWith("--mode="));
  if (mode >= 0) {
    const value = spec.args[mode]!.includes("=") ? spec.args[mode]!.split("=")[1] : spec.args[mode + 1];
    if (value === "autopilot") findings.push("args: --mode autopilot continues without a person");
  }

  if (!FALSEY.has((env.COPILOT_ALLOW_ALL ?? "unset").trim().toLowerCase()))
    findings.push("env: COPILOT_ALLOW_ALL is not explicitly false");
  if (!FALSEY.has((env.COPILOT_PLAN_THEN_AUTOPILOT ?? "").trim().toLowerCase()))
    findings.push("env: COPILOT_PLAN_THEN_AUTOPILOT requests autopilot");
  if ((env.COPILOT_AUTO_UPDATE ?? "").toLowerCase() !== "false") findings.push("env: COPILOT_AUTO_UPDATE is not false");
  if (!env.COPILOT_HOME || !isAbsolute(env.COPILOT_HOME))
    findings.push("env: COPILOT_HOME is not an isolated absolute path");
  for (const name of TOKEN_VARIABLES) {
    if (spec.env[name] !== undefined) findings.push(`env: ${name} written into ORCA configuration`);
    else if (ambient[name]) findings.push(`env: ${name} inherited from the daemon overrides the chosen login`);
  }
  return findings;
}
