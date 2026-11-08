/** #396 fresh-process acceptance of the corrected contract: JEV evaluation, credentials, leases and descriptor limits.
 * Split out of restoration-acceptance.test.ts so the scenarios run beside each other. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import * as engine from "@orca/engine";
import { protectedDigests } from "./restoration-acceptance/harness.js";
import {
  canaries,
  prepareJevFixture,
  prepareRestorationFixture,
  providerTrace,
} from "./restoration-acceptance/fixture.js";
import {
  fixture,
  harness,
  noLeaks,
  refused,
  differentProcess,
  preserveOriginal,
} from "./restoration-acceptance/support.js";

describe.skipIf(!Reflect.has(engine, "readPluginRestorationData"))("#396 corrected contract integration", () => {
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
    const terminalResume = await harness.invoke(f, "resume-without-answer");
    expect(terminalResume).toMatchObject({ outcome: "ok", status: "failed", providerCalls: 0, events: result.events });
    noLeaks(terminalResume);
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
  it.each([
    "host-exec",
    "host-fs",
    "workspace",
    "plan",
    "plan-direct",
    "plan-prototype",
    "plan-nested",
    "builtin-mutation",
    "human-input",
  ] as const)("current %s callback blocks historical executor recovery", async (callback) => {
    const f = await fixture("noop");
    await prepareRestorationFixture(f, "old");
    const first = await harness.invoke(f, "park"),
      original = await protectedDigests(f);
    await prepareRestorationFixture(f, "new", { callback });
    const result = await harness.invoke(f, "historical-admit");
    differentProcess(first, result);
    refused(result);
    expect(result).toMatchObject({ factoryCalls: 0, restorationReason: "unsupported_registration" });
    await preserveOriginal(f, original);
  });
  it.each(["plan-direct", "plan-prototype", "plan-nested"] as const)(
    "historical %s callback is conservatively bootstrap-bound",
    async (callback) => {
      const f = await fixture("noop");
      await prepareRestorationFixture(f, "old", { callback });
      const first = await harness.invoke(f, "park");
      expect(first).toMatchObject({ outcome: "ok", descriptorPresent: false, providerCalls: 0 });
      const original = await protectedDigests(f);
      await prepareRestorationFixture(f, "new");
      const result = await harness.invoke(f, "historical-admit");
      refused(result);
      expect(result.factoryCalls).toBe(0);
      await preserveOriginal(f, original);
    },
  );
  it.each([
    "sparse-small",
    "sparse-huge",
    "array-property",
    "capture-accessor",
    "capture-nonfinite",
    "capture-prototype",
    "capture-symbol",
    "validate-mutate",
  ] as const)("%s capture refuses before canonical expansion or side effects", async (fault) => {
    const f = await fixture("noop");
    await prepareRestorationFixture(f, "old", { fault });
    const result = await harness.invoke(f, "new");
    refused(result);
    expect(result).toMatchObject({ restorationReason: "invalid_descriptor", factoryCalls: 0, accessorReads: 0 });
  });
  it.each(["bytes", "utf8", "values", "depth"] as const)(
    "%s descriptor overflow refuses on capture and fresh protected recovery",
    async (mode) => {
      let data: Record<string, unknown>;
      if (mode === "bytes") data = { value: "x".repeat(65537) };
      else if (mode === "utf8") data = { value: "é".repeat(32768) };
      else if (mode === "values") data = { values: Array<null>(4096).fill(null) };
      else {
        data = { value: "old-model" };
        for (let i = 0; i < 33; i++) data = { nested: data };
      }
      const f = await fixture("noop");
      await prepareRestorationFixture(f, "old", { descriptorData: data });
      const captured = await harness.invoke(f, "new");
      refused(captured);
      expect(captured.restorationReason).toBe("invalid_descriptor");
      await prepareRestorationFixture(f, "old");
      const first = await harness.invoke(f, "park"),
        original = await protectedDigests(f),
        stores = fileStores(join(f.root, "store"));
      const snapshot = (await stores.execution.getGeneration(first.receipt!.generationId)) as {
        id: string;
        pluginRestoration: { data: Record<string, unknown> }[];
      };
      snapshot.id = randomUUID();
      snapshot.pluginRestoration[0]!.data = data;
      await stores.execution.putGeneration(snapshot.id, snapshot);
      await writeFile(join(f.root, "receipt.json"), JSON.stringify({ ...first.receipt, generationId: snapshot.id }));
      const recovered = await harness.invoke(f, "historical-admit");
      refused(recovered);
      expect(recovered.factoryCalls).toBe(0);
      await preserveOriginal(f, original);
    },
  );
  it.each(["bytes", "values", "depth"] as const)(
    "supported %s descriptor boundary restores in a fresh process without effects",
    async (mode) => {
      let data: Record<string, unknown>;
      if (mode === "bytes") data = { value: "x".repeat(65524) };
      else if (mode === "values") data = { values: Array<null>(4094).fill(null) };
      else {
        data = { value: "old-model" };
        for (let i = 0; i < 31; i++) data = { nested: data };
      }
      const f = await fixture("noop");
      await prepareRestorationFixture(f, "old", { descriptorData: data });
      const first = await harness.invoke(f, "new");
      expect(first).toMatchObject({ outcome: "ok", descriptorPresent: true, providerCalls: 0 });
      const original = await protectedDigests(f),
        restored = await harness.invoke(f, "restore");
      differentProcess(first, restored);
      expect(restored).toMatchObject({ outcome: "ok", providerCalls: 0, provisioned: 0, factoryCalls: 1 });
      noLeaks(restored);
      await preserveOriginal(f, original);
    },
  );
});
