/** Fresh standing workflow. Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 * The rest of the workflow, including the real-time scenarios, lives in the sibling test files in this folder.
 */
import fs from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores, FileExecutionStore } from "@orca/store";
import { readPrivateJson } from "../../../store/src/protected-file.js";
import * as daemonTransport from "../../../daemon/src/server.js";
import { runControlledOwnedReadTest } from "../controlled-owned-read/producer-expanded.js";
import { bootstrap, freshWorkflowRefuses, supervisor } from "./fixture.js";

it.each(["before", "after"] as const)(
  "a refreshed attestation publication failure %s commit cannot start another invocation",
  async (boundary) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    Object.assign(c.options, { ownerDurationMs: 300000 });
    const dispatch = daemonTransport.dispatch;
    let originalReview: string | undefined;
    const refused: string[] = [];
    const dispatchSpy = vi.spyOn(daemonTransport, "dispatch").mockImplementation(async (text, ...rest) => {
      const request = JSON.parse(text) as { id: number; method: string; params: Record<string, unknown> };
      if (request.method === "scopedPermissions.review") originalReview = text;
      const response = await dispatch(text, ...rest);
      if (
        request.method === "scopedPermissions.choose" &&
        request.params.choice === "save" &&
        response.ok &&
        (response.result as { outcome?: unknown }).outcome === "uncertain"
      ) {
        expect(originalReview).toBeDefined();
        const probes = [
          ["duplicate-save", { ...request, id: 9001 }],
          ["duplicate-allow-once", { ...request, id: 9002, params: { ...request.params, choice: "allow-once" } }],
          ["fresh-review", { ...JSON.parse(originalReview!), id: 9003 }],
        ] as const;
        // Probe the still-live genuine RPC context before the producer unwinds.
        // Use the original dispatcher so these are real calls, not mock replies.
        for (const [name, probe] of probes) {
          const result = await dispatch(JSON.stringify(probe), ...rest);
          expect(result.ok, name).toBe(false);
          refused.push(name);
        }
      }
      return response;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const put = FileExecutionStore.prototype.putPayload;
    let attempts = 0;
    const spy = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(async function (
      this: FileExecutionStore,
      ref,
      input,
    ) {
      if (input.type === "agent.update" && input.payload.update.kind === "controlled-persistence-review-v1") {
        attempts++;
        if (attempts === 2) {
          if (boundary === "after") await Reflect.apply(put, this, [ref, input]);
          throw new Error("Controlled refreshed attestation publication failed");
        }
      }
      return Reflect.apply(put, this, [ref, input]);
    });
    try {
      await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow(/uncertain/);
      expect(refused).toEqual(["duplicate-save", "duplicate-allow-once", "fresh-review"]);
      expect(attempts).toBe(2);
      expect(c.phases).toEqual(["save"]);
      expect(c.observed).toEqual([]);
      const stores = fileStores(join(c.base, "workspace/.orca"));
      expect(await stores.events.readTypes("controlled", ["human.answered"])).toEqual([]);
      const approvals = await stores.events.readTypes("controlled", ["agent.permission"]);
      expect(
        approvals.filter((event) => event.type === "agent.permission" && event.payload.scopedApprovalRef),
      ).toHaveLength(1);
      const sidecar = JSON.parse(await readFile(join(c.base, "workspace/orca.permissions.json"), "utf8")) as {
        scopedRules: { records: { rule: { expiresAt: null } }[] };
      };
      // The standing grant committed before the failed handoff. Do not erase it,
      // manufacture successful execution or automatically repeat either operation.
      expect(sidecar.scopedRules.records).toHaveLength(1);
      expect(sidecar.scopedRules.records[0]!.rule.expiresAt).toBeNull();
    } finally {
      spy.mockRestore();
      dispatchSpy.mockRestore();
    }
  },
  30000,
);

it("observes the final runs directory with genuine metadata after all connected phases", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  Object.assign(c.options, { ownerDurationMs: 300000 });
  const target = join(c.base, "workspace/.orca/runs");
  const original = fs.lstatSync;
  const observed: number[] = [];
  const spy = vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof original>) => {
    const value = original(...args);
    if (args[0] === target) observed.push(c.phases.length);
    return value;
  });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts).toHaveLength(2);
    expect(observed).toEqual([3]);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  } finally {
    spy.mockRestore();
  }
}, 30000);

it("refuses a symlink substituted for the final runs directory", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  Object.assign(c.options, { ownerDurationMs: 300000 });
  const phase = c.options.phase.bind(c.options);
  const target = join(c.base, "workspace/.orca/runs");
  c.options.phase = (name, work) =>
    phase(name, async () => {
      await work();
      if (name === "rule-read") {
        const retained = join(c.base, "retained-original-runs");
        fs.renameSync(target, retained);
        fs.symlinkSync(retained, target, "dir");
      }
    });
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
}, 30000);

it("the fresh workflow refuses a lease actually removed after the owned answer settles", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const leases = fileStores(join(c.base, "workspace/.orca")).leases;
  let removed = false,
    factoryReached = 0;
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    settleOriginalDelivery: async () => {
      // This hook runs after the answer's ownership callback releases its mutex.
      // A supported operator release can now actually remove the live lease.
      const before = await leases.get("run:controlled");
      expect(before).toBeDefined();
      const released = await leases.forceRelease("run:controlled");
      expect(released).toEqual(before);
      expect(await leases.get("run:controlled")).toBeUndefined();
      removed = true;
    },
    beforeFreshAuthority: async () => {
      factoryReached++;
    },
  });
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(removed).toBe(true);
  expect(await leases.get("run:controlled")).toBeUndefined();
  expect(factoryReached).toBe(0);
  expect(c.observed).toEqual([]);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  expect(await stores.events.readTypes("controlled", ["human.answered"])).toHaveLength(1);
  const privateDir = join(c.base, "workspace/.orca/private-execution");
  const payloads = await Promise.all(
    (await readdir(privateDir))
      .filter((name) => name.endsWith(".payload.json"))
      .map(async (name) => {
        // Inspect actual persisted, authenticated records rather than plaintext
        // assumptions or the public projection, which omits these private kinds.
        const value = await readPrivateJson(privateDir, name);
        expect(value).toMatchObject({ runId: "controlled", type: expect.any(String), payload: expect.any(Object) });
        return value as { type: string; payload: { update?: { kind?: string } } };
      }),
  );
  const kinds = payloads.filter((value) => value.type === "agent.update").map((value) => value.payload.update?.kind);
  expect(kinds).toContain("controlled-deferred-intent-v1");
  expect(kinds).not.toContain("controlled-fresh-authority-v1");
  expect(kinds).not.toContain("controlled-authorization-v1");
}, 30000);

it.each(["operator-revoked", "physical-changed", "policy-tampered", "lost-ack"] as const)(
  "the fresh workflow refuses %s between intent and fresh execution",
  freshWorkflowRefuses,
  90000,
);
