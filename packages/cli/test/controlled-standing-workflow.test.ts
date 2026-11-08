/** Fresh standing workflow. Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 * The scenarios that wait in real time live in the sibling controlled-standing-workflow-*.test.ts files.
 */
import fs from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores, FileExecutionStore, ProtectedEventStore } from "@orca/store";
import { readPrivateJson } from "../../store/src/protected-file.js";
import { LiveHumanInput, type LiveAnswerAuthority } from "@orca/engine";
import { CredentialStore } from "../../daemon/src/auth/credentials.js";
import * as daemonTransport from "../../daemon/src/server.js";
import * as protectedOwner from "../../daemon/src/protected-scoped-permission-owner.js";
import { runControlledOwnedReadTest } from "./controlled-owned-read-producer-expanded.js";
import {
  bootstrap,
  freshWorkflowRefuses,
  legacyBoundedSave,
  supervisor,
} from "./controlled-standing-workflow-fixture.js";

it.each([1, 2] as const)(
  "opening publication %s settles before independent private writes start",
  async (ordinal) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    Object.assign(c.options, { ownerDurationMs: 300000, pendingSaveIntent: true });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const append = ProtectedEventStore.prototype.append;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const put = FileExecutionStore.prototype.putPayload;
    let openings = 0;
    const writes: string[] = [];
    const appendSpy = vi.spyOn(ProtectedEventStore.prototype, "append").mockImplementation(async function (
      this: ProtectedEventStore,
      input,
    ) {
      const event = await Reflect.apply(append, this, [input]);
      if (input.type === "step.waiting" && ++openings === ordinal) {
        entered();
        await gate;
      }
      return event;
    });
    const putSpy = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(function (
      this: FileExecutionStore,
      ref,
      input,
    ) {
      if (input.type === "agent.update") writes.push(input.payload.update.kind);
      return Reflect.apply(put, this, [ref, input]);
    });
    const running = runControlledOwnedReadTest(c.base, "connected", c.options);
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error("Opening gate was not reached");
        }),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(writes.filter((kind) => kind === "controlled-baseline-v1").length).toBe(ordinal === 1 ? 0 : 1);
      expect(writes.includes("controlled-deferred-intent-v1")).toBe(false);
      expect(writes.includes("controlled-final-delivery-ack-v1")).toBe(false);
      expect(c.observed.length).toBe(0);
      release();
      const result = await running;
      expect(result.receipts.length).toBe(2);
      expect(writes.filter((kind) => kind === "controlled-baseline-v1").length).toBe(1);
      expect(writes.filter((kind) => kind === "controlled-deferred-intent-v1").length).toBe(1);
      expect(writes.filter((kind) => kind === "controlled-final-delivery-ack-v1").length).toBe(1);
    } finally {
      release();
      await running.catch(() => undefined);
      appendSpy.mockRestore();
      putSpy.mockRestore();
    }
  },
  // This holds publication gates and then completes all three phases. Allow a
  // finite full-fixture watchdog under contention; action/lease expiry and every
  // ownership, publication-order and no-premature-effect assertion stay intact.
  60000,
);

it.each([
  [1, "failure"],
  [1, "cancel"],
  [2, "failure"],
  [2, "cancel"],
] as const)(
  "opening publication %s %s drains the started append before returning",
  async (ordinal, failure) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    Object.assign(c.options, { ownerDurationMs: 300000, pendingSaveIntent: true });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const OriginalAbortController = globalThis.AbortController;
    const controllers: AbortController[] = [];
    // The controlled entry creates its run controller synchronously before its
    // first await. Capture that real controller; never fabricate a live query.
    vi.stubGlobal(
      "AbortController",
      class extends OriginalAbortController {
        constructor() {
          super();
          controllers.push(this);
        }
      },
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const append = ProtectedEventStore.prototype.append;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const put = FileExecutionStore.prototype.putPayload;
    let openings = 0,
      settled = false;
    const writes: string[] = [];
    const appendSpy = vi.spyOn(ProtectedEventStore.prototype, "append").mockImplementation(async function (
      this: ProtectedEventStore,
      input,
    ) {
      const event = await Reflect.apply(append, this, [input]);
      if (input.type === "step.waiting" && ++openings === ordinal) {
        entered();
        await gate;
        if (failure === "failure") throw new Error("Controlled opening completion lost");
      }
      return event;
    });
    const putSpy = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(function (
      this: FileExecutionStore,
      ref,
      input,
    ) {
      if (input.type === "agent.update") writes.push(input.payload.update.kind);
      return Reflect.apply(put, this, [ref, input]);
    });
    const closeSpy = vi.spyOn(LiveHumanInput.prototype, "close");
    const running = runControlledOwnedReadTest(c.base, "connected", c.options);
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error("Opening gate was not reached");
        }),
      ]);
      if (failure === "cancel") controllers[0]!.abort("Run cancelled while opening append remains pending");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
      if (failure === "cancel") expect(closeSpy).toHaveBeenCalledOnce();
      else expect(closeSpy).not.toHaveBeenCalled();
      expect(writes.filter((kind) => kind === "controlled-baseline-v1").length).toBe(ordinal === 1 ? 0 : 1);
      expect(writes.includes("controlled-deferred-intent-v1")).toBe(false);
      expect(writes.includes("controlled-final-delivery-ack-v1")).toBe(false);
      expect(c.observed.length).toBe(0);
      release();
      await expect(running).rejects.toThrow();
      expect(settled).toBe(true);
      const events = await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", [
        "human.answered",
      ]);
      expect(events.length).toBe(0);
    } finally {
      release();
      await running.catch(() => undefined);
      appendSpy.mockRestore();
      putSpy.mockRestore();
      closeSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  },
  30000,
);

