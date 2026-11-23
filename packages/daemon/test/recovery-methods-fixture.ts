/**
 * The daemon-side recovery fixture shared by recovery-methods.test.ts and
 * recovery-safe-failures-357.test.ts: a failed run of a three-step workflow on the in-memory
 * stores, with retry-safe checkpoint admission wired as the daemon wires it, and `call` to
 * dispatch a method as a client would.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
} from "@orca/core";
import {
  builtinExecutors,
  CheckpointAdmissionService,
  completed,
  failed,
  LocalWorkspaceProvider,
  Orchestrator,
} from "@orca/engine";
import { FileExecutionStore, memoryStores } from "@orca/store";
import { ControlModel, ReadModel, dispatch, methodsFor, type MethodContext } from "@orca/daemon";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { ConfigurationGenerations } from "../../engine/src/configuration-generation.js";
import { AdmissionRetryModel, type AdmissionAuthorities } from "../src/admission-retry.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

export const definition = parseWorkflow(`
id: flow
name: Flow
version: "1"
start: s
nodes:
  s: { type: start }
  a: { type: set, vars: { reached: a } }
  b: { type: "custom:once" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: a }, { from: a, to: b }, { from: b, to: e }]
`);

export interface FixtureOptions {
  /** Who calls the methods; the source run is always started by `owner`. */
  principalId?: string;
  /** The live check that the caller may start a run of this workflow now. */
  authorizeWorkflow?: (workflowId: string) => Promise<void>;
}

export async function fixture(options: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orca-recovery-methods-"));
  dirs.push(dir);
  const stores = memoryStores();
  let failures = 1;
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    // Fails once without saying it did nothing outside ORCA: its effect is uncertain.
    executors: builtinExecutors().register({
      type: "custom:once",
      execute: async () => (failures-- > 0 ? failed("ONCE", "not yet") : completed()),
    }),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    logger: silentLogger,
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: orchestrator.workflows.list(), templates: [] }),
    admission: {
      validateStartRun: (opts, material) => orchestrator.validateStartRun(opts, material),
      startRun: (opts, material) => orchestrator.startRun(opts, material),
    },
  });
  await generations.initialize(
    parseOrcaConfig({ agents: [], program: { workflow: "flow", itemWorkflow: "flow" } }),
    "t",
  );
  orchestrator.generations = generations;
  const actor = { principalId: "owner", credentialId: "credential-test" };
  const owned = new Set<string>();
  orchestrator.admissionExecution = {
    authorize: async (policy) => {
      if (!owned.has(policy.binding.runId)) throw new OrcaError("RUN_STATE", "ownership unavailable");
    },
  };
  const faults = {
    conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
    limit: () => new OrcaError("RETRY_LIMIT", "limit"),
  };
  const claims = new RegisteredRetryClaims(
    new FileRetryClaimStore({ storeDir: dir, execution: new FileExecutionStore(dir), faults }),
    faults,
  );
  const checkpoints = new CheckpointAdmissionService({ orchestrator, retries: claims });
  const execute = vi.fn(async (runId: string) => {
    await orchestrator.run(runId);
  });
  const admissionRetries = new AdmissionRetryModel({
    claims,
    direct: {} as never,
    requests: {} as never,
    checkpoints,
    orchestrator,
    execute,
    executionFailed: () => {},
  });
  const workflowsAuthorized: string[] = [];
  const caller = options.principalId ? { ...actor, principalId: options.principalId } : actor;
  const authorities: AdmissionAuthorities = {
    principalId: caller.principalId,
    workspaceId: "workspace-test",
    check: async () => {},
    request: async () => {
      throw new OrcaError("NOT_SUPPORTED", "no requests here");
    },
    direct: async () => ({
      workspaceId: "workspace-test",
      actor: caller,
      authorize: async (command) => {
        await options.authorizeWorkflow?.(command.workflowId);
        workflowsAuthorized.push(command.workflowId);
      },
      onRunAdmitted: async (runId) => {
        owned.add(runId);
      },
      verifyRunAdmitted: async (runId) => {
        if (!owned.has(runId)) throw new OrcaError("RUN_STATE", "ownership unavailable");
      },
    }),
  };
  const reads = new ReadModel({ orchestrator });
  const ctx: MethodContext = {
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.control"],
    reads,
    control: new ControlModel({ orchestrator, reads }),
    admissionRetries,
    admissionAuthorities: async () => authorities,
    mutationActor: caller,
  };
  const source = await orchestrator.startAndRun({ workflowId: "flow", vars: {}, actor });
  expect(source.run.status).toBe("failed");
  const b = source.stepOrder.map((id) => source.steps[id]!).find((s) => s.nodeId === "b")!;
  return { orchestrator, stores, ctx, source, b, execute, workflowsAuthorized, claims, checkpoints };
}

export async function call(ctx: MethodContext, method: string, params?: unknown) {
  return (await dispatch(JSON.stringify({ kind: "request", id: 1, method, params }), methodsFor(ctx), ctx)) as {
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}
