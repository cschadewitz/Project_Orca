/**
 * #357 phase 2: checkpoint attempts through retry-safe admission. A replayed key returns the
 * same attempt and starts nothing; a refused recovery publishes no claim; the attempt keeps
 * its source's sensitivity and runs under the bounded first-attachment policy.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
} from "@orca/core";
import { FileExecutionStore, memoryStores } from "@orca/store";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";
import { ConfigurationGenerations } from "../src/configuration-generation.js";
import {
  builtinExecutors,
  CheckpointAdmissionService,
  checkpointAttempts,
  completed,
  failed,
  LocalWorkspaceProvider,
  Orchestrator,
  type CheckpointAdmissionAuthority,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const definition = parseWorkflow(`
id: flow
name: Flow
version: "1"
inputSchema:
  unknown: allow
  fields:
    token: { type: string, sensitive: true }
start: s
nodes:
  s: { type: start }
  a: { type: set, vars: { reached: a } }
  b: { type: "custom:once" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: a }, { from: a, to: b }, { from: b, to: e }]
`);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-checkpoint-admission-"));
  dirs.push(dir);
  const stores = memoryStores();
  let failures = 1;
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    // Fails (stating it did nothing outside ORCA) until `failures` is spent.
    executors: builtinExecutors().register({
      type: "custom:once",
      execute: async () => (failures-- > 0 ? failed("ONCE", "not yet", {}, false, "none") : completed()),
    }),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    logger: silentLogger,
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: orc.workflows.list(), templates: [] }),
    admission: {
      validateStartRun: (opts, material) => orc.validateStartRun(opts, material),
      startRun: (opts, material) => orc.startRun(opts, material),
    },
  });
  await generations.initialize(
    parseOrcaConfig({ agents: [], program: { workflow: "flow", itemWorkflow: "flow" } }),
    "t",
  );
  orc.generations = generations;
  const actor = { principalId: "owner", credentialId: "credential-test" };
  const authority: CheckpointAdmissionAuthority = {
    workspaceId: "workspace-test",
    actor,
    authorize: async () => {},
    onRunAdmitted: async (runId) => {
      if ((await stores.execution.getGeneration(`owner:${runId}`)) === undefined)
        await stores.execution.putGeneration(`owner:${runId}`, { principalId: "owner" });
    },
    verifyRunAdmitted: async (runId) => {
      if ((await stores.execution.getGeneration(`owner:${runId}`)) === undefined)
        throw new OrcaError("RUN_STATE", "ownership unavailable");
    },
  };
  orc.admissionExecution = { authorize: async (policy) => authority.verifyRunAdmitted!(policy.binding.runId) };
  const faults = {
    conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
    limit: () => new OrcaError("RETRY_LIMIT", "limit"),
  };
  const claims = new RegisteredRetryClaims(
    new FileRetryClaimStore({ storeDir: dir, execution: new FileExecutionStore(dir), faults }),
    faults,
  );
  const service = new CheckpointAdmissionService({ orchestrator: orc, retries: claims });
  const source = await orc.startAndRun({ workflowId: "flow", vars: { token: "secret-token-1" }, actor });
  expect(source.run.status).toBe("failed");
  return { orc, stores, service, authority, source };
}

it("admits one attempt per key, pinned and protected like its source, and drives it once", async () => {
  const f = await fixture();
  const first = await f.service.startAttempt({ runId: f.source.run.id }, { idempotencyKey: "k1" }, f.authority);
  if (first.state !== "resolved" || first.result.state !== "accepted") throw new Error(JSON.stringify(first));
  const attemptId = first.result.runId;
  expect(first.result.sourceRunId).toBe(f.source.run.id);

  // Created, not driven; the same key returns the same attempt and creates nothing.
  expect((await f.orc.getState(attemptId)).run.status).toBe("created");
  const runs = (await f.orc.listRuns()).length;
  expect(await f.service.startAttempt({ runId: f.source.run.id }, { idempotencyKey: "k1" }, f.authority)).toEqual({
    ...first,
    replayed: true,
  });
  expect(await f.orc.listRuns()).toHaveLength(runs);
  // The same key for a different intent is a conflict, not a second attempt.
  await expect(
    f.service.startAttempt({ runId: f.source.run.id, checkpoint: "s" }, { idempotencyKey: "k1" }, f.authority),
  ).rejects.toMatchObject({ code: "RETRY_CONFLICT" });
  // A new key while this attempt has not finished is refused: attempts share the workspace.
  await expect(
    f.service.startAttempt({ runId: f.source.run.id }, { idempotencyKey: "k2" }, f.authority),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
  expect((await checkpointAttempts(f.stores, f.source.run.id)).map((a) => a.runId)).toEqual([attemptId]);

  // Pinned to the source's generation and workflow, and its sensitive input stays private.
  const attempt = await f.orc.getState(attemptId);
  expect(attempt.run.provenance?.configGeneration).toBe(f.source.run.provenance?.configGeneration);
  expect(attempt.run.provenance?.workflow).toEqual(f.source.run.provenance?.workflow);
  expect(JSON.stringify(await f.orc.events(attemptId))).not.toContain("secret-token-1");
  const inputs = await f.stores.execution.getInputs(attemptId);
  expect(inputs?.sensitiveNames).toContain("token");
  expect(inputs?.vars.token).toBe("secret-token-1");

  const done = await f.orc.run(attemptId);
  expect(done.run.status, JSON.stringify(done.run.error)).toBe("completed");
  expect(done.stepOrder.map((id) => [done.steps[id]!.nodeId, Boolean(done.steps[id]!.reusedFrom)])).toEqual([
    ["s", true],
    ["a", true],
    ["b", false],
    ["e", false],
  ]);
  expect((await f.orc.events(attemptId)).filter((e) => e.type === "run.started")).toHaveLength(1);
  // A replay after it ran still returns it and starts nothing.
  expect(await f.service.startAttempt({ runId: f.source.run.id }, { idempotencyKey: "k1" }, f.authority)).toEqual({
    ...first,
    replayed: true,
  });
});

it("refuses before any claim when the run cannot be recovered", async () => {
  const f = await fixture();
  const attempt = await f.service.startAttempt({ runId: f.source.run.id }, {}, f.authority);
  if (attempt.state !== "resolved" || attempt.result.state !== "accepted") throw new Error("expected an attempt");
  const done = await f.orc.run(attempt.result.runId);
  expect(done.run.status).toBe("completed");
  // A completed run has nothing to recover; another principal's run is not theirs to recover.
  await expect(
    f.service.startAttempt({ runId: done.run.id }, { idempotencyKey: "done" }, f.authority),
  ).rejects.toMatchObject({ code: "RECOVERY_BLOCKED", details: { blockers: expect.arrayContaining(["not-failed"]) } });
  await expect(
    f.service.startAttempt(
      { runId: f.source.run.id },
      { idempotencyKey: "other" },
      { ...f.authority, actor: { principalId: "someone-else" } },
    ),
  ).rejects.toMatchObject({ code: "RECOVERY_BLOCKED", details: { blockers: ["cross-principal"] } });
  // Refused intents left no claim behind: the same keys work once the intent is valid.
  const retried = await f.service.startAttempt({ runId: f.source.run.id }, { idempotencyKey: "other" }, f.authority);
  expect(retried).toMatchObject({ state: "resolved", result: { state: "accepted" } });
});