it("saves the same pending grant after original action expiry using fresh bounded Save authority", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  const realNow = Date.now.bind(Date);
  let skew = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    beforeSaveChoice: async () => {
      skew = 56000;
    },
  });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts.length).toBe(2);
    expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
    expect(c.observed.map((item) => item.phase)).toEqual(["human-read", "rule-read"]);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    const events = await stores.events.readTypes("controlled", ["agent.permission"]);
    const marker = events.find((event) => event.type === "agent.permission" && event.payload.scopedApprovalRef);
    expect(Boolean(marker?.executionPayloadRef)).toBe(true);
    const payload = (await stores.execution.getPayload(
      "controlled",
      marker!.executionPayloadRef!,
      "agent.permission",
    )) as {
      entry: {
        version: number;
        acceptedAt: string;
        action: { expiresAt: string };
        intent: { capturedAt: number };
        saveAuthority: { issuedAt: number; expiresAt: number };
        command: { rule: { expiresAt: null } };
      };
    };
    const approval = payload.entry,
      accepted = Date.parse(approval.acceptedAt);
    expect(approval.version).toBe(3);
    expect(approval.intent.capturedAt).toBeLessThan(Date.parse(approval.action.expiresAt));
    expect(accepted).toBeGreaterThan(Date.parse(approval.action.expiresAt));
    expect(approval.saveAuthority.issuedAt).toBeLessThanOrEqual(accepted);
    expect(accepted).toBeLessThan(approval.saveAuthority.expiresAt);
    expect(approval.saveAuthority.expiresAt - approval.saveAuthority.issuedAt).toBeLessThanOrEqual(60000);
    expect(approval.command.rule.expiresAt).toBeNull();
  } finally {
    clock.mockRestore();
  }
  // Full-fixture watchdog only; the real action, Save and lease checks still apply.
}, 60000);

it("refreshes disclosure after its handle expires without expiring the pending intent", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const realNow = Date.now.bind(Date);
  let skew = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    refreshSaveReview: true,
    beforeSaveChoice: async () => {
      skew = 65000;
    },
  });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts.length).toBe(2);
    expect(c.observed.map((item) => item.phase)).toEqual(["human-read", "rule-read"]);
  } finally {
    clock.mockRestore();
  }
}, 30000);

async function noSavedGrant(base: string) {
  const document = JSON.parse(await readFile(join(base, "workspace/orca.permissions.json"), "utf8")) as {
    scopedRules: { records: unknown[] };
  };
  expect(document.scopedRules.records.length).toBe(0);
  const events = await fileStores(join(base, "workspace/.orca")).events.readTypes("controlled", ["agent.permission"]);
  expect(events.filter((event) => event.type === "agent.permission" && event.payload.scopedApprovalRef).length).toBe(0);
}

