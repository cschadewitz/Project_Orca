/** Compiled production processes, disk stores and real transports; only workloads and credentials are synthetic. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, type TestContext } from "vitest";
import {
  OperatorMutationContracts,
  OperatorDiscoverySchema,
  OperatorBoundaryPageResultSchema,
  OperatorPreflightResultSchema,
  ResponseMessageSchema,
  RunsEventsResultSchema,
  ContinuationReceiptSchema,
  InputsListResultSchema,
  OPERATOR_MAX_RESULT_BYTES,
  type OperatorMutationName,
  type OperatorMutationParams,
  type OperatorMutationResult,
  type OperatorTarget,
  type OperatorCollection,
  type ResponseMessage,
} from "@orca/protocol";
import type { IssueOptions } from "../../daemon/src/auth/credentials.js";
import { continuationDiagnostics } from "./continuation-diagnostics.js";
import { transportObserverSource } from "./mcp-replay-diagnostics.js";

export const aliases = {
  "operator.submitRequest": "submit_request",
  "operator.admitRun": "start_workflow",
  "operator.admission": "get_admission",
  "operator.reconcileAdmission": "reconcile_admission",
  "operator.cancel": "cancel_run",
  "operator.answer": "respond_to_approval",
  "operator.continueRun": "continue_run",
  "operator.continuation": "get_continuation",
  "operator.reconcileContinuation": "reconcile_continuation",
  "operator.revise": "revise_input",
} as const satisfies Record<OperatorMutationName, string>;
export const transports = ["stdio", "http"] as const;
export type Transport = (typeof transports)[number];
export const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "packages/cli/dist/main.js");
const moduleUrl = (path: string) => pathToFileURL(join(root, path)).href;

/** Deliberately excludes ambient ORCA endpoints, tokens, plugins, NODE_OPTIONS and agent credentials. */
const environment = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", LANG: "C.UTF-8" });

export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export interface Peer {
  client: Client;
  target: OperatorTarget;
  token: string;
  transport: Transport;
  endpoint: string;
}

export class ProductionFixture {
  readonly cleanup: (() => Promise<unknown>)[] = [];
  readonly processes: { child: ChildProcessWithoutNullStreams; output: () => string }[] = [];
  readonly tokenSecrets: string[] = [];
  dir = "";
  endpoint = "";
  socketUrl = "";
  token = "";
  daemon!: ChildProcessWithoutNullStreams;

  static async create() {
    for (const file of [
      cli,
      join(root, "packages/integrations/dist/mcp/transport.js"),
      join(root, "packages/testing/dist/scripted-agent/main.js"),
    ]) {
      try {
        await access(file);
      } catch {
        throw new Error("Acceptance requires a fresh compiled build: pnpm exec tsc -b tsconfig.build.json");
      }
    }
    const f = new ProductionFixture();
    f.dir = await mkdtemp(join(tmpdir(), "orca-mcp-production-"));
    try {
      await f.prepare();
      await f.boot();
      // Persistent non-bootstrap identity survives another daemon's bootstrap rotation.
      f.token = (await f.issue({ principal: "acceptance-owner", preset: "owner" })).token;
      return f;
    } catch (error) {
      await f.close();
      throw error;
    }
  }

