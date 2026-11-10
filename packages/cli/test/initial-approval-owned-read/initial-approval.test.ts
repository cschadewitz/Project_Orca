/** Initial-query intent controls with actual authenticated RPC and disposable physical scope.
 * Test supervisor/bootstrap qualification is an explicit assumption, not independent effect proof.
 */
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores, FileExecutionStore, lapsed } from "@orca/store";
import { LiveHumanInput, type LiveAnswerAuthority } from "@orca/engine";
import { CredentialStore } from "../../../daemon/src/auth/credentials.js";
import * as daemonTransport from "../../../daemon/src/server.js";
import * as protectedOwner from "../../../daemon/src/protected-scoped-permission-owner.js";
import * as ownedService from "../../../engine/src/owned-file-read-service.js";
import { runControlledOwnedReadTest } from "../controlled-owned-read/producer-expanded.js";
import { bootstrap, noSavedGrant, semantics, supervisor } from "./fixture.js";

it("Save after the initial preview expires retires the reservation without answering or reading", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const realNow = Date.now.bind(Date);
  let skew = 0,
    factoryCalls = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    initialApprovalIntent: true,
    pendingSaveIntent: true,
    initialAnswerChoice: "save",
    refreshSaveReview: true,
    beforeSaveChoice: async () => {
      skew = 120000;
    },
    beforeFreshAuthority: async () => {
      factoryCalls++;
    },
  });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts).toEqual([]);
    expect(result.authorizationRefs).toEqual([]);
    expect(factoryCalls).toBe(0);
    expect(c.observed).toEqual([]);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    expect(await stores.events.readTypes("controlled", ["human.requested"])).toHaveLength(1);
    expect(await stores.events.readTypes("controlled", ["human.answered"])).toEqual([]);
    const document = JSON.parse(await readFile(join(c.base, "workspace/orca.permissions.json"), "utf8")) as {
      scopedRules: { records: { rule: { version: number; expiresAt: null; status: string } }[] };
    };
    expect(document.scopedRules.records).toHaveLength(1);
    expect(document.scopedRules.records[0]!.rule).toMatchObject({ version: 2, expiresAt: null, status: "approved" });
    const records = await semantics(c.base, result.semanticRefs);
    expect(records.some((record) => record.kind === "controlled-fresh-authority-v1")).toBe(false);
    // The trusted producer also asserts the retained preview rejects and the
    // old prepared execution cannot be reopened after Save retirement.
  } finally {
    clock.mockRestore();
  }
}, 30000);