it.each(["current", "missing-reviewer", "missing-proof", "stale"] as const)(
  "projects persistence-only Save prerequisites through the actual RPC under %s",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant, fault === "missing-proof" ? "review-proof" : undefined);
    Object.assign(c.options, {
      ownerDurationMs: 300000,
      pendingSaveIntent: true,
      ...(fault === "missing-reviewer" ? { standingReviewerFault: "missing" } : {}),
      ...(fault === "stale"
        ? {
            beforeSaveChoice: async () =>
              fs.promises.appendFile(join(c.base, "workspace/.orca/workspace-identity/id"), "changed"),
          }
        : {}),
    });
    const phase = c.options.phase.bind(c.options);
    c.options.phase = (name, work) =>
      phase(name, async () => {
        await work();
        if (name === "save") throw new Error("Stopped after confirmed Save without execution");
      });
    const dispatch = daemonTransport.dispatch;
    let reviewed: Awaited<ReturnType<typeof dispatch>> | undefined,
      saved: Awaited<ReturnType<typeof dispatch>> | undefined;
    const spy = vi.spyOn(daemonTransport, "dispatch").mockImplementation(async (text, ...rest) => {
      const request = JSON.parse(text) as { method: string };
      const result = await dispatch(text, ...rest);
      if (request.method === "scopedPermissions.review") reviewed = result;
      if (request.method === "scopedPermissions.choose") saved = result;
      return result;
    });
    try {
      await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
      if (fault === "missing-proof") expect(reviewed?.ok).toBe(false);
      else {
        expect(reviewed?.ok).toBe(true);
        if (reviewed?.ok)
          expect(reviewed.result).toMatchObject({
            requiredReview: "unavailable",
            saveEligibility: fault === "missing-reviewer" ? "unavailable" : "eligible",
          });
      }
      if (fault === "current") {
        expect(saved?.ok).toBe(true);
        if (saved?.ok) expect(saved.result).toMatchObject({ outcome: "saved" });
        const document = JSON.parse(await readFile(join(c.base, "workspace/orca.permissions.json"), "utf8")) as {
          scopedRules: { records: unknown[] };
        };
        expect(document.scopedRules.records.length).toBe(1);
      } else {
        if (saved?.ok) expect(saved.result).not.toMatchObject({ outcome: "saved" });
        await noSavedGrant(c.base);
      }
      expect(c.observed).toEqual([]);
      expect(
        await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", ["human.answered"]),
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  },
  30000,
);

