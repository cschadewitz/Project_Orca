/**
 * #701 activation, end to end and offline: the daemon's own judge wiring (`withPlainRuleJudge` and
 * `plainRuleJudgeSource` over real credentials, ownership and the orchestrator's resolver) around the session factory
 * `orca serve` uses (`makeSessionFactory`: ORCA's protected paths, permission sidecar and provider guards), a run
 * pinned to a configuration generation, a real ACP agent over stdio, and ORCA's permission and file gates. The provider is a
 * deterministic stand-in on loopback, reached through the real HTTPS sender's request seam: no key leaves the
 * machine and nothing real is called.
 *
 * - Opted in, with the owner's grant: ORCA's own read of a verified file is allowed once with nobody asked, and a
 *   command the agent asks to run still goes to the person, with the judge's advice on the ask.
 * - An upgraded config (no `enabled`) or a missing grant: nothing is sent and the read goes to the person.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { plainRuleDisclosureQuery, type HttpsRequestFn } from "@orca/agents/review-judge";
import { parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import {
  ConfigurationGenerations,
  humanInputCancelled,
  LocalWorkspaceProvider,
  Orchestrator,
  type HumanInputPort,
  type HumanInputQuery,
} from "@orca/engine";
import { memoryStores } from "@orca/store";
import {
  CredentialStore,
  orchestratorResolver,
  OwnershipStore,
  plainRuleJudgeSource,
  withPlainRuleJudge,
  type QualifiedJudgeBudget,
} from "@orca/daemon";
import { makeSessionFactory } from "../src/bootstrap.js";

/** Reads docs/a.md through ORCA, then asks to run `ls docs`; logs both outcomes. */
const agentScript = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "reader", version: "0" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    const read = await request("fs/read_text_file", { sessionId: "s1", path: process.env.READ });
    const command = await request("session/request_permission", {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "ls docs", kind: "execute", rawInput: { command: "ls docs" } },
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
    });
    require("node:fs").writeFileSync(process.env.RESULT_LOG, JSON.stringify({ read, command }));
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve(m.error ? { error: m.error.data } : { result: m.result });
  }
});
setInterval(() => {}, 1000);
`;

const flow = `
id: judged
name: Judged
start: s
nodes:
  s: { type: start }
  g: { type: gate, question: Go?, options: [go] }
  work: { type: agent, agent: reader, prompt: "read the docs" }
  e: { type: end }
edges: [{ from: s, to: g }, { from: g, to: work }, { from: work, to: e }]
`;

/** Parks every question until the test answers it. */
class Inbox implements HumanInputPort {
  readonly asked: HumanInputQuery[] = [];
  private readonly pending = new Map<string, (v: string | undefined) => void>();
  constructor(private readonly answerFor: (q: HumanInputQuery) => string | undefined) {}
  ask(query: HumanInputQuery): Promise<string | undefined> {
    this.asked.push(query);
    if (query.signal?.aborted) return Promise.reject(humanInputCancelled(query.signal));
    const auto = this.answerFor(query);
    if (auto !== undefined) return Promise.resolve(auto);
    return new Promise((resolve) => this.pending.set(query.requestId, resolve));
  }
  answer(requestId: string, value: string): void {
    this.pending.get(requestId)?.(value);
    this.pending.delete(requestId);
  }
}

const durable: QualifiedJudgeBudget = Object.freeze({
  status: "durable",
  budget: Object.freeze({
    durable: true as const,
    reserve: async () => true,
    initialize: async () => ({ status: "initialized" as const, day: "2026-11-24" }),
    replace: async () => ({ status: "initialized" as const, day: "2026-11-24" }),
  }),
  storeDir: "/s",
  anchorDir: "/a",
});

let server: Server;
let sent: { url: string; frame: { action: Record<string, unknown> } }[];
let port: number;
let keyEnv: string;
const dirs: string[] = [];

beforeEach(async () => {
  sent = [];
  keyEnv = `ORCA_TEST_JUDGE_KEY_${randomUUID().replace(/-/g, "")}`;
  process.env[keyEnv] = `sk-test-${randomUUID()}`;
  // The provider stand-in: Anthropic's reply shape, "covered" for every rule it is shown.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { content: string }[] };
      const frame = JSON.parse(body.messages[0]!.content) as {
        requestId: string;
        rules: { id: string; revision: string }[];
        action: Record<string, unknown>;
      };
      sent.push({ url: req.url ?? "", frame });
      const text = JSON.stringify({
        schema: "orca-plain-rule-verdict/v1",
        requestId: frame.requestId,
        verdicts: frame.rules.map((r) => ({
          ruleId: r.id,
          ruleRevision: r.revision,
          verdict: "covered",
          reasonCode: "matches-criterion",
        })),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "stand-in",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  delete process.env[keyEnv];
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The sender keeps its https destination; the request itself goes to the loopback stand-in. */
const loopback: HttpsRequestFn = (options) => httpRequest({ ...options, protocol: "http:", port });

async function run(opts: { enabled?: boolean; grant?: boolean }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orca-judge-activated-")));
  dirs.push(dir);
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs", "a.md"), "hello\n");
  const log = join(dir, "result.json");
  const destination = `https://127.0.0.1:${port}/v1/messages`;
  const judge = { provider: { kind: "anthropic" }, destination, credential: "judge-key" };
  const config = parseOrcaConfig({
    secrets: { "judge-key": { host: "local", provider: "env", name: keyEnv, destination } },
    review: {
      plainRules: {
        judge,
        ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
        experimental: { kinds: { commands: true } },
      },
    },
    agents: [
      {
        id: "reader",
        command: process.execPath,
        args: ["-e", agentScript],
        env: { READ: join(dir, "docs", "a.md"), RESULT_LOG: log },
        permissions: {
          default: "ask",
          rules: [
            { match: { kind: "read", scope: "workspace" }, judge: { criterion: "Reading the docs." } },
            { match: { kind: "execute" }, judge: { criterion: "Listing the docs folder." } },
          ],
        },
      },
    ],
  });
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(flow));
  const stores = memoryStores();
  const credentials = new CredentialStore();
  const ownership = new OwnershipStore();
  await credentials.issue({
    principal: "casey",
    preset: "owner",
    ...(opts.grant === false
      ? {}
      : { disclosures: [plainRuleDisclosureQuery(judge)!, plainRuleDisclosureQuery(judge, "command")!] }),
  });
  const inbox = new Inbox((q) => (q.kind === "permission" ? "no" : undefined));
  const orchestrator = new Orchestrator({
    stores,
    agents: AgentRegistry.fromConfig(config),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    humanInput: inbox,
    sessionFactory: makeSessionFactory({ configDir: dir, storeDir: ".orca" }),
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: workflows.list(), templates: [] }),
    admission: {
      validateStartRun: (options, generation) => orchestrator.validateStartRun(options, generation),
      startRun: (options, generation) => orchestrator.startRun(options, generation),
    },
  });
  await generations.initialize(config, "rev", { workflows: workflows.list(), templates: [] });
  orchestrator.generations = generations;
  const unavailable: string[] = [];
  // The daemon's own wiring, as `orca serve` does it in token mode.
  orchestrator.sessionFactory = withPlainRuleJudge(
    orchestrator.sessionFactory,
    plainRuleJudgeSource({
      config: () => generations.effectiveConfig(),
      budget: async () => durable,
      resolver: orchestratorResolver(orchestrator),
      ownership,
      credentials,
      request: loopback,
    }),
    (info) => unavailable.push(info.reason),
  );
  const launch = await generations.captureLaunch({ purpose: "workflow", workflowId: "judged" });
  const runId = await launch.startRun({});
  const done = orchestrator.run(runId);
  // The run's owner, as `requests.submit` records it, before the agent step opens a session.
  await expect.poll(() => inbox.asked.find((q) => q.kind !== "permission")).toBeDefined();
  ownership.record(runId, "casey");
  const gate = inbox.asked.find((q) => q.kind !== "permission")!;
  inbox.answer(gate.requestId, "go");
  const state = await done;
  const result = JSON.parse(await readFile(log, "utf8")) as {
    read: { result?: { content: string }; error?: unknown };
    command: { result?: { outcome: { outcome: string; optionId?: string } } };
  };
  const asks = inbox.asked.filter((q) => q.kind === "permission");
  return { state, result, asks, unavailable };
}

