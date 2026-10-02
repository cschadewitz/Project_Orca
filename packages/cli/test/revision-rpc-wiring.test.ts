/** CLI revision parser and real authenticated HTTP composition; fake wire servers test transport failures only. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrcaError, parseOrcaConfig, silentLogger } from "@orca/core";
import { createRevisionInputServices, createRevisionRuntime, PausingHumanInput } from "@orca/engine";
import { ControlModel, ReadModel, openAuthDirectory, orchestratorResolver, startDaemon } from "@orca/daemon";
import {
  PROTOCOL_VERSION,
  RevisionResultSchema,
  type PendingRevisionView,
  type RevisionBoundaryView,
  type RevisionCommand,
} from "@orca/protocol";
import { bootstrap } from "../src/bootstrap.js";
import type { CommandContext } from "../src/commands/index.js";
import { revisionsCommand } from "../src/commands/revisions.js";
import { main } from "../src/main.js";

const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  vi.stubEnv("ORCA_DAEMON_URL", undefined);
  vi.stubEnv("ORCA_DAEMON_TOKEN", undefined);
  vi.stubEnv("ORCA_DAEMON_TOKEN_FILE", undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "orca-revision-cli-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function context(cwd: string, positionals: string[], flags: CommandContext["flags"] = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    cwd,
    positionals,
    flags,
    lines,
    errors,
    out: (line: string) => void lines.push(line),
    err: (line: string) => void errors.push(line),
  };
}
const command: RevisionCommand = {
  target: {
    runId: "owned",
    stepRunId: "step",
    requestId: "request",
    destinationId: "destination",
    expectedRevision: "v1",
  },
  actionId: "changes",
  payload: { kind: "text", text: "PRIVATE CORRECTION" },
};
const methods = ["hello", "inputs.list", "inputs.revise", "inputs.revisionPending", "inputs.replaceRevision"];
const hello = {
  identity: { workspaceId: randomUUID(), instanceId: randomUUID() },
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  capabilities: ["runs.read", "inputs.revise", "inputs.revisionPending", "inputs.replaceRevision"],
  methods,
};
const resolved = {
  state: "resolved",
  operationId: `retry_${randomUUID()}`,
  replayed: false,
  result: {
    revisionId: "revision",
    target: command.target,
    state: "pending",
    attemptId: "attempt",
    currentRevisionId: "revision",
    expectedRevision: "v2",
  },
};
interface WireRequest {
  id: string;
  method: string;
  params: unknown;
}
async function wire(respond: (request: WireRequest, response: ServerResponse) => void | Promise<void>) {
  const requests: WireRequest[] = [];
  const authorizations: (string | undefined)[] = [];
  const urls: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const value = JSON.parse(body) as WireRequest;
      requests.push(value);
      authorizations.push(request.headers.authorization);
      urls.push(request.url);
      void Promise.resolve(respond(value, response)).catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test HTTP address");
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, authorizations, urls };
}
function reply(response: ServerResponse, request: WireRequest, result: unknown) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ kind: "response", id: request.id, ok: true, result }));
}
async function inputFile(dir: string, input: unknown = command) {
  const file = `${randomUUID()}.json`;
  await writeFile(join(dir, file), JSON.stringify(input));
  return file;
}
async function wireContext(endpoint: string, input: unknown = command, action = "submit") {
  const dir = await temp();
  vi.stubEnv("ORCA_DAEMON_TOKEN", "explicit-test-credential");
  return context(dir, [action], {
    endpoint,
    "body-file": await inputFile(dir, input),
    ...(action === "inspect" ? {} : { "idempotency-key": "retained-key" }),
  });
}

/** The production bootstrap, protected stores, registered claims, authority, and daemon methods are real. */
async function production() {
  const dir = await temp();
  await writeFile(
    join(dir, "revise.yaml"),
    `
id: revise
name: Revise
version: '1'
start: start
nodes:
  start: {type: start}
  gate:
    type: gate
    question: Continue?
    options: [changes, done]
    revision:
      actionId: changes
      destinationNodeId: agent
      payload: {kind: text, maxBytes: 65536}
      composition: replace-revision-slot
  agent: {type: agent, agent: worker, prompt: Original}
  end: {type: end}
edges:
  - {from: start, to: gate}
  - {from: gate, to: agent, when: "choice == 'changes'"}
  - {from: gate, to: end, when: "choice == 'done'"}
  - {from: agent, to: end}
`,
  );
  let runtime: ReturnType<typeof createRevisionRuntime> | undefined;
  const delivery = vi.fn(async () => {
    throw new Error("Execution is not authorized by this test");
  });
  const app = await bootstrap({
    configDir: dir,
    config: parseOrcaConfig({
      workflows: ["*.yaml"],
      templates: [],
      agents: [{ id: "worker", command: process.execPath }],
    }),
    logger: silentLogger,
    humanInput: new PausingHumanInput(),
    revisionRuntime: (stores) => {
      runtime = createRevisionRuntime({ stores, authorizeExecution: delivery });
      return runtime.runtime;
    },
  });
  const auth = openAuthDirectory(join(dir, "auth"));
  const issue = (principal: string, permissions: ("runs.read" | "inputs.answer" | "runs.control")[]) =>
    auth.credentials.issue({ principal, permissions, scope: { workflows: ["revise"], runs: "owned" } });
  const writer = await issue("alice", ["runs.read", "inputs.answer", "runs.control"]);
  const reader = await issue("alice", ["runs.read"]);
  const other = await issue("bob", ["runs.read", "inputs.answer", "runs.control"]);
  const launch = await app.generations.captureLaunch({ purpose: "workflow", workflowId: "revise" });
  const runId = await launch.startRun({ actor: { principalId: "alice", credentialId: writer.credential.id } });
  auth.ownership.record(runId, "alice");
  await auth.ownership.flush(runId);
  expect((await app.orchestrator.run(runId)).run.status).toBe("paused");
  const services = createRevisionInputServices({
    journal: runtime!.journal,
    retries: app.retryClaims!,
    stale: () => new OrcaError("REVISION_STALE", "stale"),
  });
  services.register(app.retryClaims!);
  const reads = new ReadModel({ orchestrator: app.orchestrator });
  const daemon = await startDaemon({
    orcaVersion: "test",
    workspaceId: randomUUID(),
    capabilities: ["runs.read", "runs.control"],
    reads,
    control: new ControlModel({ orchestrator: app.orchestrator, reads }),
    source: app.orchestrator,
    revisionSources: { services, readBoundaries: runtime!.readBoundaries },
    auth: {
      mode: "token",
      credentials: auth.credentials,
      ownership: auth.ownership,
      resolver: orchestratorResolver(app.orchestrator),
    },
  });
  cleanups.push(() => daemon.close());
  const invoke = async (action: string, body?: unknown, key?: string, token = writer.token, endpoint = daemon.url) => {
    vi.stubEnv("ORCA_DAEMON_TOKEN", token);
    const ctx = context(dir, action === "discover" ? [action, runId] : [action], {
      endpoint,
      ...(body ? { "body-file": await inputFile(dir, body) } : {}),
      ...(key === undefined ? {} : { "idempotency-key": key }),
    });
    const code = await revisionsCommand(ctx);
    return { code, data: JSON.parse(ctx.lines[0]!) as unknown, text: ctx.lines.join("\n") };
  };
  return { dir, app, auth, writer, reader, other, daemon, runId, invoke, delivery };
}

