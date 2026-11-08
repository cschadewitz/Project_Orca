/** Fresh Save expiry, cancellation and legacy Save ownership of the standing workflow.
 * Split out of core.test.ts so the scenarios run beside each other, not in sequence.
 */
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores, FileExecutionStore } from "@orca/store";
import * as daemonTransport from "../../../daemon/src/server.js";
import * as protectedOwner from "../../../daemon/src/protected-scoped-permission-owner.js";
import { runControlledOwnedReadTest } from "../controlled-owned-read/producer-expanded.js";
import { bootstrap, legacyBoundedSave, noSavedGrant, supervisor } from "./fixture.js";

it.each([0, 1])(
  "a fresh Save refuses at expiry plus %s milliseconds",
  async (delta) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    const realNow = Date.now.bind(Date);
    let fixed: number | undefined;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => fixed ?? realNow());
    Object.assign(c.options, {
      ownerDurationMs: 300000,
      pendingSaveIntent: true,
      beforeStandingIntentReview: async (authority: { expiresAt: number }) => {
        fixed = authority.expiresAt + delta;
      },
    });
    try {
      await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
      expect(c.observed.length).toBe(0);
      await noSavedGrant(c.base);
    } finally {
      clock.mockRestore();
    }
  },
  30000,
);

it.each(["save-cancel", "save-review-mutated", "save-cancel-current"] as const)(
  "pending Save %s cannot publish or read",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant, fault);
    Object.assign(c.options, { ownerDurationMs: 300000, pendingSaveIntent: true });
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed.length).toBe(0);
    await noSavedGrant(c.base);
  },
  30000,
);

it.each(["save-review-reentrant", "save-review-method-replaced"] as const)(
  "pending Save retains one original attempt under %s",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant, fault);
    Object.assign(c.options, { ownerDurationMs: 300000, pendingSaveIntent: true });
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts.length).toBe(2);
    const events = await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", [
      "agent.permission",
    ]);
    expect(events.filter((event) => event.type === "agent.permission" && event.payload.scopedApprovalRef).length).toBe(
      1,
    );
    expect(c.observed.map((item) => item.phase)).toEqual(["human-read", "rule-read"]);
  },
  30000,
);

it.each([
  ["review", "cancel"],
  ["verify-first", "cancel"],
  ["verify-approval", "cancel"],
] as const)("legacy bounded Save %s stops on %s without late publication", legacyBoundedSave, 45000);

it("legacy Save without an owned-review contract refuses before invoking reviewers while Deny remains available", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  Object.assign(c.options, { ownerDurationMs: 300000 });
  let calls = 0;
  const factory = protectedOwner.protectedScopedPermissionOwner;
  const ownerSpy = vi.spyOn(protectedOwner, "protectedScopedPermissionOwner").mockImplementation((options) => {
    Reflect.deleteProperty(options.captures, "standingGrantReviewScope");
    Object.assign(options.captures, {
      reviewStandingGrant: async () => {
        calls++;
        throw new Error("Unscoped reviewer must not run");
      },
      verifyStandingGrantReview: async () => {
        calls++;
        throw new Error("Unscoped verifier must not run");
      },
    });
    return factory(options);
  });
  const dispatch = daemonTransport.dispatch;
  let denied = false;
  const dispatchSpy = vi.spyOn(daemonTransport, "dispatch").mockImplementation(async (text, ...rest) => {
    const request = JSON.parse(text) as { method: string; params: Record<string, unknown> };
    const reply = await dispatch(text, ...rest);
    if (request.method === "scopedPermissions.review") {
      expect(reply.ok).toBe(true);
      if (reply.ok)
        expect(reply.result).toMatchObject({ standingReview: "unavailable", saveEligibility: "unavailable" });
    }
    if (request.method === "scopedPermissions.choose") {
      expect(reply.ok).toBe(false);
      const deny = await dispatch(
        JSON.stringify({ ...request, id: 9001, params: { ...request.params, choice: "deny" } }),
        ...rest,
      );
      expect(deny.ok).toBe(true);
      if (deny.ok) expect(deny.result).toMatchObject({ outcome: "answered" });
      denied = true;
    }
    return reply;
  });
  try {
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(denied).toBe(true);
    expect(c.observed).toEqual([]);
    await noSavedGrant(c.base);
  } finally {
    dispatchSpy.mockRestore();
    ownerSpy.mockRestore();
  }
}, 30000);