describe("#701 the activated judge, through the daemon's wiring (offline)", () => {
  it("opted in with the owner's grant: allows ORCA's verified read once, and the command still asks with advice", async () => {
    const out = await run({ enabled: true });
    expect(out.state.run.status).toBe("completed");
    // The read: ORCA's own, allowed by the plain-language rule, nobody asked.
    expect(out.result.read).toEqual({ result: { content: "hello\n" } });
    expect(out.asks.map((a) => a.question)).toEqual(["ls docs"]);
    // The command: still the person's, who said no, with the judge's recommendation on the ask.
    expect(out.result.command.result?.outcome).toEqual({ outcome: "selected", optionId: "no" });
    expect(out.asks[0]!.context).toMatchObject({
      judge: { verdict: "covered", kind: "command", advisory: true, reasonCode: "matches-criterion" },
    });
    // What the stand-in saw: one verified read, then the command, and nothing else.
    expect(sent.map((s) => s.frame.action.kind)).toEqual(["read", "execute"]);
    // The judge was shown the verified workspace-relative file, never the absolute path or its contents.
    expect(sent[0]!.frame.action).toMatchObject({ kind: "read", locations: ["docs/a.md"], inWorkspace: true });
    expect(sent[0]!.frame.action.title).toBe("Read docs/a.md");
    expect(JSON.stringify(sent)).not.toContain("hello");
    expect(JSON.stringify(sent)).not.toContain(tmpdir());
    expect(sent.every((s) => s.url === "/v1/messages")).toBe(true);
    expect(out.unavailable).toEqual([]);
  });

  it("an upgraded config without enabled: true sends nothing, and the read goes to the person", async () => {
    const out = await run({});
    expect(sent).toEqual([]);
    expect(out.unavailable).toEqual(["not-enabled"]);
    expect(out.asks.map((a) => a.question)).toEqual([`Read ${out.asks[0]!.question.slice(5)}`, "ls docs"]);
    expect(out.asks.every((a) => a.context["judge"] === undefined)).toBe(true);
    expect(out.result.read).toHaveProperty("error");
  });

  it("enabled without the owner's disclosure grant sends nothing, and the read goes to the person", async () => {
    const out = await run({ enabled: true, grant: false });
    expect(sent).toEqual([]);
    expect(out.unavailable).toEqual(["disclosure-grant-missing"]);
    expect(out.asks).toHaveLength(2);
    expect(out.result.read).toHaveProperty("error");
  });
});
