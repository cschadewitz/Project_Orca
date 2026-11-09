/** Synthetic-only subprocess probe: no provider, credential, durable store or network. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { PassThrough } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AgentRegistry, LocalHost, openAcpSession, stdioAcpStream } from "@orca/agents";
import {
  AgentSpecSchema,
  consoleLogger,
  parseWorkflow,
  TemplateRegistry,
  WorkflowRegistry,
  type OrcaEvent,
} from "@orca/core";
import { builtinExecutors, completed, Orchestrator, ProgramService } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { notificationsFor, ReadModel } from "@orca/daemon";
import { serveAcpFacade } from "../../src/acp-facade/orca-acp-agent.js";
import { canaries } from "./acp-diagnostic-canaries.js";
const values = Object.values(canaries);
const contains = (value: unknown) => values.some((marker) => JSON.stringify(value).includes(marker));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
};
const nextMessage = () => new Promise<void>((resolve) => process.once("message", () => resolve()));

async function probe(role: string) {
  const stores = memoryStores();
  const events: OrcaEvent[] = [];
  const logs: string[] = [];
  const peerUpdates: unknown[] = [];
  stores.events.subscribe((event) => events.push(event));
  const entered = deferred();
  const release = deferred();
  let listenerCalls = 0;
  let validationRejected = false;
  let malformedRejected = false;
  const executors = builtinExecutors();
  executors.register({
    type: "custom:canary",
    execute: async (ctx) => {
      ctx.logger.warn(`Synthetic execution log ${values.join(" ")}`, { private: values });
      entered.resolve();
      if (role === "facade") await release.promise;
      else {
        const host = new LocalHost({ id: "local", type: "local" });
        let reads = 0;
        host.fs.readFile = async () => {
          reads++;
          return "must not be reached";
        };
        const source = `
const readline = require('node:readline').createInterface({input:process.stdin});
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let prompt;
const watchdog = setTimeout(() => process.exit(2),5000);
readline.on('line',line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{protocolVersion:m.params.protocolVersion,agentCapabilities:{loadSession:false}}});
 else if(m.method==='session/new') send({id:m.id,result:{sessionId:'synthetic-session'}});
 else if(m.method==='session/prompt') {
  prompt=m.id;
  send({private:${JSON.stringify(canaries.malformed)}});
  send({id:${JSON.stringify(canaries.unknownId)},result:{}});
  send({method:'session/update',params:{sessionId:'synthetic-session',update:{sessionUpdate:'invalid-synthetic-update'}}});
  send({method:'session/update',params:{sessionId:'synthetic-session',_meta:{synthetic:${JSON.stringify(canaries.notification)}},update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(canaries.notification)}}}}});
  send({id:'invalid-read',method:'fs/read_text_file',params:{sessionId:'synthetic-session',path:123}});
 } else if(m.id===null && m.error?.code===-32600) {
  process.stderr.write('synthetic-malformed-code:-32600\\n');
 } else if(m.id==='invalid-read') {
  process.stderr.write('synthetic-validation-code:'+m.error?.code+'\\n');
  send({id:prompt,result:{stopReason:'end_turn'}});
 }
});
process.stdin.on('end',()=>{clearTimeout(watchdog);process.exit(0)});
`;
        let proc: Awaited<ReturnType<LocalHost["spawnAgent"]>> | undefined;
        const spawn = host.spawnAgent.bind(host);
        host.spawnAgent = async (...args) => (proc = await spawn(...args));
        const session = await openAcpSession({
          host,
          agent: AgentSpecSchema.parse({ id: "synthetic", command: process.execPath, args: ["-e", source] }),
          cwd: process.cwd(),
          logger: ctx.logger,
          handshakeTimeoutMs: 2000,
          exitGraceMs: 100,
        });
        try {
          session.onUpdate(() => {
            listenerCalls++;
            throw new acp.RequestError(-32603, canaries.error, { synthetic: canaries.error });
          });
          await session.prompt("synthetic-only", { timeoutMs: 2000 });
          await nextTurn();
          validationRejected = reads === 0 && !!proc?.stderrTail().includes("synthetic-validation-code:-32602");
          malformedRejected = !!proc?.stderrTail().includes("synthetic-malformed-code:-32600");
        } finally {
          await session.close();
        }
      }
      return completed();
    },
  });
  const workflows = new WorkflowRegistry();
  workflows.register(
    parseWorkflow(`
id: diagnostic-canary
name: Synthetic diagnostic canary
version: "1"
inputSchema:
  fields:
    malformed: { type: string, sensitive: true }
    notification: { type: string, sensitive: true }
    error: { type: string, sensitive: true }
    unknownId: { type: string, sensitive: true }
start: s
nodes:
  s: { type: start }
  probe: { type: custom:canary }
  e: { type: end }
edges:
  - { from: s, to: probe }
  - { from: probe, to: e }
`),
  );
  const orchestrator = new Orchestrator({
    stores,
    workflows,
    executors,
    agents: new AgentRegistry(),
    templates: new TemplateRegistry(),
    workspaceProvider: { name: "synthetic", provision: async () => ({ hostId: "local", cwd: process.cwd() }) },
    logger: consoleLogger("debug", {}, (line) => logs.push(line)),
  });
  let runId: string;
  if (role === "client") {
    runId = await orchestrator.startRun({ workflowId: "diagnostic-canary", vars: { ...canaries } });
    await orchestrator.run(runId);
  } else {
    const input = new PassThrough();
    const output = new PassThrough();
    let buffered = "";
    output.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as { error?: { code?: number }; id?: unknown };
        if (message.id === null && message.error?.code === -32600) malformedRejected = true;
      }
    });
    const served = serveAcpFacade(
      { orchestrator, program: new ProgramService(orchestrator) },
      { stdin: input, stdout: output },
    );
    const client = acp
      .client({ name: "synthetic-client" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        peerUpdates.push(ctx.params);
      })
      .connect(stdioAcpStream(output, input));
    try {
      await client.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await client.agent.request(acp.methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
      });
      const prompt = client.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: "text",
            text: `/run diagnostic-canary ${Object.entries(canaries)
              .map(([name, value]) => `${name}=${value}`)
              .join(" ")}`,
          },
        ],
      });
      await entered.promise;
      const called = deferred();
      const cancel = orchestrator.cancel.bind(orchestrator);
      orchestrator.cancel = async () => {
        listenerCalls++;
        called.resolve();
        throw new acp.RequestError(-32603, canaries.error, { synthetic: canaries.error });
      };
      input.write(JSON.stringify({ private: canaries.malformed }) + "\n");
      input.write(JSON.stringify({ jsonrpc: "2.0", id: canaries.unknownId, result: {} }) + "\n");
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: 123 } }) + "\n");
      input.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId, _meta: { synthetic: canaries.notification } },
        }) + "\n",
      );
      await called.promise;
      await nextTurn();
      // A malformed request still reaches the SDK's schema validator and returns -32602.
      await client.agent
        .request(acp.methods.agent.session.new, { cwd: 123, mcpServers: [] } as never)
        .catch((error: unknown) => {
          validationRejected = error instanceof acp.RequestError && error.code === -32602;
        });
      orchestrator.cancel = cancel;
      release.resolve();
      await prompt;
      runId = (await orchestrator.listRuns())[0]!;
    } finally {
      client.close();
      input.end();
      await served;
      output.destroy();
    }
  }
  const state = await orchestrator.getState(runId);
  const view = await new ReadModel({ orchestrator }).runsGet({ runId });
  const replay = (await orchestrator.eventsRange(runId)).flatMap((event) => notificationsFor(event, "replay"));
  const privateInputs = await stores.execution.getInputs(runId);
  return {
    role,
    runStatus: state.run.status,
    listenerCalls,
    validationRejected,
    malformedRejected,
    authoritativeInputsIntact: Object.entries(canaries).every(([name, value]) => privateInputs?.vars[name] === value),
    publicVarsRedacted: Object.keys(canaries).every((name) => state.run.vars[name] === "[REDACTED]"),
    executionLoggerRedacted: logs.some((line) => line.includes("[REDACTED]")),
    executionLoggerContainsCanary: contains(logs),
    publicStateContainsCanary: contains(state),
    readViewContainsCanary: contains(view),
    liveNotificationsContainCanary: contains(events.flatMap((event) => notificationsFor(event, "live"))),
    replayNotificationsContainCanary: contains(replay),
    facadeUpdatesContainCanary: contains(peerUpdates),
  };
}

process.send?.("ready");
await nextMessage();
try {
  const result = await probe(process.argv[2] ?? "client");
  console.error("ORCA_SYNTH_UNRELATED_DIAGNOSTIC");
  process.send?.({ result });
  await nextMessage();
} catch (error) {
  process.send?.({
    failed: true,
    error: error instanceof Error ? error.message.slice(0, 1024) : "unknown fixture error",
  });
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
