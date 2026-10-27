/**
 * Release canary audit (#363) over the authenticated wire: rendered prompt previews, launch
 * refusals and preflight never carry a sensitive value over HTTP or live/replayed sockets.
 * Every canary is synthetic. The fake agent is the authorized execution boundary.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { fileStores } from "@orca/store";
import {
  ControlModel,
  CredentialStore,
  orchestratorDefinitionResolver,
  orchestratorResolver,
  OwnershipStore,
  ReadModel,
  startDaemon,
  WorkflowInputsModel,
} from "@orca/daemon";

// Every third tail character is i/l/o/u: no ULID or hex digest can contain a window of it.
const TOKEN = "SYNTHETIC-CANARY-WIRETOKEN-c6uP1lW8oJ4iN7uZ";
const PEM = "SYNTHETIC-CANARY-WIREPEM-x9iR3oB6lF2uM5iQ";
const DEFAULT = "SYNTHETIC-CANARY-WIREDEFAULT-t2oK7uV4iC9lH1oS";
const CANARIES = [TOKEN, PEM, DEFAULT];

/** Any six-character window of a canary's tail, ignoring case, is a disclosure. */
function exposed(value: unknown): string[] {
  const text = JSON.stringify(value).toLowerCase();
  return CANARIES.flatMap((canary) => {
    const tail = canary.slice(canary.lastIndexOf("-") + 1).toLowerCase();
    return Array.from({ length: tail.length - 5 }, (_, i) => tail.slice(i, i + 6)).filter((w) => text.includes(w));
  });
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

type Frame = {
  kind: string;
  id?: number;
  ok?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
};

class SocketClient {
  readonly frames: Frame[] = [];
  private id = 0;
  private waiters: (() => void)[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.frames.push(JSON.parse(String(event.data)) as Frame);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }
  static async open(url: string, token: string): Promise<SocketClient> {
    const socket = new WebSocket(url, ["orca.v1", `orca.bearer.${token}`]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket open failed")), { once: true });
    });
    closers.push(async () => socket.close());
    return new SocketClient(socket);
  }
  async waitFor(test: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
      const found = this.frames.find(test);
      if (found) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  async call(method: string, params: unknown): Promise<Frame> {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ kind: "request", id, method, params }));
    return this.waitFor((frame) => frame.kind === "response" && frame.id === id);
  }
}

const completedEvent = (frame: Frame) =>
  frame.method === "event.appended" && (frame.params?.event as { type?: string } | undefined)?.type === "run.completed";

