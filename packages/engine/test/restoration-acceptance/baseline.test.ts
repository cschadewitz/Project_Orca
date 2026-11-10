/** #396 provider-free fresh-process acceptance. Root exact-head review and Actual-Cal proof remain separate gates. */
import { appendFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import * as engine from "@orca/engine";
import { parseWorkflow } from "@orca/core";
import { protectedDigests } from "./harness.js";
import { canaries, configure, prepareJevFixture, pluginKinds, type Receipt } from "./fixture.js";
import {
  baselineSha,
  candidatePins,
  implementationPins,
  fixtureReviewStatus,
  pendingAcceptance,
  exercisedAcceptance,
  unverifiedExternalClaims,
} from "./matrix.js";
import { fixture, harness, noLeaks, refused, differentProcess, preserveOriginal } from "./support.js";

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
  it("records exact combined pins and separates executed coverage from review and external evidence", () => {
    expect(baselineSha).toMatch(/^[a-f0-9]{40}$/);
    expect(implementationPins).toEqual(candidatePins);
    expect(fixtureReviewStatus).toBe("root-minimal-review-pending");
    expect(candidatePins).toEqual({
      substrate394: "3054319b37ae61ba22b62ba2f519dc50bf3c0ebc",
      jev395: "879bedcf701f4eaad2e8da47bac8feb2444c2d9d",
    });
    expect(exercisedAcceptance).toHaveLength(14);
    expect(unverifiedExternalClaims).toHaveLength(2);
    if (process.env.ORCA_RESTORATION_CANDIDATE) {
      expect(process.env.ORCA_RESTORATION_CANDIDATE).toBe(candidatePins.substrate394);
      expect(Reflect.has(engine, "readPluginRestorationData")).toBe(true);
    }
  });
  for (const [owner, assertion] of pendingAcceptance) it.todo(`[${owner}; final acceptance pending] ${assertion}`);
});

// Opt-in candidate execution is integration evidence; reviewed-head clearance remains a separate ledger gate.
