/** Pending Save prerequisites, refusals and persistence of the fresh standing workflow.
 * Split out of controlled-standing-workflow.test.ts so the scenarios run beside each other, not in sequence.
 */
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fileStores } from "@orca/store";
import { LiveHumanInput, type LiveAnswerAuthority } from "@orca/engine";
import { CredentialStore } from "../../daemon/src/auth/credentials.js";
import * as daemonTransport from "../../daemon/src/server.js";
import * as protectedOwner from "../../daemon/src/protected-scoped-permission-owner.js";
import { runControlledOwnedReadTest } from "./controlled-owned-read-producer-expanded.js";
import { bootstrap, noSavedGrant, supervisor } from "./controlled-standing-workflow-fixture.js";

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