describe("authenticated wire", () => {
  it("serves withheld previews, value-free refusals and value-free preflight", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-wire-canary-"));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    const pad = "p".repeat(400 - TOKEN.lastIndexOf("-") - 1 - 10);
    const workflows = new WorkflowRegistry().register(
      parseWorkflow(`
id: wire
name: Wire
version: "1"
inputSchema:
  fields:
    token: { type: string, sensitive: true, pattern: "^SYNTHETIC-" }
    config:
      type: object
      sensitive: true
      additionalProperties: false
      properties:
        pem: { type: string }
    fallback: { type: string, sensitive: true, default: ${DEFAULT} }
start: s
nodes:
  s: { type: start }
  cut: { type: agent, agent: { role: builder }, prompt: "${pad}{{vars.token}}" }
  yaml: { type: agent, agent: { role: builder }, prompt: "Use {{vars.config}} or {{vars.fallback}}" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: cut }, { from: cut, to: yaml }, { from: yaml, to: e }]
`),
    );
    const prompts: string[] = [];
    const orchestrator = new Orchestrator({
      stores: fileStores(dir),
      workflows,
      agents: AgentRegistry.fromConfig(
        parseOrcaConfig({ agents: [{ id: "fake", command: "unused" }], roles: { builder: "fake" } }),
      ),
      templates: new TemplateRegistry(),
      humanInput: new PausingHumanInput(),
      workspaceProvider: new LocalWorkspaceProvider(dir),
      sessionFactory: async ({ host, agent, cwd }) => ({
        id: "fake",
        acpSessionId: "fake",
        agentId: agent.id,
        hostId: host.id,
        cwd,
        closed: Promise.resolve(),
        configOptions: [],
        setConfigOption: async () => [],
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => {},
        async prompt(input) {
          prompts.push(typeof input === "string" ? input : JSON.stringify(input));
          return { stopReason: "end_turn", durationMs: 0 };
        },
      }),
    });
    const reads = new ReadModel({ orchestrator });
    const credentials = new CredentialStore();
    const token = (await credentials.issue({ principal: "canary-test", preset: "owner" })).token;
    const daemon = await startDaemon({
      orcaVersion: "integration",
      reads,
      control: new ControlModel({ orchestrator, reads }),
      source: orchestrator,
      workflowInputs: new WorkflowInputsModel({ resolve: orchestratorDefinitionResolver(orchestrator) }),
      capabilities: ["runs.read", "runs.control", "runs.subscribe"],
      auth: {
        mode: "token",
        credentials,
        ownership: new OwnershipStore(),
        resolver: orchestratorResolver(orchestrator),
      },
    });
    closers.push(() => daemon.close());
    const rpc = async (method: string, params: unknown): Promise<Frame> => {
      const response = await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "request", id: 1, method, params }),
      });
      return (await response.json()) as Frame;
    };

    const live = await SocketClient.open(daemon.socketUrl!, token);
    expect((await live.call("subscribe", {})).ok).toBe(true);
    const started = await rpc("runs.start", {
      workflowId: "wire",
      vars: { token: TOKEN, config: { pem: `${PEM}\n${PEM}` } },
    });
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    const runId = started.result!.runId as string;
    expect((await orchestrator.run(runId)).run.status).toBe("completed");
    await live.waitFor(completedEvent);
    // The agent got exact values; every public reader gets a withheld preview.
    expect(prompts.join("\n")).toContain(TOKEN);
    expect(prompts.join("\n")).toContain(DEFAULT);
    const events = await rpc("runs.events", { runId });
    expect(events.ok).toBe(true);
    const previews = JSON.stringify(events).match(/"promptPreview":"[^"]*"/g);
    expect(previews).toEqual(['"promptPreview":"[REDACTED]"', '"promptPreview":"[REDACTED]"']);
    const replay = await SocketClient.open(daemon.socketUrl!, token);
    expect((await replay.call("subscribe", { runId, since: 0 })).ok).toBe(true);
    await replay.waitFor(completedEvent);

    // Malformed sensitive input is refused without values, patterns or keys.
    const refusals = await Promise.all(
      [
        { token: `x${TOKEN}` },
        { token: 7 },
        { token: TOKEN, config: { pem: TOKEN, [PEM]: DEFAULT } },
        { token: TOKEN, config: [PEM] },
      ].map((vars) => rpc("runs.start", { workflowId: "wire", vars })),
    );
    for (const refused of refusals) {
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("WORKFLOW_INPUT_INVALID");
      expect(JSON.stringify(refused)).not.toContain("^SYNTHETIC-");
    }
    const preflight = await rpc("workflows.validateInputs", {
      workflowId: "wire",
      vars: { token: PEM, config: { [TOKEN]: PEM } },
    });
    expect(preflight.ok, JSON.stringify(preflight.error)).toBe(true);
    expect(preflight.result).toMatchObject({ validation: { ok: false } });

    const replies = {
      started,
      events,
      view: await rpc("runs.get", { runId }),
      list: await rpc("runs.list", {}),
      workflow: await rpc("workflows.get", { id: "wire" }),
      refusals,
      preflight,
      live: live.frames,
      replay: replay.frames,
    };
    expect(exposed(replies)).toEqual([]);
    expect(exposed(await readFile(join(dir, "runs", `${runId}.jsonl`), "utf8"))).toEqual([]);
  });
});