it.each([false, true])(
  "the initial query uses a fresh action only after its own answer (old preview expired=%s)",
  async (expired) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    let factoryCalls = 0;
    Object.assign(c.options, {
      ownerDurationMs: 300000,
      initialApprovalIntent: true,
      pendingSaveIntent: true,
      initialAnswerChoice: "allow-once",
      refreshSaveReview: expired,
      beforeSaveChoice: async () => {
        if (expired) skew = 120000;
      },
      beforeFreshAuthority: async () => {
        factoryCalls++;
      },
    });
    const dispatch = daemonTransport.dispatch;
    let firstHandle: string | undefined;
    let stale: Awaited<ReturnType<typeof dispatch>> | undefined;
    let duplicate: Awaited<ReturnType<typeof dispatch>> | undefined;
    const spy = vi.spyOn(daemonTransport, "dispatch").mockImplementation(async (text, ...rest) => {
      const request = JSON.parse(text) as { method: string; params: { handle?: string; choice?: string } };
      if (request.method === "scopedPermissions.choose" && expired) {
        expect(firstHandle).toBeDefined();
        stale = await dispatch(
          JSON.stringify({ ...request, params: { ...request.params, handle: firstHandle } }),
          ...rest,
        );
        expect(stale.ok).toBe(false);
      }
      const result = await dispatch(text, ...rest);
      if (request.method === "scopedPermissions.review" && result.ok) {
        const review = result.result as { handle: string; pendingExecutionIntent?: boolean };
        firstHandle ??= review.handle;
        expect(review.pendingExecutionIntent).toBe(true);
      }
      if (request.method === "scopedPermissions.choose") {
        expect(request.params.choice).toBe("allow-once");
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.result).toMatchObject({ outcome: "answered" });
        duplicate = await dispatch(text, ...rest);
      }
      return result;
    });
    try {
      const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
      expect(result.receipts).toHaveLength(1);
      expect(result.authorizationRefs).toHaveLength(1);
      expect(factoryCalls).toBe(1);
      expect(duplicate?.ok).toBe(false);
      expect(c.observed.map((effect) => effect.bytes)).toEqual(["spos"]);
      await noSavedGrant(c.base);
      const stores = fileStores(join(c.base, "workspace/.orca"));
      const questions = await stores.events.readTypes("controlled", ["human.requested"]);
      const answers = await stores.events.readTypes("controlled", ["human.answered"]);
      expect(questions).toHaveLength(1);
      expect(answers).toHaveLength(1);
      if (answers[0]?.type === "human.answered" && questions[0]?.type === "human.requested") {
        expect(answers[0].payload.requestId).toBe(questions[0].payload.requestId);
        expect(answers[0].payload.answer).toBe("once");
      }
      const records = await semantics(c.base, result.semanticRefs);
      const index = (kind: string) => records.findIndex((record) => record.kind === kind);
      expect(index("controlled-initial-deferred-intent-v1")).toBeGreaterThanOrEqual(0);
      expect(index("controlled-initial-deferred-intent-v1")).toBeLessThan(index("controlled-final-delivery-ack-v1"));
      expect(index("controlled-final-delivery-ack-v1")).toBeGreaterThanOrEqual(0);
      expect(index("controlled-fresh-authority-v1")).toBeGreaterThan(index("controlled-final-delivery-ack-v1"));
      const fresh = records.find((record) => record.kind === "controlled-fresh-authority-v1")!.value as {
        observedAt: number;
        leaseExpiresAt: number;
      };
      const captures = records
        .filter((record) => ["controlled-initial-preview-v1", "controlled-capture-v1"].includes(record.kind))
        .map(
          (record) =>
            record.value.action as { actionId: string; expiresAt: string; invocation: { invocationId: string } },
        );
      expect(captures).toHaveLength(2);
      expect(captures[0]!.actionId).not.toBe(captures[1]!.actionId);
      expect(captures[0]!.invocation.invocationId).toBe(captures[1]!.invocation.invocationId);
      if (expired) expect(fresh.observedAt).toBeGreaterThan(Date.parse(captures[0]!.expiresAt));
      expect(Date.parse(captures[1]!.expiresAt)).toBeGreaterThan(fresh.observedAt);
      expect(Date.parse(captures[1]!.expiresAt)).toBeLessThanOrEqual(fresh.leaseExpiresAt);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  },
  30000,
);

it("denying the initial query after the preview expiry creates no action, grant or read", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const realNow = Date.now.bind(Date);
  let skew = 0,
    factoryCalls = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    initialApprovalIntent: true,
    pendingSaveIntent: true,
    initialAnswerChoice: "deny",
    refreshSaveReview: true,
    beforeSaveChoice: async () => {
      skew = 120000;
    },
    beforeFreshAuthority: async () => {
      factoryCalls++;
    },
  });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    expect(result.receipts).toEqual([]);
    expect(result.authorizationRefs).toEqual([]);
    expect(factoryCalls).toBe(0);
    expect(c.observed).toEqual([]);
    await noSavedGrant(c.base);
    const answers = await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", [
      "human.answered",
    ]);
    expect(answers).toHaveLength(1);
    if (answers[0]?.type === "human.answered") expect(answers[0].payload.answer).toBe("deny");
  } finally {
    clock.mockRestore();
  }
}, 30000);