it.each([
  ["allow-once", "current"],
  ["deny", "current"],
  ["allow-once", "refreshed"],
  ["deny", "refreshed"],
  ["allow-once", "refreshed-expired"],
  ["deny", "refreshed-proof-mutated"],
  ["allow-once", "expiry-equality"],
  ["deny", "after-expiry"],
  ["allow-once", "cancel"],
  ["deny", "credential-revoked"],
  ["allow-once", "physical-changed"],
] as const)(
  "pending intent ordinary %s remains independently authorized under %s",
  async (choice, fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    let reviewerCalls = 0,
      acceptingChecks = 0,
      changed = false;
    Object.assign(c.options, {
      ownerDurationMs: 300000,
      pendingSaveIntent: true,
      refreshSaveReview: fault.startsWith("refreshed"),
      standingReviewerFault: "hanging",
      beforeStandingIntentReview: async () => {
        reviewerCalls++;
        throw new Error("An ordinary answer must not request standing review");
      },
    });
    const realNow = Date.now.bind(Date);
    let fixed: number | undefined;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => fixed ?? realNow());
    const createOwner = protectedOwner.protectedScopedPermissionOwner;
    let originalExpiry = 0,
      persistenceRef: string | undefined;
    const ownerSpy = vi.spyOn(protectedOwner, "protectedScopedPermissionOwner").mockImplementation((options) => {
      const owner = createOwner(options);
      const prepare = owner.prepare.bind(owner);
      if (typeof owner.assertAnswerCurrent !== "function") throw new Error("Original answer check is unavailable");
      const assertAnswerCurrent = owner.assertAnswerCurrent.bind(owner);
      return Object.freeze({
        ...owner,
        async prepare(...args: Parameters<typeof prepare>) {
          const review = await prepare(...args);
          originalExpiry = Date.parse(review.action.expiresAt);
          persistenceRef = review.persistenceReview?.sourceRefs[0];
          return review;
        },
        assertAnswerCurrent(...args: Parameters<typeof assertAnswerCurrent>) {
          // Observe the real accepting state without changing the frozen owner.
          // Save's separate pending-only assertion must still refuse then.
          if (changed) {
            acceptingChecks++;
            expect(() => owner.assertCurrent(...args)).toThrow();
          }
          return assertAnswerCurrent(...args);
        },
      });
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain the original receiver with Reflect.apply.
    const answer = LiveHumanInput.prototype.answer;
    const answerSpy = vi.spyOn(LiveHumanInput.prototype, "answer").mockImplementation(async function (
      this: LiveHumanInput,
      command,
      authority,
      afterAnswer,
    ) {
      const inspect = this.inspect.bind(this),
        close = this.close.bind(this);
      const wrapped: LiveAnswerAuthority = {
        actor: authority.actor,
        authorize: async (target, standing) => {
          if (!changed && inspect(target) === "accepting") {
            changed = true;
            if (fault === "expiry-equality" || fault === "after-expiry" || fault === "refreshed-expired")
              fixed = originalExpiry + (fault === "expiry-equality" ? 0 : 1);
            if (fault === "cancel") close();
            if (fault === "credential-revoked") {
              const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
              expect(await credentials.revoke(authority.actor.credentialId!)).toBe(true);
            }
            if (fault === "physical-changed")
              await fs.promises.appendFile(join(c.base, "workspace/.orca/workspace-identity/id"), "changed");
            if (fault === "refreshed-proof-mutated") {
              expect(persistenceRef).toBeDefined();
              const path = join(
                c.base,
                "workspace/.orca/private-execution",
                `${encodeURIComponent(persistenceRef!)}.payload.json`,
              );
              const bytes = await readFile(path);
              bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
              await writeFile(path, bytes);
            }
          }
          await authority.authorize(target, standing);
        },
      };
      return Reflect.apply(answer, this, [command, wrapped, afterAnswer]);
    });
    const dispatch = daemonTransport.dispatch;
    let selected: Awaited<ReturnType<typeof dispatch>> | undefined,
      duplicate: Awaited<ReturnType<typeof dispatch>> | undefined;
    const dispatchSpy = vi.spyOn(daemonTransport, "dispatch").mockImplementation(async (text, ...rest) => {
      const request = JSON.parse(text) as { method: string; params: { choice?: string } };
      if (request.method !== "scopedPermissions.choose") return dispatch(text, ...rest);
      request.params.choice = choice;
      selected = await dispatch(JSON.stringify(request), ...rest);
      duplicate = await dispatch(JSON.stringify(request), ...rest);
      return selected;
    });
    try {
      // The producer expects Save, so it stops after the substituted ordinary
      // answer. Inspect the actual authenticated bridge result and durable event.
      const error = await runControlledOwnedReadTest(c.base, "connected", c.options).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(changed, String(error)).toBe(true);
      const answered = fault === "current" || fault === "refreshed";
      // Current-store/credential publication checks can reject the whole RPC
      // after the accepting callback refuses. That must not expose an answer.
      const postflightRefusal = fault === "credential-revoked" || fault === "physical-changed";
      expect(selected?.ok).toBe(!postflightRefusal);
      if (selected?.ok) expect(selected.result).toMatchObject({ outcome: answered ? "answered" : "uncertain" });
      expect(duplicate?.ok).toBe(false);
      if (answered) expect(acceptingChecks).toBeGreaterThan(0);
      expect(reviewerCalls).toBe(0);
      const events = await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", [
        "human.answered",
      ]);
      expect(events.filter((event) => event.type === "human.answered").map((event) => event.payload.answer)).toEqual(
        answered ? [choice === "deny" ? "deny" : "once"] : [],
      );
      expect(c.observed).toEqual([]);
      await noSavedGrant(c.base);
    } finally {
      dispatchSpy.mockRestore();
      answerSpy.mockRestore();
      ownerSpy.mockRestore();
      clock.mockRestore();
    }
  },
  30000,
);

it.each([
  "operator-revoked",
  "reviewer-revoked",
  "lease-lost",
  "physical-changed",
  "policy-changed",
  "expired-handle",
] as const)(
  "a pending Save refuses %s before issuing or publishing a grant",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    Object.assign(c.options, {
      ownerDurationMs: 300000,
      pendingSaveIntent: true,
      beforeSaveChoice: async () => {
        if (fault === "expired-handle") skew = 65000;
        if (fault === "operator-revoked" || fault === "reviewer-revoked") {
          const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
          const principal = fault === "operator-revoked" ? "controlled-test-operator" : "controlled-test-reviewer";
          const record = credentials.list().find((value) => value.principal === principal)!;
          expect(await credentials.revoke(record.id)).toBe(true);
        }
        if (fault === "lease-lost")
          await fileStores(join(c.base, "workspace/.orca")).leases.forceRelease("run:controlled");
        if (fault === "physical-changed")
          await fs.promises.appendFile(join(c.base, "workspace/.orca/workspace-identity/id"), "changed");
        if (fault === "policy-changed")
          await fs.promises.appendFile(join(c.base, "workspace/orca.permissions.json"), "\n");
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
