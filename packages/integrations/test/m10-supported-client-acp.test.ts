/** Real ACP JSON-RPC wire; disposable production bootstrap, no provider execution. */
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { createRevisionRuntime, PausingHumanInput } from "@orca/engine";
import { bootstrapLocalOwner, openAuthDirectory } from "@orca/daemon";
import { serveAcpFacade } from "@orca/integrations";
import { bootstrap } from "../../cli/src/bootstrap.js";
import { localSubmissionAuthority, authorityForNewLocalIntent } from "../../cli/src/local-submission-authority.js";
import { FileAdmissionStore } from "../../engine/src/program/submission-store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

type Frame = {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: { update?: acp.SessionUpdate };
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-m10-acp-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "program.yaml"),
    `id: program
name: Program
version: '1'
start: s
nodes: {s: {type: start}, e: {type: end}}
edges: [{from: s, to: e}]
`,
  );
  await writeFile(
    join(dir, "review.yaml"),
    `id: review
name: Review
version: '1'
start: s
nodes:
  s: {type: start}
  gate:
    type: gate
    question: Continue?
    options: [changes, done]
    revision:
      actionId: changes
      destinationNodeId: worker
      payload: {kind: text, maxBytes: 1024}
      composition: replace-revision-slot
  worker: {type: agent, agent: unused, prompt: Original}
  e: {type: end}
edges:
  - {from: s, to: gate}
  - {from: gate, to: worker, when: "choice == 'changes'"}
  - {from: gate, to: e, when: "choice == 'done'"}
  - {from: worker, to: e}
`,
  );
  const auth = openAuthDirectory(join(dir, "auth"));
  const owner = await bootstrapLocalOwner(auth);
  let revisions!: ReturnType<typeof createRevisionRuntime>;
  const deliver = vi.fn(async () => {
    throw new Error("Provider delivery is outside this fixture");
  });
  const app = await bootstrap({
    configDir: dir,
    config: parseOrcaConfig({
      storeDir: "state",
      workflows: ["*.yaml"],
      templates: [],
      program: { workflow: "program" },
      agents: [{ id: "unused", command: process.execPath }],
    }),
    logger: silentLogger,
    humanInput: new PausingHumanInput(),
    submissionAuthority: localSubmissionAuthority,
    revisionRuntime: (stores) => {
      revisions = createRevisionRuntime({ stores, authorizeExecution: deliver });
      return revisions.runtime;
    },
  });
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const frames: Frame[] = [];
  let buffer = "",
    id = 0;
  const waiting = new Map<number, (frame: Frame) => void>();
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    expect(Buffer.byteLength(buffer)).toBeLessThan(64 * 1024);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as Frame;
      frames.push(frame);
      if (frame.id !== undefined) waiting.get(frame.id)?.(frame);
    }
  });
  const served = serveAcpFacade(
    {
      orchestrator: app.orchestrator,
      program: app.program,
      submissionAuthority: app.submissionAuthority!,
      authorityForNewIntent: authorityForNewLocalIntent(app, app.submissionAuthority!),
    },
    { stdin, stdout },
  );
  cleanups.push(async () => {
    stdin.end();
    await served;
    stdout.destroy();
  });
  const wire = async (method: string, params: object): Promise<Frame> => {
    const requestId = ++id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Frame>((resolve, reject) => {
        waiting.set(requestId, resolve);
        timer = setTimeout(() => reject(new Error(`ACP ${method} exceeded fixture timeout`)), 5000);
        stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
      });
    } finally {
      clearTimeout(timer);
      waiting.delete(requestId);
    }
  };
  const initialized = await wire("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  expect(initialized).not.toHaveProperty("error");
  const session = async () => {
    const frame = await wire("session/new", { cwd: dir, mcpServers: [] });
    expect(frame).not.toHaveProperty("error");
    return (frame.result as { sessionId: string }).sessionId;
  };
  const prompt = (sessionId: string, text: string, key = "ACP_PRIVATE_KEY") =>
    wire("session/prompt", {
      sessionId,
      _meta: { "orca/idempotencyKey": key },
      prompt: [{ type: "text", text }],
    });
  const snapshot = async () => {
    const runs = await app.orchestrator.listRuns();
    return {
      requests: await app.orchestrator.stores.requests.list(),
      admissions: await new FileAdmissionStore(join(dir, "state")).records.list(),
      runs,
      events: await Promise.all(runs.map((runId) => app.orchestrator.events(runId))),
      boundaries: await Promise.all(runs.map((runId) => revisions.readBoundaries(runId))),
    };
  };
  return { app, auth, owner, revisions, deliver, wire, session, prompt, frames, snapshot };
}

