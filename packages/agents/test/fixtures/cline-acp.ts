/**
 * Offline Cline CLI ACP fixtures (#711).
 *
 * Nothing here starts a process. `ScriptedClinePeer` is two in-memory pipes that speak
 * newline-delimited JSON-RPC to ORCA's real `openAcpSession`, through a `LocalHost` whose
 * `spawnAgent` is replaced. The wire values follow Cline CLI 3.0.75's ACP server as read in its
 * source (`apps/cli/src/acp/` at the pinned commit): the `initialize` reply, the four session
 * options, the three permission options and the permission request shape (`title` as
 * `tool: summary`, `rawInput` as the tool's input, no `locations`). They say what ORCA does
 * with such messages; what the installed Cline does is the acceptance suite's job.
 */
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { LocalHost, stdioAcpStream, type ProcessExit } from "@orca/agents";

export const CLINE_VERSION = "3.0.75";
export const CLINE_SESSION_ID = "cline-fixture-session-1";

/** `AcpAgent.initialize` in 3.0.75. */
export const CLINE_INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: false },
  },
  agentInfo: { name: "cline", version: CLINE_VERSION },
  authMethods: [
    { id: "cline", name: "Sign in with Cline" },
    { id: "cline-pass", name: "Sign in with ClinePass" },
    { id: "openai-codex", name: "Sign in with ChatGPT Subscription" },
  ],
};

/** `buildConfigOptions` in 3.0.75, for a key-configured OpenAI-compatible provider. */
export function clineConfigOptions(autoApprove: boolean) {
  return [
    {
      type: "select",
      id: "provider",
      name: "Provider",
      category: "_provider",
      currentValue: "openai-compatible",
      options: [{ value: "cline", name: "Cline" }],
    },
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "stand-in",
      options: [{ value: "stand-in", name: "stand-in" }],
    },
    {
      type: "select",
      id: "mode",
      name: "Session Mode",
      category: "mode",
      currentValue: "act",
      options: [
        { value: "plan", name: "Plan" },
        { value: "act", name: "Act" },
      ],
    },
    { type: "boolean", id: "auto_approve", name: "Auto-approve tools", currentValue: autoApprove },
  ];
}

/** `PERMISSION_OPTIONS` in 3.0.75. */
export const CLINE_PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
] as const;

export interface WireMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Handler = (message: WireMessage, peer: ScriptedClinePeer) => void;

/** A Cline-shaped ACP agent with no process behind it. */
export class ScriptedClinePeer {
  readonly agentStdout = new PassThrough();
  readonly agentStdin = new PassThrough();
  readonly fromClient: WireMessage[] = [];
  private buffered = "";
  private nextId = 9000;
  private readonly handlers = new Map<string, Handler>();
  private readonly responses = new Map<number | string, (m: WireMessage) => void>();

  constructor(opts: { initialize?: object; autoApprove?: boolean } = {}) {
    this.handle("initialize", (m) => this.reply(m.id!, opts.initialize ?? CLINE_INITIALIZE_RESULT));
    this.handle("session/new", (m) =>
      this.reply(m.id!, { sessionId: CLINE_SESSION_ID, configOptions: clineConfigOptions(opts.autoApprove ?? false) }),
    );
    this.handle("session/set_config_option", (m) =>
      this.reply(m.id!, { configOptions: clineConfigOptions(m.params?.value === true) }),
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

  update(update: Record<string, unknown>): void {
    this.send({ method: "session/update", params: { sessionId: CLINE_SESSION_ID, update } });
  }

  request(method: string, params: Record<string, unknown>): Promise<WireMessage> {
    const id = this.nextId++;
    const answered = new Promise<WireMessage>((resolve) => this.responses.set(id, resolve));
    this.send({ id, method, params });
    return answered;
  }

  /** `requestAcpToolApproval`: the tool's name and input as Cline sends them, with no locations. */
  askTool(toolName: string, input: unknown, summary?: string, kind?: string) {
    return this.request("session/request_permission", {
      sessionId: CLINE_SESSION_ID,
      toolCall: {
        toolCallId: `call-${this.nextId}`,
        title: summary ? `${toolName}: ${summary}` : toolName,
        kind: kind ?? "other",
        status: "pending",
        rawInput: input,
      },
      options: CLINE_PERMISSION_OPTIONS,
    });
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
    if (message.method) this.handlers.get(message.method)?.(message, this);
  }
}

/** A local host whose `spawnAgent` hands ORCA the peer's pipes instead of a child process. */
export function scriptedClineHost(peer: ScriptedClinePeer) {
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

export const outcome = (m: WireMessage) => (m.result as { outcome: { outcome: string; optionId?: string } }).outcome;