it.each([
  "operator-revoked",
  "physical-changed",
  "lease-expired",
  "cancel",
  "lost-ack",
  "credential-during-acceptance",
  "cancel-during-acceptance",
  "operator-revoked-after-ack",
  "reviewer-revoked",
  "proof-mutated",
] as const)(
  "the initial query refuses %s without fresh execution or a grant",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant, fault === "lost-ack" ? "lost-ack" : undefined);
    let factoryCalls = 0;
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    let persistenceRef: string | undefined;
    const createOwner = protectedOwner.protectedScopedPermissionOwner;
    const ownerSpy = vi.spyOn(protectedOwner, "protectedScopedPermissionOwner").mockImplementation((options) => {
      const owner = createOwner(options),
        prepare = owner.prepare.bind(owner);
      return Object.freeze({
        ...owner,
        prepare: async (...args: Parameters<typeof prepare>) => {
          const review = await prepare(...args);
          persistenceRef = review.persistenceReview?.sourceRefs[0];
          return review;
        },
      });
    });
    const revokeOperator = async () => {
      const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
      const operator = credentials.list().find((record) => record.principal === "controlled-test-operator")!;
      expect(await credentials.revoke(operator.id)).toBe(true);
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply retains the real registry receiver.
    const answer = LiveHumanInput.prototype.answer;
    const answerSpy = vi.spyOn(LiveHumanInput.prototype, "answer").mockImplementation(async function (
      this: LiveHumanInput,
      command,
      authority,
      afterAnswer,
    ) {
      let changed = false;
      const wrapped: LiveAnswerAuthority = {
        actor: authority.actor,
        authorize: async (target, standing) => {
          if (!changed && this.inspect(target) === "accepting") {
            changed = true;
            if (fault === "credential-during-acceptance") await revokeOperator();
            if (fault === "cancel-during-acceptance") this.close();
          }
          await authority.authorize(target, standing);
        },
      };
      return Reflect.apply(answer, this, [command, wrapped, afterAnswer]);
    });
    Object.assign(c.options, {
      ownerDurationMs: 300000,
      initialApprovalIntent: true,
      pendingSaveIntent: true,
      initialAnswerChoice: "allow-once",
      refreshSaveReview: true,
      ...(fault === "cancel" ? { fault: "save-cancel" } : {}),
      beforeSaveChoice: async () => {
        skew = fault === "lease-expired" ? 300000 : 120000;
        if (fault === "physical-changed")
          await fs.promises.appendFile(join(c.base, "workspace/.orca/workspace-identity/id"), "changed");
        if (fault === "operator-revoked") {
          await revokeOperator();
        }
        if (fault === "reviewer-revoked") {
          const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
          const reviewer = credentials.list().find((record) => record.principal === "controlled-test-reviewer")!;
          expect(await credentials.revoke(reviewer.id)).toBe(true);
        }
        if (fault === "proof-mutated") {
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
      },
      beforeFreshAuthority: async () => {
        factoryCalls++;
        if (fault === "operator-revoked-after-ack") await revokeOperator();
      },
    });
    try {
      await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
      expect(factoryCalls).toBe(fault === "operator-revoked-after-ack" ? 1 : 0);
      expect(c.observed).toEqual([]);
      await noSavedGrant(c.base);
      const answers = await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", [
        "human.answered",
      ]);
      expect(answers).toHaveLength(fault === "lost-ack" || fault === "operator-revoked-after-ack" ? 1 : 0);
    } finally {
      answerSpy.mockRestore();
      ownerSpy.mockRestore();
      clock.mockRestore();
    }
  },
  30000,
);

it("the initial answer cannot create fresh authority before its final owned acknowledgement", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  let entered!: () => void,
    release!: () => void,
    factoryCalls = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    initialApprovalIntent: true,
    pendingSaveIntent: true,
    initialAnswerChoice: "allow-once",
    settleOriginalDelivery: async () => {
      entered();
      await gate;
    },
    beforeFreshAuthority: async () => {
      factoryCalls++;
    },
  });
  const running = runControlledOwnedReadTest(c.base, "connected", c.options);
  try {
    await Promise.race([
      started,
      running.then(() => {
        throw new Error("Final acknowledgement gate was not reached");
      }),
    ]);
    expect(factoryCalls).toBe(0);
    expect(c.observed).toEqual([]);
    // The final ACK hook runs after the registry's actual mutation callback.
    // Its mutex may be released; the real run lease must still be live, and
    // fresh authority remains forbidden until the ACK itself settles.
    const lease = await fileStores(join(c.base, "workspace/.orca")).leases.get("run:controlled");
    expect(lease?.guardedId).toBeTruthy();
    expect(lease && lapsed(lease, Date.now())).toBe(false);
    release();
    const result = await running;
    expect(result.receipts).toHaveLength(1);
    expect(factoryCalls).toBe(1);
    expect(c.observed.map((effect) => effect.bytes)).toEqual(["spos"]);
    await noSavedGrant(c.base);
  } finally {
    release();
    await running.catch(() => undefined);
  }
}, 30000);

