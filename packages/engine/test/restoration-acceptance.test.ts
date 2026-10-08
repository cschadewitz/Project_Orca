/** #396 baseline fresh-process acceptance. Reviewed #394/#395 and actual-Cal gates remain explicit TODOs. */
import { appendFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { parseWorkflow } from "@orca/core";
import { ProcessHarness, protectedDigests } from "./restoration-acceptance/harness.js";
import {
  canaries,
  configure,
  makeFixture,
  prepareJevFixture,
  prepareRestorationFixture,
  providerTrace,
  jevFixtureData,
  pluginKinds,
  type Fixture,
  type Receipt,
  type Report,
} from "./restoration-acceptance/fixture.js";
import { baselineSha, implementationPins, pendingAcceptance } from "./restoration-acceptance/matrix.js";

const harness = new ProcessHarness();
const fixtures: Fixture[] = [];
const fixture = async (kind: Fixture["kind"] = "builtin") => {
  const f = await makeFixture(kind);
  fixtures.push(f);
  return f;
};
afterEach(async () => {
  await harness.dispose();
  await Promise.all(fixtures.splice(0).map((f) => rm(f.root, { recursive: true, force: true })));
});

function noLeaks(report: Report) {
  expect([report.publicLeak, report.logLeak, report.errorLeak]).toEqual([false, false, false]);
}
function refused(report: Report, code = "RUN_STATE") {
  expect(report.outcome).toBe("refused");
  expect(report.code).toBe(code);
  expect(report.provisioned).toBe(0);
  expect(report.providerCalls).toBe(0);
  expect(report.permissionDelivered).toBe(0);
  expect(report.consentWrites).toBe(0);
  noLeaks(report);
}
function differentProcess(before: Report, after: Report) {
  expect(after.pid).not.toBe(before.pid);
  expect(after.pid).not.toBe(process.pid);
  expect(after.bootId).not.toBe(before.bootId);
  expect(after.runtimeSha256).toBe(before.runtimeSha256);
  expect(after.nodeVersion).toBe(process.version);
}
async function preserveOriginal(f: Fixture, before: Record<string, string>) {
  const after = await protectedDigests(f);
  for (const [path, hash] of Object.entries(before)) expect(after[path], path).toBe(hash);
}

describe("#396 implemented baseline: genuinely fresh engine processes", () => {
  it.each(["builtin", "noop", "declarative"] as const)(
    "%s: restores pinned inputs and protected workflows while new admissions adopt current defaults",
    async (kind) => {
      const f = await fixture(kind),
        first = await harness.invoke(f, "park");
      expect(first.outcome).toBe("ok");
      expect(first.status).toBe("paused");
      expect(first.pending).toBe(1);
      expect(first.providerCalls).toBe(1);
      noLeaks(first);
      const original = await protectedDigests(f);
      await configure(f, "new");
      const restored = await harness.invoke(f, "restore");
      differentProcess(first, restored);
      expect(restored).toMatchObject({
        outcome: "ok",
        recordedModel: "old-model",
        activeModel: "new-model",
        recordedWorkspace: "old-workspace",
        activeWorkspace: "new-workspace",
        workflowVersion: "1",
        workflowName: "old workflow",
        provisioned: 0,
        providerCalls: 0,
      });
      noLeaks(restored);
      await preserveOriginal(f, original);
      const next = await harness.invoke(f, "new");
      differentProcess(restored, next);
      expect(next).toMatchObject({ outcome: "ok", activeModel: "new-model", status: "created", provisioned: 1 });
      expect(next.receipt?.generationId).not.toBe(first.receipt?.generationId);
      expect(next.receipt?.runId).not.toBe(first.receipt?.runId);
      noLeaks(next);
    },
  );

  it("a restart restores no answer or consent; explicit first answer reaches the historical second gate", async () => {
    const f = await fixture(),
      first = await harness.invoke(f, "park");
    await configure(f, "new");
    const inspected = await harness.invoke(f, "inspect");
    differentProcess(first, inspected);
    expect(inspected).toMatchObject({
      outcome: "ok",
      status: "paused",
      pending: 1,
      events: first.events,
      provisioned: 0,
      consentWrites: 0,
    });
    const resumed = await harness.invoke(f, "resume");
    differentProcess(inspected, resumed);
    expect(resumed).toMatchObject({
      outcome: "ok",
      status: "paused",
      pending: 1,
      provisioned: 0,
      providerCalls: 0,
      consentWrites: 0,
    });
    expect(resumed.receipt?.runId).toBe(first.receipt?.runId);
    noLeaks(resumed);
    const events = await fileStores(join(f.root, "store")).events.read(first.receipt!.runId);
    expect(events.filter((e) => e.type === "human.answered")).toHaveLength(1);
    // The completed scripted provider step is not re-executed merely because of restart.
    const scheduled = events.find((e) => e.type === "step.scheduled" && e.payload.nodeId === "effect");
    expect(scheduled?.type).toBe("step.scheduled");
    const start = events.filter(
      (e) =>
        e.type === "step.completed" &&
        scheduled?.type === "step.scheduled" &&
        e.payload.stepRunId === scheduled.payload.stepRunId,
    );
    expect(start).toHaveLength(1);
    await expect(readFile(join(f.root, "orca.permissions.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(pluginKinds.filter((kind) => !["builtin", "noop", "declarative"].includes(kind)))(
    "%s: unsupported callbacks refuse generation-wide before provisioning/execution, even on an unused node",
    async (kind) => {
      const f = await fixture(kind),
        first = await harness.invoke(f, "park");
      expect(first.outcome).toBe("ok");
      expect(first.status).toBe("paused");
      expect(first.providerCalls).toBe(1);
      // A custom provider may provision during the original authorized admission. Reset only its test-owned marker.
      await rm(join(f.root, "effect.marker"), { force: true });
      const original = await protectedDigests(f);
      await configure(f, "new");
      const restored = await harness.invoke(f, "historical-admit");
      differentProcess(first, restored);
      refused(restored);
      await preserveOriginal(f, original);
      await expect(readFile(join(f.root, "effect.marker"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fileStores(join(f.root, "store")).events.listRuns()).toEqual([first.receipt!.runId]);
    },
  );

  it.each(["changed", "unavailable"] as const)("%s plugin refuses historical restoration", async (mode) => {
    const f = await fixture("noop"),
      first = await harness.invoke(f, "park");
    if (mode === "changed") await appendFile(join(f.root, "plugin.mjs"), "// changed implementation\n");
    else
      await writeFile(
        join(f.root, "orca.config.json"),
        (await readFile(join(f.root, "orca.config.json"), "utf8")).replace('"./plugin.mjs"', '"./unavailable.mjs"'),
      );
    const result = await harness.invoke(f, "restore");
    differentProcess(first, result);
    refused(result, mode === "changed" ? "RUN_STATE" : "FIXTURE_FAILURE");
  });

  it.each([
    "missing-generation",
    "malformed-envelope",
    "future-envelope",
    "corrupt-ciphertext",
    "missing-workflow",
    "missing-inputs",
    "missing-generation-key",
    "missing-workflow-key",
  ] as const)("%s fails closed in a new process", async (fault) => {
    const f = await fixture(),
      first = await harness.invoke(f, "park");
    const dir = join(f.root, "store", "private-execution");
    const record = join(dir, `${first.receipt!.generationId}.generation.json`);
    if (fault === "missing-generation") await rm(record);
    if (fault === "malformed-envelope") await writeFile(record, "{invalid");
    if (fault === "future-envelope" || fault === "corrupt-ciphertext") {
      const envelope = JSON.parse(await readFile(record, "utf8")) as Record<string, unknown>;
      if (fault === "future-envelope") envelope.version = 2;
      else envelope.ciphertext = "AA==";
      await writeFile(record, JSON.stringify(envelope));
    }
    if (fault === "missing-workflow") {
      const wfdir = join(f.root, "store", "private-workflows");
      for (const name of await readdir(wfdir)) if (name.endsWith(".json")) await rm(join(wfdir, name));
    }
    if (fault === "missing-inputs") await rm(join(dir, `${first.receipt!.runId}.inputs.json`));
    if (fault === "missing-generation-key") await rm(join(dir, ".execution-key"));
    if (fault === "missing-workflow-key") await rm(join(f.root, "store", "private-workflows", ".execution-key"));
    const result = await harness.invoke(
      f,
      fault === "missing-workflow" || fault === "missing-inputs" ? "resume" : "restore",
    );
    differentProcess(first, result);
    refused(result, fault === "missing-workflow" ? "WORKFLOW_VERSION_NOT_FOUND" : "RUN_STATE");
  });

  it.each(["id-mismatch", "workflow-mismatch", "missing-definition", "duplicate-definition"] as const)(
    "authenticated %s generation refuses without modifying original protected data",
    async (fault) => {
      const f = await fixture(),
        first = await harness.invoke(f, "park"),
        receipt = first.receipt!;
      const original = await protectedDigests(f),
        stores = fileStores(join(f.root, "store"));
      const snapshot = (await stores.execution.getGeneration(receipt.generationId)) as {
        id: string;
        workflows: { id: string; version: string; revision: string }[];
        workflowDefinitions: unknown[];
      };
      const id = randomUUID();
      snapshot.id = id;
      if (fault === "id-mismatch") snapshot.id = randomUUID();
      if (fault === "workflow-mismatch") snapshot.workflows[0]!.revision = "changed";
      if (fault === "missing-definition") snapshot.workflowDefinitions = [];
      if (fault === "duplicate-definition") {
        snapshot.workflows.push(snapshot.workflows[0]!);
        snapshot.workflowDefinitions.push(snapshot.workflowDefinitions[0]);
      }
      await stores.execution.putGeneration(id, snapshot);
      await writeFile(join(f.root, "receipt.json"), JSON.stringify({ ...receipt, generationId: id }));
      const result = await harness.invoke(f, "historical-admit");
      differentProcess(first, result);
      refused(result);
      await preserveOriginal(f, original);
    },
  );

  it.each(["builtin", "noop"] as const)("%s legacy version-pin matrix stays explicit", async (kind) => {
    const f = await fixture(kind),
      first = await harness.invoke(f, "park"),
      stores = fileStores(join(f.root, "store"));
    const original = await protectedDigests(f);
    const snapshot = (await stores.execution.getGeneration(first.receipt!.generationId)) as Record<string, unknown>;
    const id = randomUUID();
    snapshot.id = id;
    for (const key of [
      "workflowDefinitions",
      "runtimeBinding",
      "runtimeFingerprint",
      "runtimeHosts",
      "effectiveAgents",
      "effectiveRoles",
    ])
      delete snapshot[key];
    await stores.execution.putGeneration(id, snapshot);
    await writeFile(join(f.root, "receipt.json"), JSON.stringify({ ...first.receipt, generationId: id }));
    const restored = await harness.invoke(f, "restore");
    differentProcess(first, restored);
    if (kind === "builtin")
      expect(restored).toMatchObject({ outcome: "ok", workflowVersion: "1", recordedModel: "old-model" });
    else refused(restored);
    await preserveOriginal(f, original);
    noLeaks(restored);
  });

  it("protected generation and workflow envelopes retain owner keys and never expose synthetic credentials", async () => {
    const f = await fixture("declarative"),
      first = await harness.invoke(f, "park"),
      original = await protectedDigests(f);
    expect(Object.keys(original).filter((p) => p.endsWith("/.execution-key"))).toHaveLength(2);
    for (const path of Object.keys(original)) {
      const bytes = await readFile(join(f.root, "store", path));
      for (const canary of canaries) expect(bytes.includes(Buffer.from(canary))).toBe(false);
    }
    await configure(f, "new");
    noLeaks(await harness.invoke(f, "restore"));
    await preserveOriginal(f, original);
    noLeaks(first);
  });

  it.each(["revoked", "principal-mismatch", "workspace-mismatch", "missing"] as const)(
    "%s current admission authority cannot execute recorded acceptance",
    async (authority) => {
      const f = await fixture(),
        admitted = await harness.invoke(f, "admit");
      expect(admitted.outcome).toBe("ok");
      const stores = fileStores(join(f.root, "store")),
        events = await stores.events.read(admitted.receipt!.runId);
      const result = await harness.invoke(f, "execute-admitted", authority);
      differentProcess(admitted, result);
      refused(result);
      expect(await stores.events.read(admitted.receipt!.runId)).toEqual(events);
    },
  );

  it("lost admission response retains one durable run and requires current authority before execution", async () => {
    const f = await fixture(),
      lost = await harness.invoke(f, "admit-lost-response");
    expect(lost).toMatchObject({ outcome: "response-lost", provisioned: 1, providerCalls: 0, runs: 1 });
    expect(lost.receipt).toBeUndefined();
    const saved = JSON.parse(await readFile(join(f.root, "receipt.json"), "utf8")) as Receipt;
    await configure(f, "new");
    const replay = await harness.invoke(f, "admit");
    differentProcess(lost, replay);
    expect(replay).toMatchObject({ outcome: "ok", status: "created", runs: 1, provisioned: 0, providerCalls: 0 });
    expect(replay.receipt).toEqual(saved);
    noLeaks(replay);
    const result = await harness.invoke(f, "execute-admitted", "owner");
    expect(result).toMatchObject({ outcome: "ok", status: "paused", providerCalls: 1, provisioned: 0 });
    noLeaks(result);
  });

  it("a live owning process fences resume; restart does not adopt its lease", async () => {
    const f = await fixture(),
      first = await harness.invoke(f, "park");
    const holder = await harness.start(f, "hold-lease");
    // A barrier, not elapsed time, proves that a different process owns the lease.
    await holder.held;
    try {
      refused(await harness.invoke(f, "resume"), "RUN_LEASED");
    } finally {
      holder.release();
      await holder.result;
    }
    expect(first.status).toBe("paused");
  });

  it("fresh process cannot resurrect an old live permission callback or write standing consent", async () => {
    const f = await fixture(),
      first = await harness.invoke(f, "permission-open");
    expect(first).toMatchObject({ outcome: "ok", permissionDelivered: 0, consentWrites: 0 });
    const next = await harness.invoke(f, "permission-answer");
    differentProcess(first, next);
    refused(next);
    expect(await fileStores(join(f.root, "store")).events.listRuns()).toEqual([]);
    await expect(readFile(join(f.root, "orca.permissions.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("#396 provisional contract bindings: acceptance remains INCOMPLETE", () => {
  it.each(["before-evaluation", "after-evaluation"] as const)(
    "prepares syntactically valid %s JEV data without importing or executing the unbound adapter",
    async (boundary) => {
      const f = await fixture("noop");
      await prepareJevFixture(f, "old", boundary);
      const source = await readFile(join(f.root, "plugin.mjs"), "utf8");
      execFileSync(process.execPath, ["--check", join(f.root, "plugin.mjs")], { stdio: "ignore" });
      const workflow = parseWorkflow(await readFile(join(f.root, "workflow.yaml"), "utf8"));
      expect(workflow.nodes.jev?.type).toBe("custom:jev-eval");
      expect(workflow.edges.find((edge) => edge.from === "s")?.to).toBe(
        boundary === "before-evaluation" ? "first" : "jev",
      );
      await prepareJevFixture(f, "new", boundary, "revoked", true);
      expect(await readFile(join(f.root, "plugin.mjs"), "utf8")).toBe(source);
      expect(JSON.parse(await readFile(join(f.root, "jev-settings.json"), "utf8"))).toEqual({
        era: "new",
        failure: "revoked",
      });
      await expect(readFile(join(f.root, "provider-trace.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(f.root, "credential-trace.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("records baseline and runtime review gate and exact reviewed adapter pin explicitly", () => {
    expect(baselineSha).toMatch(/^[a-f0-9]{40}$/);
    expect(implementationPins).toEqual({ substrate394: null, jev395: "e4039a32e4a82aa19cd95b3e98f2813b47486903" });
  });
  for (const [owner, assertion] of pendingAcceptance) it.todo(`[${owner}; final acceptance pending] ${assertion}`);
});

// Opt-in candidate execution is integration evidence; reviewed-head clearance remains a separate ledger gate.
describe.skipIf(process.env.ORCA_RESTORATION_CANDIDATE !== "7202a6e06525052f304f4f49abbfd783e163a375")(
  "#396 published candidate integration",
  () => {
    it("restores admitted closure values across processes and runs new admissions with current values", async () => {
      const f = await fixture("noop");
      await prepareRestorationFixture(f, "old");
      const first = await harness.invoke(f, "park");
      expect(first).toMatchObject({
        outcome: "ok",
        status: "paused",
        descriptorPresent: true,
        providerCalls: 0,
        factoryCalls: 0,
      });
      const original = await protectedDigests(f);
      const source = await readFile(join(f.root, "plugin.mjs"), "utf8");
      await prepareRestorationFixture(f, "new");
      expect(await readFile(join(f.root, "plugin.mjs"), "utf8")).toBe(source);
      const resumed = await harness.invoke(f, "resume");
      differentProcess(first, resumed);
      expect(resumed).toMatchObject({
        outcome: "ok",
        status: "completed",
        providerCalls: 1,
        executionModels: ["old-model"],
        factoryCalls: 1,
        provisioned: 0,
        consentWrites: 0,
      });
      noLeaks(resumed);
      await preserveOriginal(f, original);
      const current = await harness.invoke(f, "run-new");
      expect(current).toMatchObject({
        outcome: "ok",
        status: "completed",
        executionModels: ["new-model"],
        providerCalls: 1,
      });
      noLeaks(current);
    });

    it.each(["schemaVersion", "id", "codeVersion", "dependencyIdentity"] as const)(
      "changed %s refuses before reconstruction",
      async (field) => {
        const f = await fixture("noop");
        await prepareRestorationFixture(f, "old");
        const first = await harness.invoke(f, "park"),
          original = await protectedDigests(f);
        await prepareRestorationFixture(f, "new", { identity: { [field]: field === "schemaVersion" ? 2 : "changed" } });
        const result = await harness.invoke(f, "historical-admit");
        differentProcess(first, result);
        refused(result);
        expect(result).toMatchObject({ restorationReason: "incompatible_identity", factoryCalls: 0 });
        await preserveOriginal(f, original);
      },
    );

    it.each(["absent", "refused", "throws", "restore-refused"] as const)(
      "%s trusted verifier fails closed",
      async (verification) => {
        const f = await fixture("noop");
        await prepareRestorationFixture(f, "old");
        await harness.invoke(f, "park");
        const result = await harness.invoke(f, "historical-admit", undefined, verification);
        refused(result);
        expect(result).toMatchObject({ restorationReason: "identity_unverified", factoryCalls: 0 });
      },
    );

    it.each(["throw", "omit", "duplicate"] as const)(
      "%s second factory cannot activate a partial historical candidate",
      async (secondFault) => {
        const f = await fixture("noop");
        await prepareRestorationFixture(f, "old", { composition: "pair" });
        await harness.invoke(f, "park");
        const original = await protectedDigests(f);
        await prepareRestorationFixture(f, "new", { composition: "pair", secondFault });
        const result = await harness.invoke(f, "restore-current");
        expect(result).toMatchObject({
          outcome: "ok",
          restorationReason: "reconstruction_failed",
          factoryCalls: 2,
          currentGenerationUnchanged: true,
          status: "completed",
          executionModels: ["new-model", "new-model"],
          providerCalls: 2,
        });
        noLeaks(result);
        await preserveOriginal(f, original);
      },
    );

    it.each(["host-exec", "host-fs", "workspace", "plan", "builtin-mutation", "human-input"] as const)(
      "%s callback does not claim executor-only restoration",
      async (callback) => {
        const f = await fixture("noop");
        await prepareRestorationFixture(f, "old", { callback });
        const first = await harness.invoke(f, "new");
        expect(first).toMatchObject({ outcome: "ok", descriptorPresent: false, providerCalls: 0 });
        const result = await harness.invoke(f, "historical-admit");
        refused(result);
        expect(result.factoryCalls).toBe(0);
      },
    );

    it.each(["mixed", "duplicate-identity"] as const)("%s composition fails closed", async (composition) => {
      const f = await fixture("noop");
      await prepareRestorationFixture(f, "old", { composition });
      if (composition === "duplicate-identity") {
        const result = await harness.invoke(f, "new");
        refused(result);
        expect(result.restorationReason).toBe("invalid_descriptor");
      } else {
        expect(await harness.invoke(f, "new")).toMatchObject({ outcome: "ok", descriptorPresent: false });
        refused(await harness.invoke(f, "historical-admit"));
      }
    });

    it.each([
      "future-contract",
      "zero-contract",
      "missing",
      "malformed",
      "future-data",
      "extra-data",
      "duplicate-record",
      "duplicate-type",
      "wrong-spec",
      "wrong-digest",
    ] as const)("authenticated %s descriptor refuses without altering original evidence", async (fault) => {
      const f = await fixture("noop");
      await prepareRestorationFixture(f, "old");
      const first = await harness.invoke(f, "park"),
        original = await protectedDigests(f),
        stores = fileStores(join(f.root, "store"));
      const snapshot = (await stores.execution.getGeneration(first.receipt!.generationId)) as {
        id: string;
        pluginRestoration: {
          contractVersion: number;
          data: Record<string, unknown>;
          executors: string[];
          spec: string;
          entryDigest: string;
        }[];
      };
      snapshot.id = randomUUID();
      const record = snapshot.pluginRestoration[0]!;
      if (fault === "future-contract") record.contractVersion = 2;
      if (fault === "zero-contract") record.contractVersion = 0;
      if (fault === "missing") Reflect.deleteProperty(snapshot, "pluginRestoration");
      if (fault === "malformed") Reflect.set(snapshot, "pluginRestoration", {});
      if (fault === "future-data") record.data.schema = 2;
      if (fault === "extra-data") record.data.apiKey = canaries[0];
      if (fault === "duplicate-record") snapshot.pluginRestoration.push(record);
      if (fault === "duplicate-type") record.executors.push(record.executors[0]!);
      if (fault === "wrong-spec") record.spec = "./missing.mjs";
      if (fault === "wrong-digest") record.entryDigest = "f".repeat(64);
      await stores.execution.putGeneration(snapshot.id, snapshot);
      await writeFile(join(f.root, "receipt.json"), JSON.stringify({ ...first.receipt, generationId: snapshot.id }));
      const result = await harness.invoke(f, "historical-admit");
      refused(result);
      expect(result.factoryCalls).toBe(0);
      await preserveOriginal(f, original);
    });

    it.each(["validate-throw", "capture-secret", "capture-closure"] as const)(
      "%s capture sanitizes refusal before effects",
      async (fault) => {
        const f = await fixture("noop");
        await prepareRestorationFixture(f, "old", { fault });
        const result = await harness.invoke(f, "new");
        refused(result);
        expect(result.restorationReason).toBe("invalid_descriptor");
      },
    );

    it.each([false, true])("JEV before evaluation restores defaults and node override=%s", async (nodeOverride) => {
      const f = await fixture("noop");
      await prepareJevFixture(f, "old", "before-evaluation", "none", nodeOverride);
      const first = await harness.invoke(f, "park");
      expect(first).toMatchObject({ outcome: "ok", status: "paused", providerCalls: 0, descriptorPresent: true });
      const original = await protectedDigests(f);
      await prepareJevFixture(f, "new", "before-evaluation", "none", nodeOverride);
      const resumed = await harness.invoke(f, "resume");
      differentProcess(first, resumed);
      expect(resumed).toMatchObject({
        outcome: "ok",
        status: "paused",
        providerCalls: 1,
        executionModels: [nodeOverride ? jevFixtureData.nodeOverride : jevFixtureData.old.model],
        consentWrites: 0,
      });
      expect(await providerTrace(f)).toMatchObject([{ endpoint: jevFixtureData.old.baseUrl + "/v1/systemone" }]);
      noLeaks(resumed);
      await preserveOriginal(f, original);
    });

    it.each([
      "absent",
      "revoked",
      "account-changed",
      "reference-changed",
      "provider-changed",
      "key-accessor",
      "binding-accessor",
    ] as const)("JEV %s credential refuses before HTTP provider", async (failure) => {
      const f = await fixture("noop");
      await prepareJevFixture(f, "old", "before-evaluation");
      await harness.invoke(f, "park");
      await prepareJevFixture(f, "new", "before-evaluation", failure);
      const result = await harness.invoke(f, "resume");
      expect(result).toMatchObject({ outcome: "ok", status: "failed", providerCalls: 0 });
      noLeaks(result);
      expect(await providerTrace(f)).toEqual([]);
    });

    it("JEV durable result survives fresh-process resume without reevaluation", async () => {
      const f = await fixture("noop");
      await prepareJevFixture(f, "old", "after-evaluation");
      const first = await harness.invoke(f, "park");
      expect(first).toMatchObject({ outcome: "ok", status: "paused", providerCalls: 1 });
      const stores = fileStores(join(f.root, "store"));
      const before = await stores.events.read(first.receipt!.runId);
      const completed = before.filter((e) => e.type === "step.completed" && e.payload.result.artifactIds.length > 0);
      expect(completed).toHaveLength(1);
      const artifactIds = completed.flatMap((event) =>
        event.type === "step.completed" ? event.payload.result.artifactIds : [],
      );
      const artifactsBefore = await Promise.all(artifactIds.map((id) => stores.artifacts.get(id)));
      expect(artifactsBefore.every(Boolean)).toBe(true);
      expect(JSON.stringify(artifactsBefore)).not.toContain(canaries[0]);
      const original = await protectedDigests(f);
      await prepareJevFixture(f, "new", "after-evaluation", "revoked");
      const resumed = await harness.invoke(f, "resume");
      expect(resumed).toMatchObject({ outcome: "ok", status: "paused", providerCalls: 0 });
      noLeaks(resumed);
      expect(
        (await stores.events.read(first.receipt!.runId)).filter(
          (e) => e.type === "step.completed" && e.payload.result.artifactIds.length > 0,
        ),
      ).toEqual(completed);
      expect(await Promise.all(artifactIds.map((id) => stores.artifacts.get(id)))).toEqual(artifactsBefore);
      await preserveOriginal(f, original);
      expect(await providerTrace(f)).toHaveLength(1);
    });

    it("JEV lost response records failure after one effect without claiming exactly-once recovery", async () => {
      const f = await fixture("noop");
      await prepareJevFixture(f, "old", "before-evaluation");
      await harness.invoke(f, "park");
      await prepareJevFixture(f, "new", "before-evaluation", "response-lost");
      const result = await harness.invoke(f, "resume");
      expect(result).toMatchObject({ outcome: "ok", status: "failed", providerCalls: 1 });
      noLeaks(result);
      const inspected = await harness.invoke(f, "inspect");
      expect(inspected).toMatchObject({ outcome: "ok", status: "failed", providerCalls: 0 });
      expect(await providerTrace(f)).toHaveLength(1);
    });
    it.each(["injected-provider", "inline-key"] as const)("JEV %s options refuse before effects", async (failure) => {
      const f = await fixture("noop");
      await prepareJevFixture(f, "old", "before-evaluation", failure);
      const result = await harness.invoke(f, "new");
      refused(result, "FIXTURE_FAILURE");
      expect(result.adapterReason).toBe("options-unsupported");
    });
    it.each(["success-echo", "transport-echo"] as const)("JEV %s credential material is sanitized", async (failure) => {
      const f = await fixture("noop");
      await prepareJevFixture(f, "old", "before-evaluation");
      await harness.invoke(f, "park");
      await prepareJevFixture(f, "new", "before-evaluation", failure);
      const result = await harness.invoke(f, "resume");
      expect(result).toMatchObject({ outcome: "ok", status: "failed", providerCalls: 1 });
      noLeaks(result);
      const stores = fileStores(join(f.root, "store"));
      expect(JSON.stringify(await stores.events.read(result.receipt!.runId))).not.toContain(canaries[0]);
    });
    it.each(["revoked", "principal-mismatch", "workspace-mismatch", "missing"] as const)(
      "restored custom executor remains fenced by %s admission authority",
      async (authority) => {
        const f = await fixture("noop");
        await prepareRestorationFixture(f, "old");
        const first = await harness.invoke(f, "admit");
        expect(first.outcome).toBe("ok");
        await prepareRestorationFixture(f, "new");
        const result = await harness.invoke(f, "execute-admitted", authority);
        refused(result);
      },
    );
    it("restored custom executor remains fenced by a live process lease", async () => {
      const f = await fixture("noop");
      await prepareRestorationFixture(f, "old");
      await harness.invoke(f, "park");
      await prepareRestorationFixture(f, "new");
      const holder = await harness.start(f, "hold-lease");
      await holder.held;
      try {
        refused(await harness.invoke(f, "resume"), "RUN_LEASED");
      } finally {
        holder.release();
        await holder.result;
      }
      expect(await providerTrace(f)).toEqual([]);
    });
  },
);
