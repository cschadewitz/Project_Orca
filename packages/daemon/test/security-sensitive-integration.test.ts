/** Sensitive launch input protection through authenticated HTTP reads and live/replayed WebSocket feeds. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { builtinExecutors, completed, Orchestrator, PausingHumanInput } from "@orca/engine";
import { fileStores } from "@orca/store";
import {
  ControlModel,
  CredentialStore,
  OwnershipStore,
  orchestratorResolver,
  ReadModel,
  startDaemon,
} from "@orca/daemon";

const SECRET = "wire-sensitive-token-d798";
const NESTED = "wire-nested-token-a461";
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
  error?: unknown;
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
    const client = new SocketClient(socket);
    closers.push(async () => socket.close());
    return client;
  }
  async waitFor(test: (frame: Frame) => boolean): Promise<Frame> {
    for (;;) {
      const result = this.frames.find(test);
      if (result) return result;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  async call(method: string, params: unknown): Promise<Frame> {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ kind: "request", id, method, params }));
    return this.waitFor((frame) => frame.kind === "response" && frame.id === id);
  }
}

const expectPublic = (value: unknown) => {
  expect(JSON.stringify(value)).not.toContain(SECRET);
  expect(JSON.stringify(value)).not.toContain(NESTED);
};

describe("authenticated sensitive run boundaries", () => {
  it("never exposes resolved defaults, submitted values or echoes over HTTP or live/replayed sockets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-sensitive-http-"));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    const workflows = new WorkflowRegistry().register(
      parseWorkflow(`
id: sensitive
name: Sensitive
inputSchema:
  fields:
    token: { type: string, sensitive: true, default: ${SECRET} }
    configuration:
      type: object
      properties:
        nested: { type: string, sensitive: true }
      default: { nested: ${NESTED}, plain: visible }
start: probe
nodes:
  probe: { type: custom:echo }
  gate: { type: gate, question: Continue?, options: [continue, stop] }
  e: { type: end }
edges: [{ from: probe, to: gate }, { from: gate, to: e }]
`),
    );
    const stores = fileStores(dir);
    const executors = builtinExecutors();
    executors.register({
      type: "custom:echo",
      execute: async (ctx) => {
        expect(ctx.run.state.run.vars.token).toBe(SECRET);
        await ctx.emit({ type: "vars.set", payload: { vars: { copied: SECRET, nested: { [NESTED]: SECRET } } } });
        await ctx.emit({
          type: "agent.update",
          payload: {
            stepRunId: ctx.step.id,
            sessionId: "session",
            update: { kind: "agent_message_chunk", text: `${SECRET} ${NESTED}` },
          },
        });
        const artifact = {
          id: "private-copy-artifact",
          kind: "generic",
          name: `copy-${SECRET}`,
          version: 1,
          mediaType: "text/plain",
          size: SECRET.length,
          contentHash: "fixture-hash",
          path: `/output/${SECRET}.txt`,
          producedBy: { runId: ctx.run.id, stepRunId: ctx.step.id },
          parents: [],
          data: { [NESTED]: SECRET },
          createdAt: new Date().toISOString(),
        };
        await stores.artifacts.put(artifact, `${SECRET} ${NESTED}`);
        await ctx.emit({ type: "artifact.recorded", payload: { stepRunId: ctx.step.id, artifact } });
        return completed();
      },
    });
    const orchestrator = new Orchestrator({
      stores,
      workflows,
      executors,
      agents: new AgentRegistry(),
      templates: new TemplateRegistry(),
      humanInput: new PausingHumanInput(),
      workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: dir }) },
    });
    const reads = new ReadModel({ orchestrator });
    const credentials = new CredentialStore();
    const token = (await credentials.issue({ principal: "sensitive-test", preset: "owner" })).token;
    const daemon = await startDaemon({
      orcaVersion: "integration",
      reads,
      control: new ControlModel({ orchestrator, reads }),
      source: orchestrator,
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
    const started = await rpc("runs.start", { workflowId: "sensitive", vars: { token: SECRET } });
    expect(started.ok).toBe(true);
    const runId = started.result!.runId as string;
    await orchestrator.run(runId);
    await live.waitFor((frame) => frame.method === "run.changed" && frame.params?.status === "blocked");
    await live.waitFor((frame) => frame.method === "agent.update");
    expect(
      live.frames.some((frame) => frame.method === "event.appended" && JSON.stringify(frame).includes("run.created")),
    ).toBe(true);
    const view = await rpc("runs.get", { runId });
    const events = await rpc("runs.events", { runId });
    const workflow = await rpc("workflows.get", { id: "sensitive" });
    const artifactList = await rpc("artifacts.list", { runId });
    const artifactBody = await rpc("artifacts.get", { artifactId: "private-copy-artifact" });
    expect(await stores.artifacts.content("private-copy-artifact")).toContain(SECRET);
    for (const reply of [view, events, workflow, artifactList, artifactBody]) {
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      expectPublic(reply);
    }
    expectPublic(live.frames);
    const replay = await SocketClient.open(daemon.socketUrl!, token);
    const subscription = await replay.call("subscribe", { runId, since: 0 });
    expect(subscription.ok).toBe(true);
    expect(subscription.result?.replayed).toBeGreaterThan(0);
    await replay.waitFor((frame) => frame.method === "agent.update");
    expectPublic(replay.frames);
    expectPublic(await readFile(join(dir, "runs", `${runId}.jsonl`), "utf8"));
  });
});