it.each(["missing-verifier", "missing-proof", "invalid-window", "inherited-capability"] as const)(
  "an incomplete pending execution binding refuses %s before any answer",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    let factoryCalls = 0;
    Object.assign(c.options, {
      ownerDurationMs: 300000,
      initialApprovalIntent: true,
      pendingSaveIntent: true,
      initialAnswerChoice: "allow-once",
      beforeFreshAuthority: async () => {
        factoryCalls++;
      },
    });
    const createOwner = protectedOwner.protectedScopedPermissionOwner;
    const ownerSpy = vi.spyOn(protectedOwner, "protectedScopedPermissionOwner").mockImplementation((options) => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- The exact source receiver is retained with bind below.
      const { verifyPendingExecutionReview: verifier, ...remaining } = options.captures;
      const snapshot = options.captures.snapshot.bind(options.captures);
      return createOwner({
        ...options,
        captures: {
          ...remaining,
          ...(fault !== "missing-verifier" && verifier
            ? { verifyPendingExecutionReview: verifier.bind(options.captures) }
            : {}),
          snapshot: (capture) => {
            const value = snapshot(capture);
            if (!value.pendingExecution) return value;
            if (fault === "missing-proof") {
              const { persistenceReview: _proof, ...rest } = value;
              return rest;
            }
            return {
              ...value,
              pendingExecution:
                fault === "invalid-window"
                  ? { ...value.pendingExecution, executionWindowMs: 60001 }
                  : fault === "inherited-capability"
                    ? (Object.create(value.pendingExecution) as typeof value.pendingExecution)
                    : value.pendingExecution,
            };
          },
        },
      });
    });
    try {
      await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
      expect(factoryCalls).toBe(0);
      expect(c.observed).toEqual([]);
      expect(
        await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", ["human.answered"]),
      ).toEqual([]);
      await noSavedGrant(c.base);
    } finally {
      ownerSpy.mockRestore();
    }
  },
  30000,
);

it("cancellation drains a started fresh capture write under the real lease before removing fixtures", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    initialApprovalIntent: true,
    pendingSaveIntent: true,
    initialAnswerChoice: "allow-once",
  });
  const createService = ownedService.createOwnedFileReadServiceForTest;
  let service: ReturnType<typeof createService> | undefined;
  const serviceSpy = vi.spyOn(ownedService, "createOwnedFileReadServiceForTest").mockImplementation((options) => {
    service = createService(options);
    return service;
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply retains the actual protected store receiver.
  const put = FileExecutionStore.prototype.putPayload;
  const putSpy = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(async function (
    this: FileExecutionStore,
    ref,
    input,
  ) {
    const result = await Reflect.apply(put, this, [ref, input]);
    if (input.type === "agent.update" && input.payload.update.kind === "controlled-capture-v1") {
      entered();
      await gate;
    }
    return result;
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
  try {
    await Promise.race([
      started,
      running.then(() => {
        throw new Error("Actual fresh capture write did not start");
      }),
    ]);
    expect(service).toBeDefined();
    const current = service!;
    current.close();
    let drained = false;
    const draining = current.closeAndDrain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    expect(fs.existsSync(current.root)).toBe(true);
    expect(fs.lstatSync(join(c.base, "workspace/.orca/leases/run%3Acontrolled.json.mutation.lock")).isDirectory()).toBe(
      true,
    );
    expect(c.observed).toEqual([]);
    release();
    await expect(running).rejects.toThrow();
    await draining;
    expect(fs.existsSync(current.root)).toBe(false);
    expect(fs.existsSync(join(c.base, "workspace/.orca/leases/run%3Acontrolled.json.mutation.lock"))).toBe(false);
    expect(c.observed).toEqual([]);
    expect(
      await fileStores(join(c.base, "workspace/.orca")).events.readTypes("controlled", ["human.answered"]),
    ).toHaveLength(1);
    await noSavedGrant(c.base);
  } finally {
    release();
    await running.catch(() => undefined);
    putSpy.mockRestore();
    serviceSpy.mockRestore();
  }
}, 30000);