it("#356 rejects revision slash commands and unregistered methods over ACP without touching an existing protected pause", async () => {
  const f = await fixture();
  const launch = await f.app.generations.captureLaunch({ purpose: "workflow", workflowId: "review" });
  const runId = await launch.startRun({ actor: f.app.submissionAuthority!.actor });
  expect((await f.app.orchestrator.run(runId)).run.status).toBe("paused");
  const [boundary] = await f.revisions.readBoundaries(runId);
  expect(boundary?.status).toBe("waiting");
  const writes = ["putGeneration", "putInputs", "putPayload", "addSensitivity"] as const;
  const protectedWrites = writes.map((name) => vi.spyOn(f.app.orchestrator.stores.execution, name));
  const before = await f.snapshot();
  const sessionId = await f.session();
  for (const command of ["/revise", "/revise_input", "/request-changes", "/replaceRevision"]) {
    const offset = f.frames.length;
    expect(await f.prompt(sessionId, `${command} ${runId} PRIVATE_CORRECTION`)).toMatchObject({
      result: { stopReason: "end_turn" },
    });
    const text = f.frames
      .slice(offset)
      .map((frame) => frame.params?.update)
      .filter((u) => u?.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content: { text: string } }).content.text)
      .join("");
    expect(text).toContain(`Unknown command ${command}.`);
    expect(text).toContain("Available commands:");
    expect(text).not.toContain("PRIVATE_CORRECTION");
    expect(await f.snapshot()).toEqual(before);
  }
  for (const method of ["inputs.revise", "inputs.replaceRevision", "session/revise_input"]) {
    const frame = await f.wire(method, {
      sessionId,
      command: { target: boundary!.target, actionId: "changes", payload: { kind: "text", text: "PRIVATE_CORRECTION" } },
      retry: { idempotencyKey: "ACP_PRIVATE_KEY" },
    });
    expect(frame).toMatchObject({ error: { code: -32601 } });
    expect(frame).not.toHaveProperty("result");
    expect(JSON.stringify(frame)).not.toMatch(/PRIVATE_CORRECTION|ACP_PRIVATE_KEY/);
    expect(await f.snapshot()).toEqual(before);
  }
  for (const spy of protectedWrites) expect(spy).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
});

it("#331 retains Request identity across ACP sessions, refuses changed payload, and allocates only an explicit new key", async () => {
  const f = await fixture();
  const text = "Build it\nPRIVATE_REQUEST_BODY";
  expect(await f.prompt(await f.session(), text)).not.toHaveProperty("error");
  const original = await f.snapshot();
  expect(original.requests).toHaveLength(1);
  expect(original.runs).toHaveLength(1);
  expect(original.admissions).toHaveLength(1);
  const sessionId = await f.session();
  expect(await f.prompt(sessionId, text)).not.toHaveProperty("error");
  const replayed = await f.snapshot();
  // Settlement may refresh Request.updatedAt; admission and execution identity stay fixed.
  expect({ ...replayed, requests: original.requests }).toEqual(original);
  expect(replayed.requests.map(({ updatedAt: _time, ...request }) => request)).toEqual(
    original.requests.map(({ updatedAt: _time, ...request }) => request),
  );
  const conflict = await f.prompt(sessionId, "Build it\nCHANGED_BODY");
  // The current facade exposes OrcaError through the SDK's internal-error envelope;
  // its explicit public conflict reason survives, but RETRY_CONFLICT does not.
  expect(conflict).toMatchObject({
    error: {
      code: -32603,
      data: { details: "Retry key is already bound to a different command" },
    },
  });
  expect(JSON.stringify(conflict)).not.toMatch(/CHANGED_BODY|ACP_PRIVATE_KEY/);
  expect(await f.snapshot()).toEqual(replayed);
  expect(await f.prompt(await f.session(), text, "ACP_FRESH_KEY")).not.toHaveProperty("error");
  const fresh = await f.snapshot();
  expect(fresh.requests).toHaveLength(2);
  expect(fresh.runs).toHaveLength(2);
  expect(fresh.admissions).toHaveLength(2);
  expect(new Set(fresh.requests.map((r) => r.id)).size).toBe(2);
  expect(new Set(fresh.runs).size).toBe(2);
  await f.auth.credentials.revoke(f.owner.credentialId);
  const denied = await f.prompt(await f.session(), text);
  expect(denied).toHaveProperty("error");
  expect(await f.snapshot()).toEqual(fresh); // Trusted stores, never a denied caller's empty view.
});

it("#331 keyed ACP direct launch and selected-workflow prose explicitly direct the caller to runs.admit without admission", async () => {
  const f = await fixture();
  const sessionId = await f.session();
  const before = await f.snapshot();
  const direct = await f.prompt(sessionId, "/run program");
  expect(direct).toMatchObject({
    error: { code: -32602, data: { reason: expect.stringContaining("use runs.admit") } },
  });
  expect(await f.snapshot()).toEqual(before);
  const selected = await f.wire("session/set_config_option", {
    sessionId,
    configId: "orca/workflow",
    value: "program",
  });
  expect(selected).not.toHaveProperty("error");
  expect(await f.prompt(sessionId, "New direct work")).toMatchObject({
    error: { code: -32602, data: { reason: expect.stringContaining("unsupported") } },
  });
  expect(await f.snapshot()).toEqual(before);
});