  private async prepare() {
    await mkdir(join(this.dir, "workflows"));
    const agent = (id: string, live = false) => ({
      id,
      command: process.execPath,
      args: [
        join(root, "packages/testing/dist/scripted-agent/main.js"),
        "--log",
        join(this.dir, `${id}-prompts.jsonl`),
      ],
      env: { ORCA_PLAYBOOK_JSON: JSON.stringify({ default: { body: "ACCEPTANCE ARTIFACT", askPermission: live } }) },
      permissions: { default: live ? "ask" : "allow" },
    });
    await writeFile(
      join(this.dir, "orca.config.yaml"),
      JSON.stringify({
        storeDir: "state",
        workflows: ["workflows/*.yaml"],
        templates: [],
        program: { workflow: "gate" },
        agents: [agent("worker"), agent("live-worker", true)],
      }),
    );
    const worker = {
      type: "agent",
      agent: "worker",
      prompt: "ORIGINAL TASK",
      produces: [{ kind: "generic", path: "result.md" }],
    };
    const workflows = [
      {
        id: "gate",
        start: "gate",
        nodes: {
          gate: { type: "gate", question: "Continue?", options: ["approve", "stop"] },
          worker,
          end: { type: "end" },
        },
        edges: [
          { from: "gate", to: "worker", when: "choice == 'approve'" },
          { from: "gate", to: "end" },
          { from: "worker", to: "end" },
        ],
      },
      {
        id: "revision",
        start: "gate",
        nodes: {
          gate: {
            type: "gate",
            question: "Revise?",
            options: ["changes", "done"],
            revision: {
              actionId: "changes",
              destinationNodeId: "worker",
              payload: { kind: "text", maxBytes: 1024 },
              composition: "replace-revision-slot",
            },
          },
          worker,
          end: { type: "end" },
        },
        edges: [
          { from: "gate", to: "worker", when: "choice == 'changes'" },
          { from: "gate", to: "end", when: "choice == 'done'" },
          { from: "worker", to: "end" },
        ],
      },
      {
        id: "live",
        start: "worker",
        nodes: { worker: { ...worker, agent: "live-worker" }, end: { type: "end" } },
        edges: [{ from: "worker", to: "end" }],
      },
      {
        id: "parent",
        start: "fan",
        nodes: { fan: { type: "parallel", branches: { child: { workflow: "gate" } } }, end: { type: "end" } },
        edges: [{ from: "fan", to: "end" }],
      },
    ];
    for (const workflow of workflows)
      await writeFile(
        join(this.dir, "workflows", `${workflow.id}.yaml`),
        JSON.stringify({
          name: workflow.id,
          version: "1",
          ...workflow,
          start: "start",
          nodes: { start: { type: "start" }, ...workflow.nodes },
          edges: [{ from: "start", to: workflow.start }, ...workflow.edges],
        }),
      );
  }

