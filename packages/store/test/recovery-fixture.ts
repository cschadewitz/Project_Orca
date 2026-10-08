/** Test-only fresh synthetic roots; all writes/copies are confined to roots created here. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaEventSchema, parseWorkflow, readJsonl, type WorkflowDefinition } from "@orca/core";
import { FileExecutionStore, publicInputVars } from "../src/execution-store.js";
import { FileWorkflowVersionStore } from "../src/workflow-store.js";
import { JsonlEventStore } from "../src/jsonl-event-store.js";
import { executionEvents, ProtectedEventStore } from "../src/protected-event-store.js";
import { inventoryRecoveryRoots, type RecoveryInventoryPlan } from "../src/recovery-inventory.js";
import { STORE_COMPONENTS, type RecoveryManifest } from "../src/recovery-manifest.js";
import type { SemanticReadEvidence } from "../src/recovery-validation.js";

export const CANDIDATE = "synthetic-candidate-a";
const secret = "synthetic-recovery-private-input-8934";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function recoveryFixture() {
  const base = await mkdtemp(join(tmpdir(), "orca-recovery-validation-"));
  const roots = ["store-app", "store-cli-acp", "app", "configuration"].map((id) => join(base, id));
  const plan: RecoveryInventoryPlan = {
    candidateRef: CANDIDATE,
    roots: [],
    references: [],
    external: [
      { id: "workspaces", kind: "workspace", state: "not-applicable" },
      { id: "credentials", kind: "credential", state: "not-applicable" },
    ],
  };
  const definition = parseWorkflow(
    "id: workflow\nname: Workflow\nversion: '1'\nvars: { secret: synthetic-recovery-private-input-8934 }\nstart: e\nnodes: { e: { type: end } }\nedges: []",
  );
  for (const [index, path] of roots.entries()) {
    await mkdir(path, { mode: 0o700 });
    const id = ["store-app", "store-cli-acp", "app", "configuration"][index]!;
    if (index < 2) {
      const identity = randomUUID();
      await mkdir(join(path, "workspace-identity"), { mode: 0o700 });
      await writeFile(join(path, "workspace-identity/id"), `${identity}\n`, { mode: 0o600 });
      await writeFile(join(path, ".workspace-identified"), "1\n", { mode: 0o600 });
      const execution = new FileExecutionStore(path),
        workflows = new FileWorkflowVersionStore(path);
      await execution.putInputs({
        runId: "run",
        workflowId: "workflow",
        workflowVersion: "1",
        vars: { secret },
        sensitiveNames: ["secret"],
        secrets: [secret],
      });
      // Historical plugin content is deliberately opaque, never restored.
      await execution.putGeneration("generation", {
        fixture: true,
        pluginRecords: { opaque: "historical-registration" },
      });
      await workflows.put(definition);
      const publicEvents = new JsonlEventStore(path);
      await new ProtectedEventStore(publicEvents, execution, workflows).append({
        type: "vars.set",
        runId: "run",
        payload: { vars: { secret } },
      });
      const body = "synthetic-artifact";
      await mkdir(join(path, "artifacts/blobs"), { recursive: true, mode: 0o700 });
      await chmod(join(path, "artifacts"), 0o700);
      await writeFile(join(path, "artifacts/index.jsonl"), `${JSON.stringify({ contentHash: digest(body) })}\n`, {
        mode: 0o600,
      });
      await writeFile(join(path, "artifacts/blobs", digest(body)), body, { mode: 0o600 });
      // Existing append defaults need normalization only during synthetic fixture creation.
      await chmod(join(path, "runs"), 0o700);
      for (const name of await readdir(join(path, "runs"))) await chmod(join(path, "runs", name), 0o600);
      plan.roots.push({
        id,
        role: "store",
        path,
        expectedIdentity: identity,
        components: Object.entries(STORE_COMPONENTS).map(([componentId, paths]) => ({
          id: componentId,
          paths: [...paths],
          candidateRef: CANDIDATE,
          state: [
            "runs",
            "artifacts",
            "artifact-index",
            "artifact-blobs",
            "private-execution",
            "private-execution-key",
            "private-workflows",
            "private-workflows-key",
            "workspace-identity",
          ].includes(componentId)
            ? "present"
            : "absent",
        })),
      });
      for (const reference of [
        "private-execution/run.inputs.json",
        "private-execution/generation.generation.json",
        "private-workflows/workflow@v1.json",
        `artifacts/blobs/${digest(body)}`,
      ])
        plan.references.push({ rootId: id, path: reference, candidateRef: CANDIDATE });
    } else if (index === 2) {
      await writeFile(join(path, "preferences.json"), '{"density":"comfortable"}', { mode: 0o600 });
      await writeFile(join(path, "admission-intents.enc"), "synthetic-encrypted-journal-placeholder", { mode: 0o600 });
      plan.roots.push({
        id,
        role: "app",
        path,
        components: [
          { id: "preferences", paths: ["preferences.json"], state: "present", candidateRef: CANDIDATE },
          { id: "admission-intents", paths: ["admission-intents.enc"], state: "present", candidateRef: CANDIDATE },
        ],
      });
    } else {
      await writeFile(join(path, "orca.config.yaml"), "storeDir: ../store-cli-acp\n", { mode: 0o600 });
      await writeFile(join(path, "orca.permissions.json"), '{"version":1,"agents":{}}', { mode: 0o600 });
      plan.roots.push({
        id,
        role: "configuration",
        path,
        components: [
          { id: "configuration", paths: ["orca.config.yaml"], state: "present", candidateRef: CANDIDATE },
          { id: "permissions", paths: ["orca.permissions.json"], state: "present", candidateRef: CANDIDATE },
          { id: "assets", paths: ["assets"], state: "not-applicable", candidateRef: CANDIDATE },
          { id: "credentials", paths: ["auth"], state: "not-applicable", candidateRef: CANDIDATE },
        ],
      });
    }
  }
  return { base, roots, plan, definition, cleanup: () => rm(base, { recursive: true, force: true }) };
}
export type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;
export async function observe(plan: RecoveryInventoryPlan): Promise<RecoveryManifest> {
  const result = await inventoryRecoveryRoots(plan);
  if (!result.ok) throw new Error(result.reasons.join(","));
  return result.manifest;
}

/** Existing non-mutating read APIs; return booleans only, never plaintext or caught messages. */
export async function readSyntheticStores(
  plan: RecoveryInventoryPlan,
  definition: WorkflowDefinition,
): Promise<SemanticReadEvidence[]> {
  const evidence: SemanticReadEvidence[] = [];
  for (const root of plan.roots.filter((item) => item.role === "store")) {
    let readable: boolean;
    try {
      const execution = new FileExecutionStore(root.path),
        workflows = new FileWorkflowVersionStore(root.path);
      const inputs = await execution.getInputs("run");
      const workflow = await workflows.get("workflow", "1");
      const generation = await execution.getGeneration("generation");
      // readJsonl has no mkdir, lock, repair or recovery; all synthetic lines are committed.
      const events = await readJsonl(join(root.path, "runs/run.jsonl"), OrcaEventSchema, {
        onCorrupt: () => {
          throw new Error("SEMANTIC_UNREADABLE");
        },
      });
      const restored = await executionEvents(events, execution);
      const publicJson = JSON.stringify(events);
      readable =
        inputs?.vars.secret === secret &&
        JSON.stringify(workflow) === JSON.stringify(definition) &&
        generation !== undefined &&
        restored.some((event) => event.type === "vars.set" && event.payload.vars.secret === secret) &&
        !publicJson.includes(secret) &&
        inputs !== undefined &&
        !JSON.stringify(publicInputVars(inputs)).includes(secret);
    } catch {
      readable = false;
    }
    evidence.push({ rootId: root.id, candidateRef: plan.candidateRef, readable });
  }
  return evidence;
}
export async function copySyntheticFixture(fixture: RecoveryFixture): Promise<RecoveryInventoryPlan> {
  const copy = join(fixture.base, "roundtrip");
  await mkdir(copy, { mode: 0o700 });
  const plan = structuredClone(fixture.plan);
  for (const root of plan.roots) {
    const destination = join(copy, root.id);
    await cp(root.path, destination, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    root.path = destination;
  }
  return plan;
}
export async function sourceDigest(fixture: RecoveryFixture): Promise<string> {
  const manifest = await observe(fixture.plan);
  return digest(JSON.stringify(manifest));
}
export async function readFixtureBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