it("legacy Save retains ownership until a started standing-review publication settles", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  Object.assign(c.options, { ownerDurationMs: 300000 });
  let release!: () => void, entered!: () => void, invalidate!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const factory = protectedOwner.protectedScopedPermissionOwner;
  const ownerSpy = vi.spyOn(protectedOwner, "protectedScopedPermissionOwner").mockImplementation((options) => {
    invalidate = () => options.live.close();
    return factory(options);
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the actual store receiver.
  const put = FileExecutionStore.prototype.putPayload;
  const putSpy = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(async function (
    this: FileExecutionStore,
    ref,
    input,
  ) {
    const result = await Reflect.apply(put, this, [ref, input]);
    if (input.type === "agent.update" && input.payload.update.kind === "controlled-standing-review-v2") {
      entered();
      await gate;
    }
    return result;
  });
  let settled = false;
  const running = runControlledOwnedReadTest(c.base, "connected", c.options).finally(() => {
    settled = true;
  });
  void running.catch(() => undefined);
  try {
    await Promise.race([
      started,
      running.then(() => {
        throw new Error("Publication gate not reached");
      }),
    ]);
    invalidate();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    const mutex = join(c.base, "workspace/.orca/leases/run%3Acontrolled.json.mutation.lock");
    expect(fs.lstatSync(mutex).isDirectory()).toBe(true);
    expect(c.observed).toEqual([]);
    await noSavedGrant(c.base);
    release();
    await expect(running).rejects.toThrow();
    expect(settled).toBe(true);
    expect(fs.existsSync(mutex)).toBe(false);
    expect(c.observed).toEqual([]);
    await noSavedGrant(c.base);
  } finally {
    release();
    await running.catch(() => undefined);
    putSpy.mockRestore();
    ownerSpy.mockRestore();
  }
}, 30000);

it("cancellation releases a hanging Save reviewer without publishing", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant, "save-cancel-review");
  Object.assign(c.options, { ownerDurationMs: 300000, pendingSaveIntent: true, standingReviewerFault: "hanging" });
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(c.observed.length).toBe(0);
  await noSavedGrant(c.base);
}, 30000);

it("late reviewer completion after cancellation cannot append acceptance or publish", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant, "save-cancel-review");
  let release!: () => void;
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    beforeStandingIntentReview: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(typeof release).toBe("function");
  const path = join(c.base, "workspace/.orca/private-execution"),
    before = (await readdir(path)).sort();
  release();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect((await readdir(path)).sort()).toEqual(before);
  expect(c.observed.length).toBe(0);
  await noSavedGrant(c.base);
}, 30000);

it("the real clipped Save deadline releases a hanging reviewer after credential expiry", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  let window: { issuedAt: number; expiresAt: number } | undefined;
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    standingReviewerFault: "hanging",
    operatorCredentialTtlMs: 5000,
    beforeStandingIntentReview: async (value: { issuedAt: number; expiresAt: number }) => {
      window = value;
    },
  });
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(Boolean(window)).toBe(true);
  expect(window!.expiresAt - window!.issuedAt).toBeGreaterThan(0);
  expect(window!.expiresAt - window!.issuedAt).toBeLessThanOrEqual(5000);
  expect(Date.now()).toBeGreaterThanOrEqual(window!.expiresAt);
  expect(c.observed.length).toBe(0);
  await noSavedGrant(c.base);
}, 30000);

it("holds Save ownership until an already-started protected review publication settles", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant, "save-cancel-write");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    afterStandingIntentWrite: async () => {
      entered();
      await gate;
    },
  });
  let settled = false;
  const running = runControlledOwnedReadTest(c.base, "connected", c.options);
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started;
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  try {
    expect(settled).toBe(false);
    const lease = await fileStores(join(c.base, "workspace/.orca")).leases.get("run:controlled");
    expect(Boolean(lease?.guardedId)).toBe(true);
    expect(fs.lstatSync(join(c.base, "workspace/.orca/leases/run%3Acontrolled.json.mutation.lock")).isDirectory()).toBe(
      true,
    );
    await noSavedGrant(c.base);
  } finally {
    release();
  }
  await expect(running).rejects.toThrow();
  expect(fs.existsSync(join(c.base, "workspace/.orca/leases/run%3Acontrolled.json.mutation.lock"))).toBe(false);
  expect(c.observed.length).toBe(0);
  await noSavedGrant(c.base);
}, 30000);