  private process(args: string[], env = environment()) {
    const child = spawn(process.execPath, args, { cwd: this.dir, env, stdio: "pipe" });
    let output = "";
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32_768);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    this.processes.push({ child, output: () => output });
    this.cleanup.push(() => this.stop(child));
    return { child, output: () => output };
  }

  async stop(child = this.daemon, signal: NodeJS.Signals = "SIGTERM") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  async boot() {
    const proc = this.process([cli, "serve", "--config", join(this.dir, "orca.config.yaml"), "--port", "0"]);
    await until(
      async () => {
        if (proc.child.exitCode !== null)
          throw new Error(`Compiled daemon exited (${proc.child.exitCode}, ${process.execPath}): ${proc.output()}`);
        return proc.output();
      },
      (text) => /notifications on (ws:\/\/\S+)/.test(text),
      "compiled daemon readiness",
    );
    const endpoint = /listening on (http:\/\/\S+)/.exec(proc.output())![1]!;
    const socketUrl = /notifications on (ws:\/\/\S+):/.exec(proc.output())![1]!;
    this.daemon = proc.child;
    this.endpoint = endpoint;
    this.socketUrl = socketUrl;
    return { endpoint, socketUrl, child: proc.child };
  }

  /** Admin operations affect only this fixture's synthetic auth directory, in another compiled process. */
  private async admin(action: "issue" | "revoke", value: unknown): Promise<unknown> {
    const code = `import { openAuthDirectory } from ${JSON.stringify(moduleUrl("packages/daemon/dist/auth/bootstrap.js"))};
      let text = ''; for await (const chunk of process.stdin) text += chunk;
      const {action, value, dir} = JSON.parse(text); const auth = openAuthDirectory(dir);
      const result = action === 'issue' ? await auth.credentials.issue(value) : await auth.credentials.revoke(value);
      process.stdout.write(JSON.stringify(result ?? null));`;
    const proc = this.process(["--input-type=module", "-e", code]);
    const done = new Promise<void>((resolve, reject) => {
      proc.child.once("error", reject);
      proc.child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Synthetic credential administration failed")),
      );
    });
    proc.child.stdin.end(JSON.stringify({ action, value, dir: join(this.dir, "auth") }));
    await done;
    return JSON.parse(proc.output()) as unknown;
  }
  async issue(options: IssueOptions) {
    const issued = (await this.admin("issue", options)) as { token: string; credential: { id: string } };
    this.tokenSecrets.push(issued.token);
    return issued;
  }
  async revoke(id: string) {
    await this.admin("revoke", id);
  }

  async rpc(method: string, params: unknown, token = this.token, endpoint = this.endpoint): Promise<ResponseMessage> {
    const id = randomUUID();
    const response = await fetch(`${endpoint}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const value = ResponseMessageSchema.parse(await response.json());
    expect(value.id).toBe(id);
    return value;
  }

  async socket(token = this.token, url = this.socketUrl) {
    const ws = new WebSocket(url, ["orca.v1", `orca.bearer.${token}`]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket opening timed out")), 5000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Socket opening failed"));
        },
        { once: true },
      );
    });
    this.cleanup.push(async () => {
      ws.close();
    });
    return async (method: string, params: unknown): Promise<ResponseMessage> => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("Socket closed");
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          ws.removeEventListener("message", listener);
          ws.removeEventListener("close", closed);
        };
        const closed = () => {
          finish();
          reject(new Error("Socket closed"));
        };
        const listener = (event: MessageEvent) => {
          const parsed = ResponseMessageSchema.safeParse(JSON.parse(String(event.data)));
          if (parsed.success && parsed.data.id === id) {
            finish();
            resolve(parsed.data);
          }
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error(`Socket request timed out: ${method}`));
        }, 5000);
        ws.addEventListener("message", listener);
        ws.addEventListener("close", closed);
        ws.send(JSON.stringify({ kind: "request", id, method, params }));
      });
    };
  }

  async connect(
    transport: Transport,
    token = this.token,
    endpoint = this.endpoint,
    observeTransport?: (chunk: Buffer) => void,
  ): Promise<Peer> {
    const client = new Client({ name: "orca-production-acceptance", version: "1" });
    this.cleanup.push(() => client.close());
    if (transport === "stdio") {
      const wire = new StdioClientTransport({
        command: process.execPath,
        args: [
          ...(observeTransport
            ? ["--import", `data:text/javascript,${encodeURIComponent(transportObserverSource)}`]
            : []),
          cli,
          "mcp",
          "--endpoint",
          endpoint,
        ],
        cwd: this.dir,
        env: { ...environment(), ORCA_MCP_TOKEN: token },
        stderr: "pipe",
      });
      // Consume stderr, but never allow an SDK error to print a token.
      wire.stderr?.on("data", observeTransport ?? (() => undefined));
      await client.connect(wire);
    } else {
      // An isolated loopback private bridge supplies the fixed HTTPS origin; no TLS bypass,
      // fake fetch, fake backend or altered production handler is involved.
      const code = `import { createServer } from 'node:http';
        import { createOperatorHttpHandler } from ${JSON.stringify(moduleUrl("packages/integrations/dist/mcp/transport.js"))};
        const handler = createOperatorHttpHandler({daemonEndpoint: process.env.ACCEPTANCE_DAEMON, origin: 'https://acceptance.invalid'});
        const server = createServer(async (req, res) => { try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks); const method = req.method;
          const request = new Request('https://acceptance.invalid' + req.url, {method, headers: req.headers, ...(body.length ? {body} : {})});
          const result = await handler(request); res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
        } catch { res.writeHead(500); res.end(); } });
        server.listen(0, '127.0.0.1', () => console.log('BRIDGE ' + server.address().port));`;
      const proc = this.process(["--input-type=module", "-e", code], { ...environment(), ACCEPTANCE_DAEMON: endpoint });
      const ready = await until(
        async () => {
          if (proc.child.exitCode !== null) throw new Error("Compiled MCP HTTP bridge exited");
          return proc.output();
        },
        (text) => /BRIDGE \d+/.test(text),
        "MCP private bridge",
      );
      const url = new URL(`http://127.0.0.1:${/BRIDGE (\d+)/.exec(ready)![1]}/mcp`);
      await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
      );
    }
    const discovery = OperatorDiscoverySchema.parse(await tool(client, "discover_orca", {}));
    return { client, token, endpoint, transport, target: discovery.target };
  }

  async requireProduction(
    ctx: TestContext,
    peer: Peer,
    methods: readonly OperatorMutationName[] = Object.keys(aliases) as OperatorMutationName[],
  ) {
    const discovery = OperatorDiscoverySchema.parse(await tool(peer.client, "discover_orca", {}));
    const tools = (await peer.client.listTools()).tools.map((entry) => entry.name);
    const missing = methods.filter(
      (method) => !discovery.operations.includes(method) || !tools.includes(aliases[method]),
    );
    if (!missing.length) return;
    const reason = `BLOCKED: Cal production mount missing ${missing.join(", ")} (${peer.transport}); no substitute handlers installed`;
    if (process.env.ORCA_MCP_REQUIRE_PRODUCTION === "1") throw new Error(reason);
    ctx.skip(reason);
  }

  async mutation<N extends OperatorMutationName>(
    peer: Peer,
    method: N,
    params: OperatorMutationParams<N>,
  ): Promise<OperatorMutationResult<N>> {
    OperatorMutationContracts[method].params.parse(params);
    const raw = await tool(peer.client, aliases[method], params);
    const parsed = OperatorMutationContracts[method].result.parse(raw);
    expect(raw).toEqual(parsed); // Also catches unsafe fields that a permissive parser would strip.
    return parsed as OperatorMutationResult<N>;
  }

  async page(
    peer: Peer,
    collection: OperatorCollection,
    filters: { runId?: string; limit?: number; cursor?: string; workflowId?: string } = {},
  ) {
    const names: Partial<Record<OperatorCollection, string>> = {
      runs: "list_runs",
      inputs: "list_approvals",
      events: "get_events",
      artifacts: "list_artifacts",
      children: "list_children",
      requests: "list_requests",
      provenance: "get_run_provenance",
      workflows: "list_workflows",
    };
    const name = names[collection];
    if (!name) throw new Error("No fixture tool for collection");
    return OperatorBoundaryPageResultSchema.parse(await tool(peer.client, name, { target: peer.target, ...filters }));
  }

  async guards(peer: Peer, workflowId = "gate", purpose: "request" | "workflow" = "workflow") {
    const result = OperatorPreflightResultSchema.parse(
      await tool(peer.client, "preflight_launch", { target: peer.target, workflowId, purpose, vars: {} }),
    );
    const { expectedWorkflowRevision, expectedConfigGeneration, workflowVersion } = result;
    return { workflowId, workflowVersion, expectedWorkflowRevision, expectedConfigGeneration };
  }

  async start(peer: Peer, workflowId = "gate", key: string = randomUUID()) {
    const command = { ...(await this.guards(peer, workflowId)), vars: {} };
    const params = { target: peer.target, command, retry: { idempotencyKey: key } };
    const receipt = accepted(await this.mutation(peer, "operator.admitRun", params));
    return { params, receipt, runId: receipt.result.runId };
  }

  async pending(peer: Peer, runId: string) {
    const requested = await this.readyInput(peer, runId);
    const page = await this.page(peer, "inputs", { runId });
    const input = page.items.find((row) => row.requestId === requested.payload.requestId);
    expect(input).toMatchObject({ runId, stepRunId: requested.payload.stepRunId });
    if (requested.payload.liveDecision)
      expect(input?.live).toEqual({
        state: "pending",
        target: {
          ...requested.payload.liveDecision,
          runId,
          stepRunId: requested.payload.stepRunId,
          requestId: requested.payload.requestId,
        },
      });
    return input!;
  }

  /** Bounded authorized observation only; never read disk or borrow the fixture owner's token. */
  async observedEvents(peer: Peer, runId: string) {
    const events: ReturnType<typeof RunsEventsResultSchema.parse>["events"] = [];
    let after: number | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = RunsEventsResultSchema.parse(
        rpcResult(await this.rpc("runs.events", { runId, after, limit: 500 }, peer.token, peer.endpoint)),
      );
      expect(page.events.length).toBeLessThanOrEqual(500);
      for (const event of page.events) {
        expect(event.runId).toBe(runId);
        expect(event.seq).toBeGreaterThan(after ?? -1);
        after = event.seq;
        events.push(event);
      }
      if (!page.hasMore) return events;
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.nextCursor).toBe(after);
    }
    throw new Error("Fixture readiness exceeded its 5000-event observation bound");
  }

  /** Wait for publication milestones before asserting a settled MCP projection. Errors propagate. */
  async readyInput(peer: Peer, runId: string) {
    const requested = await until(
      async () => {
        const events = await this.observedEvents(peer, runId);
        const request = events.findLast(
          (event) =>
            event.type === "human.requested" &&
            !events.some(
              (answer) => answer.type === "human.answered" && answer.payload.requestId === event.payload.requestId,
            ),
        );
        if (request?.type !== "human.requested") return undefined;
        const waiting = events.find(
          (event) =>
            event.seq > request.seq &&
            event.type === "step.waiting" &&
            event.payload.stepRunId === request.payload.stepRunId &&
            event.payload.on === "human-input" &&
            event.payload.detail === request.payload.requestId,
        );
        if (!waiting) return undefined;
        if (
          !request.payload.liveDecision &&
          !events.some((event) => event.type === "run.paused" && event.seq > waiting.seq)
        )
          return undefined;
        return request;
      },
      (request) => request !== undefined,
      "exact unanswered input publication",
    );
    if (!requested) throw new Error("Missing published request");
    if (requested.payload.liveDecision) {
      expect(requested.payload.kind).toBe("permission");
      expect(requested.payload.liveDecision.instanceId).toBe(peer.target.instanceId);
      const expected = {
        ...requested.payload.liveDecision,
        runId,
        stepRunId: requested.payload.stepRunId,
        requestId: requested.payload.requestId,
      };
      const input = await until(
        async () => {
          const observed = readinessRpcResult(await this.rpc("inputs.list", { runId }, peer.token, peer.endpoint));
          if (observed.changed) return undefined;
          return InputsListResultSchema.parse(observed.result).inputs.find(
            (row) => row.runId === runId && row.id === expected.requestId,
          );
        },
        (row) => row?.live?.state === "pending",
        "current live permission owner",
      );
      expect(input?.live?.target).toEqual(expected);
    }
    return requested;
  }

  async readyStatus(peer: Peer, runId: string, status: "waiting" | "succeeded" | "cancelled") {
    const type = { waiting: "run.paused", succeeded: "run.completed", cancelled: "run.cancelled" }[status];
    const events = await until(
      () => this.observedEvents(peer, runId),
      (events) =>
        events.findLast((event) =>
          ["run.started", "run.resumed", "run.paused", "run.completed", "run.failed", "run.cancelled"].includes(
            event.type,
          ),
        )?.type === type,
      `published ${status} milestone`,
    );
    // Completion precedes the continuation service's final fenced write. Observe
    // that receipt through the same authorized peer before reading a settled page.
    if (status !== "waiting") {
      const ids = new Set(
        events.filter((event) => event.type === "continuation.recorded").map((event) => event.payload.continuationId),
      );
      for (const continuationId of ids) {
        let lastReceipt: ReturnType<typeof ContinuationReceiptSchema.parse> | undefined;
        try {
          const receipt = await until(
            async () =>
              (lastReceipt = ContinuationReceiptSchema.parse(
                rpcResult(await this.rpc("continuations.get", { continuationId }, peer.token, peer.endpoint)),
              )),
            (receipt) => {
              expect(receipt, "completed continuation must not become blocked").not.toMatchObject({ state: "blocked" });
              return receipt.state === "settled";
            },
            "settled continuation receipt",
          );
          expect(receipt).toMatchObject({ runId, continuationId });
        } catch (error) {
          // Failure-only reads, with the same peer and bounded event paging. Never
          // reconcile, open protected entries, or print subprocess output here.
          const latest = await this.observedEvents(peer, runId).catch(() => events);
          const leaseFilePresent = await access(
            join(this.dir, "state/leases", `${encodeURIComponent(`run:${runId}`)}.json`),
          ).then(
            () => true,
            (failure: unknown) =>
              failure && typeof failure === "object" && "code" in failure && failure.code === "ENOENT"
                ? false
                : ("unavailable" as const),
          );
          console.error(
            "Continuation settlement failure",
            JSON.stringify(continuationDiagnostics(latest, lastReceipt, leaseFilePresent, error)),
          );
          throw error;
        }
      }
    }
  }

  async boundary(peer: Peer, runId: string) {
    await this.readyStatus(peer, runId, "waiting");
    const page = await until(
      () => this.page(peer, "runs", { runId }),
      (page) => page.items[0]?.continuationState === "available",
      "authorized continuation boundary",
    );
    return page.items[0]!.expectedBoundary!;
  }

  async status(peer: Peer, runId: string, status: "waiting" | "succeeded" | "cancelled") {
    await this.readyStatus(peer, runId, status);
    return until(
      () => this.page(peer, "runs", { runId }),
      (page) => page.items[0]?.status === status,
      `run ${status}`,
    );
  }

  async events(runId: string) {
    return (await readFile(join(this.dir, "state/runs", `${runId}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  }

  async audit() {
    return (await readFile(join(this.dir, "auth/audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            operation?: string;
            actor?: { principal: string; credential: string };
            target?: Record<string, string>;
            outcome: string;
          },
      );
  }

  /** Drop a real committed daemon response; forwards authentication and all bytes unchanged. */
  async loseAcknowledgement(method: OperatorMutationName, endpoint = this.endpoint) {
    let dropped: unknown;
    let count = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const envelope = JSON.parse(body.toString()) as { method: string };
        const forwarded = await fetch(`${endpoint}${request.url}`, {
          method: request.method!,
          headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
          body,
        });
        const text = await forwarded.text();
        if (envelope.method === method && ++count === 1) {
          dropped = rpcResult(ResponseMessageSchema.parse(JSON.parse(text)));
          response.destroy();
        } else {
          response.writeHead(forwarded.status, { "content-type": "application/json" });
          response.end(text);
        }
      })().catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No proxy address");
    return { endpoint: `http://127.0.0.1:${address.port}`, dropped: () => dropped, count: () => count };
  }

  /** Network publication barrier, after real authorized work; never replaces a service callback. */
  async holdReply(method: string, endpoint = this.endpoint) {
    let release!: () => void;
    let observed!: () => void;
    const held = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const envelope = JSON.parse(body.toString()) as { method: string };
        const forwarded = await fetch(`${endpoint}${request.url}`, {
          method: request.method!,
          headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
          body,
        });
        const text = await forwarded.text();
        if (armed && envelope.method === method) {
          armed = false;
          observed();
          await released;
        }
        response.writeHead(forwarded.status, { "content-type": "application/json" });
        response.end(text);
      })().catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          release();
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No barrier address");
    return {
      endpoint: `http://127.0.0.1:${address.port}`,
      arm: () => {
        armed = true;
      },
      held,
      release,
    };
  }

  async close() {
    const errors: unknown[] = [];
    for (const close of this.cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
  }
}

export async function tool(client: Client, name: string, args: object): Promise<unknown> {
  const result = await client.callTool({ name, arguments: { ...args } });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
  if (result.isError) throw new Error(`MCP refused ${name}: ${JSON.stringify(result.content)}`);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent;
}

export async function refused(peer: Peer, name: string, args: object, code?: string) {
  const result = await peer.client.callTool({ name, arguments: { ...args } });
  expect(result.isError).toBe(true);
  expect(result).not.toHaveProperty("structuredContent");
  const text = JSON.stringify(result);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
  if (code) expect(text).toContain(code);
  expect(text).not.toContain(peer.token);
  return text;
}

/** Accept only the SDK's typed HTTP 401 or the ordinary bounded MCP auth refusal. */
export async function authenticationRefused(peer: Peer, name: string, args: object) {
  try {
    return await refused(peer, name, args, "AUTH_INVALID");
  } catch (error) {
    if (peer.transport !== "http" || !(error instanceof SdkHttpError) || error.status !== 401) throw error;
    // Error.message is not a status code. Include it explicitly because Error fields
    // are not all enumerable, and bound/check the SDK's public data as well.
    const text = JSON.stringify({ name: error.name, message: error.message, data: error.data });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(OPERATOR_MAX_RESULT_BYTES);
    expect(text).not.toContain(peer.token);
    return text;
  }
}

/** Only the known public snapshot-change refusal is transient readiness, never a successful empty page. */
export function readinessRpcResult(response: ResponseMessage): { changed: true } | { changed: false; result: unknown } {
  if (
    !response.ok &&
    response.error.code === "RUN_STATE" &&
    response.error.message === "Event observation history changed" &&
    response.error.details === undefined
  )
    return { changed: true };
  return { changed: false, result: rpcResult(response) };
}

export function rpcResult(response: ResponseMessage): unknown {
  if (!response.ok) throw new Error(`Backing RPC refused: ${response.error.code}`);
  return response.result;
}

export function accepted<T extends { state: string }>(
  value: { state: "in-progress" } | { state: "resolved"; operationId: string; replayed: boolean; result: T },
) {
  if (
    value.state !== "resolved" ||
    value.result.state !== "accepted" ||
    !("runId" in value.result) ||
    typeof value.result.runId !== "string"
  )
    throw new Error("Expected real accepted run receipt");
  return value as typeof value & { result: T & { runId: string } };
}

export function resolved<T>(
  value: { state: "in-progress" } | { state: "resolved"; operationId: string; replayed: boolean; result: T },
) {
  if (value.state !== "resolved") throw new Error("Expected resolved durable receipt");
  return value;
}
