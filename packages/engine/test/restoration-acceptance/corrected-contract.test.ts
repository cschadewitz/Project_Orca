/** #396 fresh-process acceptance of the corrected contract: closure restoration, plugin hooks and composition.
 * Split out of baseline.test.ts so the scenarios run beside each other. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import * as engine from "@orca/engine";
import { protectedDigests } from "./harness.js";
import { canaries, prepareJevFixture, prepareRestorationFixture, providerTrace, jevFixtureData } from "./fixture.js";
import { fixture, harness, noLeaks, refused, differentProcess, preserveOriginal } from "./support.js";

describe.skipIf(!Reflect.has(engine, "readPluginRestorationData"))("#396 corrected contract integration", () => {
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
    await expect(readFile(join(f.root, "credential-trace.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await prepareJevFixture(f, "new", "before-evaluation", "none", nodeOverride);
    const restored = await harness.invoke(f, "restore");
    differentProcess(first, restored);
    expect(restored).toMatchObject({ outcome: "ok", providerCalls: 0, provisioned: 0, consentWrites: 0 });
    await expect(readFile(join(f.root, "credential-trace.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
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
    const current = await harness.invoke(f, "run-new");
    expect(current).toMatchObject({
      outcome: "ok",
      status: "completed",
      providerCalls: 1,
      executionModels: [nodeOverride ? jevFixtureData.nodeOverride : jevFixtureData.new.model],
    });
    expect(await providerTrace(f)).toMatchObject([
      { endpoint: jevFixtureData.old.baseUrl + "/v1/systemone" },
      { endpoint: jevFixtureData.new.baseUrl + "/v1/systemone" },
    ]);
    noLeaks(current);
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
});