describe("real authenticated revision command composition", () => {
  it("discovers, submits, replays, inspects and replaces through protected production services without resuming", async () => {
    const f = await production();
    const discovery = await f.invoke("discover");
    const boundary = (discovery.data as { boundaries: RevisionBoundaryView[] }).boundaries[0]!;
    expect(boundary.target.runId).toBe(f.runId);
    expect(boundary.capability.payload).toEqual({ kind: "text", maxBytes: 65536 });
    const submission = { ...command, target: boundary.target };
    const first = RevisionResultSchema.parse((await f.invoke("submit", submission, " retained key ")).data);
    if (first.state !== "resolved") throw new Error("Expected durable revision receipt");
    expect(first.replayed).toBe(false);
    expect((await f.invoke("submit", submission, " retained key ")).data).toEqual({ ...first, replayed: true });
    await expect(
      f.invoke("submit", { ...submission, payload: { kind: "text", text: "different" } }, " retained key "),
    ).rejects.toMatchObject({ code: "RETRY_CONFLICT" });
    const target = {
      runId: f.runId,
      revisionId: first.result.revisionId,
      destinationId: first.result.target.destinationId,
      attemptId: first.result.attemptId,
    };
    expect((await f.invoke("inspect", target)).data).toMatchObject({
      payload: command.payload,
      replacementAllowed: true,
    });
    const metadata = await f.invoke("discover");
    expect(metadata.data).toMatchObject({
      boundaries: [],
      pendingRevisions: { items: [{ target }], incomplete: false },
    });
    expect(metadata.text).not.toContain("PRIVATE CORRECTION");
    const replacement = {
      target,
      expectedRevision: first.result.expectedRevision,
      payload: { kind: "text", text: "PRIVATE REPLACEMENT" },
    };
    const changed = RevisionResultSchema.parse((await f.invoke("replace", replacement, "replacement-key")).data);
    if (changed.state !== "resolved") throw new Error("Expected durable replacement receipt");
    expect(changed.result.revisionId).not.toBe(first.result.revisionId);
    expect((await f.invoke("replace", replacement, "replacement-key")).data).toEqual({ ...changed, replayed: true });
    const current = { ...target, revisionId: changed.result.revisionId };
    expect((await f.invoke("inspect", current)).data).toMatchObject({ payload: replacement.payload });
    const readOnly = (await f.invoke("inspect", current, undefined, f.reader.token)).data as PendingRevisionView;
    expect(readOnly).not.toHaveProperty("payload");
    expect(readOnly.replacementAllowed).toBe(false);
    await expect(f.invoke("submit", submission, "denied-key", f.reader.token)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
    await expect(f.invoke("inspect", current, undefined, f.other.token)).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    await f.auth.credentials.revoke(f.writer.credential.id);
    await expect(f.invoke("inspect", current)).rejects.toMatchObject({ code: "AUTH_INVALID" });
    expect(JSON.stringify(await f.app.orchestrator.stores.events.read(f.runId))).not.toContain("PRIVATE");
    expect((await f.app.orchestrator.getState(f.runId))?.run.status).toBe("paused");
    expect(f.delivery).not.toHaveBeenCalled();
  });

  it("does not automatically repeat a committed mutation after response loss; an explicit same-key retry replays it", async () => {
    const f = await production();
    const discovery = (await f.invoke("discover")).data as { boundaries: RevisionBoundaryView[] };
    const submission = { ...command, target: discovery.boundaries[0]!.target };
    let drop = true;
    const proxy = await wire(async (request, response) => {
      const forwarded = await fetch(`${f.daemon.url}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.writer.token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "request", ...request }),
      });
      const body = await forwarded.text();
      if (request.method === "inputs.revise" && drop) {
        drop = false;
        response.destroy();
      } else {
        response.writeHead(forwarded.status);
        response.end(body);
      }
    });
    await expect(
      f.invoke("submit", submission, "retain-after-loss", f.writer.token, proxy.endpoint),
    ).rejects.toMatchObject({ code: "AGENT_TRANSPORT", details: { uncertain: true, recovery: "inspect-or-retry" } });
    expect(proxy.requests.filter((request) => request.method === "inputs.revise")).toHaveLength(1);
    expect((await f.invoke("discover")).data).toMatchObject({ pendingRevisions: { items: [{ state: "pending" }] } });
    const replay = RevisionResultSchema.parse(
      (await f.invoke("submit", submission, "retain-after-loss", f.writer.token, proxy.endpoint)).data,
    );
    expect(replay).toMatchObject({ state: "resolved", replayed: true });
    expect(proxy.requests.filter((request) => request.method === "inputs.revise")).toHaveLength(2);
    expect(f.delivery).not.toHaveBeenCalled();
  });
});

describe("closed revision wire boundary", () => {
  it("the actual parser preserves the full 64 KiB payload and exact key, captures the named credential once, and emits only the receipt", async () => {
    vi.stubEnv("REVISION_TEST_TOKEN", "first-credential");
    const server = await wire((request, response) => {
      if (request.method === "hello") {
        vi.stubEnv("REVISION_TEST_TOKEN", "changed-credential");
        reply(response, request, hello);
      } else reply(response, request, resolved);
    });
    const dir = await temp();
    const large = { ...command, payload: { kind: "text", text: "x".repeat(65536) } };
    const file = await inputFile(dir, large);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await main([
        "revisions",
        "submit",
        "--cwd",
        dir,
        "--endpoint",
        server.endpoint,
        "--token-env",
        "REVISION_TEST_TOKEN",
        "--body-file",
        file,
        "--idempotency-key",
        " retained key ",
      ]),
    ).toBe(0);
    expect(server.requests.map((request) => request.method)).toEqual(["hello", "inputs.revise"]);
    expect(server.requests[0]!.params).toMatchObject({ protocol: { major: 2, minor: 0 } });
    expect(server.requests[1]!.params).toEqual({ command: large, retry: { idempotencyKey: " retained key " } });
    expect(server.authorizations).toEqual(["Bearer first-credential", "Bearer first-credential"]);
    expect(server.urls).toEqual(["/rpc", "/rpc"]);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout.mock.calls.flat().join("")).not.toMatch(/retained key|first-credential|changed-credential|x{100}/);
  });

  it("uses explicit exact-run discovery and omits ordinary input context and descendant boundaries", async () => {
    const server = await wire((request, response) =>
      reply(
        response,
        request,
        request.method === "hello"
          ? hello
          : {
              inputs: ["owned", "child"].map((runId) => ({
                id: "ask",
                kind: "decision",
                question: "PRIVATE QUESTION",
                options: [],
                context: { secret: "PRIVATE CONTEXT" },
                runId,
                runName: "run",
                stepRunId: "step",
                requestedAt: "now",
                waitingMs: 0,
                artifacts: [],
                revision: {
                  target: { ...command.target, runId },
                  capability: {
                    actionId: "changes",
                    destinationNodeId: "agent",
                    composition: "replace-revision-slot",
                    payload: { kind: "text", maxBytes: 65536 },
                  },
                  destinationDescription: "agent",
                },
              })),
              waiting: 2,
              pendingRevisions: { items: [], incomplete: true, reason: "boundary-unavailable" },
              asOf: "now",
            },
      ),
    );
    vi.stubEnv("ORCA_DAEMON_URL", server.endpoint);
    vi.stubEnv("ORCA_DAEMON_TOKEN", "explicit");
    const ctx = context(await temp(), ["discover", "owned"]);
    expect(await revisionsCommand(ctx)).toBe(0);
    expect(server.requests[1]!.params).toEqual({ runId: "owned", revisionRunIds: ["owned"] });
    expect(ctx.lines.join("\n")).not.toMatch(/PRIVATE|child/);
    expect(JSON.parse(ctx.lines[0]!)).toMatchObject({
      pendingRevisions: { incomplete: true, reason: "boundary-unavailable" },
    });
  });

  it.each([
    "http://remote.example/rpc",
    "ftp://127.0.0.1/rpc",
    "https://user:secret@example.com",
    "https://example.com/?secret=value",
    "https://example.com/#secret",
    "https://example.com/other",
  ])("rejects unsafe endpoints before network: %s", async (endpoint) => {
    const request = vi.spyOn(globalThis, "fetch");
    const ctx = await wireContext(endpoint);
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(request).not.toHaveBeenCalled();
  });

  it("requires an explicit endpoint and named environment credential without falling back to a token file or owner", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    const dir = await temp();
    const tokenFile = join(dir, "local-client.token");
    await writeFile(tokenFile, "DO NOT READ THIS TOKEN");
    vi.stubEnv("ORCA_DAEMON_TOKEN_FILE", tokenFile);
    for (const flags of [{}, { endpoint: "http://127.0.0.1:6722" }]) {
      await expect(revisionsCommand(context(dir, ["discover", "owned"], flags))).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
    }
    vi.stubEnv("ORCA_DAEMON_TOKEN", "malformed credential");
    await expect(
      revisionsCommand(context(dir, ["discover", "owned"], { endpoint: "http://127.0.0.1:6722" })),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   ", "x".repeat(129)])(
    "rejects absent/empty/oversized mutation keys before even hello",
    async (key) => {
      const request = vi.spyOn(globalThis, "fetch");
      const ctx = await wireContext("http://127.0.0.1:6722");
      ctx.flags["idempotency-key"] = key;
      await expect(revisionsCommand(ctx)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...command, extra: "PRIVATE" },
    { ...command, target: { ...command.target, inferred: true } },
    { ...command, target: { runId: "owned" } },
    { ...command, payload: { kind: "text", text: "x".repeat(65537) } },
    { ...command, payload: { kind: "text", text: "fix", extra: true } },
  ])("rejects non-strict or oversized command JSON without diagnostics that echo it", async (input) => {
    const request = vi.spyOn(globalThis, "fetch");
    const ctx = await wireContext("http://127.0.0.1:6722", input);
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "Revision JSON does not match the strict command schema",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds file reads and sanitizes malformed JSON, invalid UTF-8, missing paths, directories and unrelated flags", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    const ctx = await wireContext("http://127.0.0.1:6722");
    for (const contents of ["PRIVATE invalid JSON", " ".repeat(256 * 1024 + 1), Buffer.from([0xff])]) {
      await writeFile(join(ctx.cwd, "PRIVATE-PATH"), contents);
      ctx.flags["body-file"] = "PRIVATE-PATH";
      await expect(revisionsCommand(ctx)).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: "Revision body must be a readable JSON file no larger than 256 KiB",
      });
    }
    for (const file of ["PRIVATE-MISSING", "."]) {
      ctx.flags["body-file"] = file;
      await expect(revisionsCommand(ctx)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    ctx.flags["body-file"] = await inputFile(ctx.cwd);
    for (const name of ["body", "host", "port", "no-resume", "config", "unauthenticated-loopback"]) {
      const bad = { ...ctx, flags: { ...ctx.flags, [name]: "PRIVATE" } };
      await expect(revisionsCommand(bad)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["version", "missing-identity", "unsupported"])("fails negotiation before mutation: %s", async (kind) => {
    const changed = {
      ...hello,
      ...(kind === "version"
        ? { protocol: { major: 1, minor: 10 } }
        : kind === "missing-identity"
          ? { identity: undefined }
          : { methods: ["hello", "inputs.list"] }),
    };
    const server = await wire((request, response) => reply(response, request, changed));
    const ctx = await wireContext(server.endpoint);
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({
      code: kind === "version" ? "PROTOCOL_VERSION" : "NOT_SUPPORTED",
    });
    expect(server.requests.map((request) => request.method)).toEqual(["hello"]);
  });

  it.each([401, 403])("fails HTTP %s without retry or diagnostic disclosure", async (status) => {
    const server = await wire((_request, response) => {
      response.writeHead(status);
      response.end("PRIVATE TOKEN AND PATH");
    });
    const ctx = await wireContext(server.endpoint);
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({
      code: status === 401 ? "AUTH_INVALID" : "AUTH_FORBIDDEN",
    });
    expect(server.requests).toHaveLength(1);
  });

  it.each(["hello", "inputs.revise"])("never follows redirects from %s", async (method) => {
    const server = await wire((request, response) => {
      if (request.method === method) {
        response.writeHead(302, { location: "/login?credential=PRIVATE" });
        response.end();
      } else reply(response, request, hello);
    });
    const ctx = await wireContext(server.endpoint);
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
    expect(server.urls).toEqual(method === "hello" ? ["/rpc"] : ["/rpc", "/rpc"]);
  });

  it.each(["oversized", "malformed", "wrong-id", "invalid-result", "interrupted"])(
    "fails a %s mutation response as uncertain with no repeat",
    async (kind) => {
      const server = await wire((request, response) => {
        if (request.method === "hello") return reply(response, request, hello);
        if (kind === "oversized") {
          response.write(" ".repeat(128 * 1024));
          response.end(" ".repeat(128 * 1024 + 1));
        } else if (kind === "interrupted") {
          response.writeHead(200, { "content-length": 2000 });
          response.write("{");
          setTimeout(() => response.destroy(), 10);
        } else if (kind === "wrong-id") reply(response, { ...request, id: "wrong" }, resolved);
        else if (kind === "invalid-result") reply(response, request, { private: "PRIVATE" });
        else response.end("PRIVATE MALFORMED RESPONSE");
      });
      const ctx = await wireContext(server.endpoint);
      await expect(revisionsCommand(ctx)).rejects.toMatchObject({
        code: "PROTOCOL_MESSAGE",
        details: { uncertain: true, recovery: "inspect-or-retry" },
      });
      expect(server.requests.map((request) => request.method)).toEqual(["hello", "inputs.revise"]);
      expect(ctx.lines).toEqual([]);
    },
  );

  it("keeps a bounded timeout for a stalled response without retrying", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const signal = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementationOnce(() => timeout(5000))
      .mockImplementation(() => timeout(250));
    const server = await wire((request, response) => {
      if (request.method === "hello") reply(response, request, hello);
    });
    const ctx = await wireContext(server.endpoint);
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      details: { uncertain: true },
    });
    expect(signal).toHaveBeenCalledWith(15000);
    expect(server.requests).toHaveLength(2);
  });

  it("retains only safe original operation/recovery/uncertain correlation from a guard refusal", async () => {
    const operationId = `retry_${randomUUID()}`;
    const server = await wire((request, response) => {
      if (request.method === "hello") return reply(response, request, hello);
      response.end(
        JSON.stringify({
          kind: "response",
          id: request.id,
          ok: false,
          error: {
            code: "RUN_STATE",
            message: "PRIVATE PATH TOKEN BODY",
            details: {
              operationId,
              recovery: "inspect-or-retry",
              uncertain: true,
              reason: "revision-publication-uncertain",
              path: "/PRIVATE",
              token: "PRIVATE",
              body: command,
              idempotencyKey: "retained-key",
            },
          },
        }),
      );
    });
    const ctx = await wireContext(server.endpoint);
    let error: unknown;
    try {
      await revisionsCommand(ctx);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "RUN_STATE",
      details: { operationId, recovery: "inspect-or-retry", uncertain: true, reason: "revision-publication-uncertain" },
    });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|retained-key|target|credential/);
    expect(server.requests).toHaveLength(2);
  });

  it("prints an in-progress operation receipt without retrying or inventing a new key", async () => {
    const server = await wire((request, response) =>
      reply(
        response,
        request,
        request.method === "hello"
          ? hello
          : { state: "in-progress", operationId: "retry-operation", recovery: "inspect-or-retry" },
      ),
    );
    const ctx = await wireContext(server.endpoint);
    expect(await revisionsCommand(ctx)).toBe(1);
    expect(JSON.parse(ctx.lines[0]!)).toEqual({
      state: "in-progress",
      operationId: "retry-operation",
      recovery: "inspect-or-retry",
    });
    expect(server.requests).toHaveLength(2);
  });

  it.each(["inspect", "replace"])(
    "requires the exact unwrapped %s schema and refuses supplied identity fields before network",
    async (action) => {
      const request = vi.spyOn(globalThis, "fetch");
      const target = { runId: "owned", revisionId: "revision", destinationId: "destination", attemptId: "attempt" };
      const valid =
        action === "inspect" ? target : { target, expectedRevision: "v2", payload: { kind: "text", text: "fix" } };
      for (const input of [{ ...valid, actor: { principalId: "owner" } }, { command: valid }, {}]) {
        const ctx = await wireContext("http://127.0.0.1:6722", input, action);
        await expect(revisionsCommand(ctx)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      }
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("negotiates installed methods instead of trusting a revision capability claim", async () => {
    const server = await wire((request, response) => reply(response, request, { ...hello, methods: ["hello"] }));
    const ctx = await wireContext(server.endpoint);
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(server.requests).toHaveLength(1);
  });

  it("does not manufacture empty revision discovery when the server has no projection", async () => {
    const server = await wire((request, response) =>
      reply(response, request, request.method === "hello" ? hello : { inputs: [], waiting: 0, asOf: "now" }),
    );
    vi.stubEnv("ORCA_DAEMON_TOKEN", "explicit");
    const ctx = context(await temp(), ["discover", "owned"], { endpoint: server.endpoint });
    await expect(revisionsCommand(ctx)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(ctx.lines).toEqual([]);
  });

  it("drops arbitrary error codes and unsafe correlation while retaining the safe recovery hint", async () => {
    const server = await wire((request, response) => {
      if (request.method === "hello") return reply(response, request, hello);
      response.end(
        JSON.stringify({
          kind: "response",
          id: request.id,
          ok: false,
          error: {
            code: "PRIVATE-CREDENTIAL",
            message: "PRIVATE-BODY",
            details: { operationId: "/PRIVATE-PATH", reason: "PRIVATE-REASON", recovery: "inspect-or-retry" },
          },
        }),
      );
    });
    const ctx = await wireContext(server.endpoint);
    let error: unknown;
    try {
      await revisionsCommand(ctx);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "PROTOCOL_MESSAGE", details: { recovery: "inspect-or-retry" } });
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  });
});
