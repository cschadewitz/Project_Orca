/**
 * Secret references in a run (#336): the session factory is given the secrets catalog, and a
 * value a session read never reaches the run's events, its stored inputs, its artifacts or its
 * log.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import {
  parseDeliverablesBlock,
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  TemplateRegistry,
  WorkflowRegistry,
  type Logger,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { fileStores, memoryStores, type Stores } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const VALUE = "ghp_value-that-must-not-be-written-0123";

const parent = `
id: parent
name: Parent
start: s
nodes:
  s: { type: start }
  inner:
    type: loop
    mode: until
    condition: 'true'
    maxIterations: 1
    body:
      graph:
        start: a
        nodes:
          a: { type: start }
          work: { type: agent, agent: { role: coder }, prompt: "do it" }
          z: { type: end }
        edges: [{ from: a, to: work }, { from: work, to: z }]
  e: { type: end }
edges: [{ from: s, to: inner }, { from: inner, to: e }]
`;

const single = `
id: single
name: Single
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: { role: coder }, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

const producing = `
id: producing
name: Producing
start: s
nodes:
  s: { type: start }
  work:
    type: agent
    agent: { role: coder }
    prompt: "do it"
    produces: [{ kind: report, name: report, path: report.md }]
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

type SecretUseCheck = NonNullable<ConstructorParameters<typeof Orchestrator>[0]["secretUse"]>;

function setup(
  workflow: string,
  opts: { stores?: Stores; cwd?: string; deliver?: string; secretUse?: SecretUseCheck | "none" } = {},
) {
  const config = parseOrcaConfig({
    secrets: { token: { host: "local", provider: "env", name: "ORCA_TOKEN" } },
    agents: [{ id: "claude", command: "unused", roles: ["coder"], env: { TOKEN: { secret: "token" } } }],
  });
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(workflow));
  const stores = opts.stores ?? memoryStores();
  const lines: string[] = [];
  const record = (m: string, f?: object) => lines.push(`${m} ${JSON.stringify(f ?? {})}`);
  const logger: Logger = {
    log: (_l, m, f) => record(m, f),
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
  };
  const given: OpenSessionOptions[] = [];
  const orchestrator = new Orchestrator({
    stores,
    logger,
    agents: AgentRegistry.fromConfig(config),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(opts.cwd ?? process.cwd()),
    ...(opts.secretUse === "none" ? {} : { secretUse: opts.secretUse ?? (async () => {}) }),
    sessionFactory: async (o: OpenSessionOptions) => {
      given.push(o);
      // What openAcpSession does: ask the use check, then read the reference on the host.
      if (!o.authorizeSecretUse) throw new Error("no use check was passed");
      await o.authorizeSecretUse([{ secret: "token", provider: "env", hostId: o.host.id, agentId: o.agent.id }]);
      o.onSecretValues?.([VALUE]);
      o.logger?.info(`agent started with ${VALUE}`);
      let close!: () => void;
      const closed = new Promise<void>((r) => (close = r));
      const session: AgentSession = {
        id: "sess_1",
        agentId: o.agent.id,
        hostId: o.host.id,
        cwd: o.cwd,
        acpSessionId: "acp",
        closed,
        terminated: closed,
        configOptions: [],
        setConfigOption: async () => [],
        // An agent that writes its credential into a deliverable, or echoes it into an error.
        prompt: async (input) => {
          if (opts.deliver !== undefined) {
            const path = parseDeliverablesBlock(input as string)[0]!.path;
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, opts.deliver);
            return { stopReason: "end_turn" as const, durationMs: 1 };
          }
          throw new Error(`upstream rejected token ${VALUE} (401)`);
        },
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => close(),
      };
      return session;
    },
  });
  return { orchestrator, stores, lines, given };
}

async function everything(stores: Stores, runIds: string[]) {
  const out: unknown[] = [];
  for (const id of runIds) {
    out.push(await stores.events.read(id));
    out.push(await stores.execution.getInputs(id));
    out.push(await stores.artifacts.list({ runId: id }));
  }
  return JSON.stringify(out);
}

describe("secret references in a run", () => {
  it("hands the session factory the catalog, and keeps the value out of events, stored inputs and logs", async () => {
    const { orchestrator, stores, lines, given } = setup(single);
    const { run } = await orchestrator.startAndRun({ workflowId: "single" });
    expect(run.status).toBe("failed");
    expect(given[0]!.secrets).toEqual({ token: { host: "local", provider: "env", name: "ORCA_TOKEN" } });
    // The reference reaches the factory as a reference: resolving it is the host's job.
    expect(given[0]!.agent.env).toEqual({ TOKEN: { secret: "token" } });
    const written = await everything(stores, [run.id]);
    expect(written).not.toContain(VALUE);
    expect(written).toContain("upstream rejected token [REDACTED] (401)");
    expect(lines.join("\n")).not.toContain(VALUE);
  });

  it("redacts a child run's value from its parent's log too", async () => {
    const { orchestrator, stores, lines } = setup(parent);
    const { run } = await orchestrator.startAndRun({ workflowId: "parent" });
    expect(run.status).toBe("failed");
    const children = (await stores.events.read(run.id))
      .filter((e) => e.type === "child.spawned")
      .map((e) => (e.payload as { childRunId: string }).childRunId);
    expect(children.length).toBe(1);
    const written = await everything(stores, [run.id, ...children]);
    expect(written).not.toContain(VALUE);
    expect(lines.join("\n")).not.toContain(VALUE);
  });

  it("stores an artifact the agent wrote with the value already replaced, digest and size included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-secrets-art-"));
    dirs.push(dir);
    const storeDir = join(dir, "store");
    const work = join(dir, "work");
    await mkdir(work);
    const body = `---\nstatus: done\ntoken: ${VALUE}\n---\nUsed ${VALUE} to call the API – done.\n`;
    const { orchestrator, stores } = setup(producing, { stores: fileStores(storeDir), cwd: work, deliver: body });
    const intake = vi.spyOn(orchestrator.plan, "onArtifactRecorded");
    const { run } = await orchestrator.startAndRun({ workflowId: "producing" });
    // Planning takes the artifact as stored, so nothing it journals can carry the value.
    expect(intake).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(intake.mock.calls[0]![1])).not.toContain(VALUE);
    expect(run.status, JSON.stringify(run.error)).toBe("completed");
    const expected = body.split(VALUE).join("[REDACTED]");

    const [artifact] = await stores.artifacts.list({ runId: run.id });
    expect(artifact).toMatchObject({
      contentHash: expect.any(String),
      size: Buffer.byteLength(expected, "utf8"),
      // Structured data is extracted from the stored text, so it never disagrees with it (in
      // YAML front matter the unquoted placeholder reads as a one-item list).
      data: { status: "done", token: ["REDACTED"] },
    });
    expect(await stores.artifacts.content(artifact!.id)).toBe(expected);
    expect(artifact!.contentHash).toContain(createHash("sha256").update(expected).digest("hex"));

    // A restarted daemon reads the same redacted bytes: nothing on disk ever held the value.
    const reopened = fileStores(storeDir);
    expect(Buffer.from(await reopened.artifacts.bytes(artifact!.id)).toString("utf8")).toBe(expected);
    const files = await readdir(storeDir, { recursive: true, withFileTypes: true });
    for (const f of files.filter((e) => e.isFile()))
      expect(await readFile(join(f.parentPath, f.name), "utf8"), f.name).not.toContain(VALUE);
    expect(await everything(reopened, [run.id])).not.toContain(VALUE);
  });

  it("refuses a launch that would use a secret when the daemon has no use check", async () => {
    const { orchestrator, stores, given } = setup(single, { secretUse: "none" });
    await expect(orchestrator.startAndRun({ workflowId: "single" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: { nodeId: "work", agentId: "claude", secrets: ["token"], reason: "unauthorized" },
    });
    expect(given).toEqual([]);
    expect(await stores.events.listRuns()).toEqual([]);
  });

  it("asks the use check for the run at every open, and a denial fails the step before anything is read", async () => {
    const asked: { runId: string; uses: unknown[] }[] = [];
    const { orchestrator, stores } = setup(single, {
      secretUse: async (request) => {
        asked.push(request);
        throw new OrcaError("CONFIG_INVALID", "use of secret 'token' is not granted to this run");
      },
    });
    const { run } = await orchestrator.startAndRun({ workflowId: "single" });
    expect(run.status).toBe("failed");
    expect(asked).toEqual([
      { runId: run.id, uses: [{ secret: "token", provider: "env", hostId: "local", agentId: "claude" }] },
    ]);
    const written = await everything(stores, [run.id]);
    expect(written).toContain("is not granted to this run");
    expect(written).not.toContain(VALUE);
  });
});
