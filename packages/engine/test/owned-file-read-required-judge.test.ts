/** Real strict policy + bound offline judge + fence. The existing fixture retains
 * explicit synthetic boot/grant authority and unchanged policy-per-ask coverage.
 * Persistence authority is designated by this test, not a real reviewer decision;
 * its actual sealed record cannot replace an execution verdict. No protected Save
 * or installed/production qualification is claimed by this narrower regression.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { strictDecisionBinding } from "@orca/core";
import { fileStores } from "@orca/store";
import type { ScopedPermissionCapturePort } from "@orca/agents";
import {
  createLocalReviewJudge,
  LOCAL_EVIDENCE_SCHEMA,
  LOCAL_ADVICE_SCHEMA,
} from "../../agents/src/review-judge/adapter.js";
import { offlineTransport, referenceMethod } from "../../agents/src/review-judge/offline.js";
import { ownedServiceFixture } from "./fixtures/owned-file-service.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.skipIf(process.platform !== "linux").each(["not-fit", "unavailable"] as const)(
  "actual required judge %s cannot be replaced by persistence-review metadata",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const f = await ownedServiceFixture();
    const root = await mkdtemp(join(tmpdir(), "orca-required-judge-persistence-"));
    const resourceReads: number[] = [];
    const nativeRead = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const result = nativeRead(...args);
      const info = fs.fstatSync(args[0]);
      if (info.isFile() && info.nlink === 0 && (info.mode & 0o777) === 0o400) resourceReads.push(result);
      return result;
    });
    try {
      const seed = (await f.binding()).capture();
      // Existing lower-level helper: actual typed store/rule, explicit synthetic
      // grant qualification. This configures the required judge; it does not Save.
      const rule = await f.save(seed.action, true);
      expect(rule.delegation).toMatchObject({ requirement: "required", onNotFit: "deny", allowWhenUnavailable: false });
      const invocation = (await f.binding()).capture();
      const signal = f.base.caller.signal;
      const initial = await invocation.evaluate(signal);
      if (initial.phase !== "needs-review") throw new Error("A genuinely configured required review was expected");
      expect(initial.review.requirement).toBe("required");
      const payload = {
        version: 1 as const,
        bindingRef: "test:required-projection",
        schemaVersion: LOCAL_EVIDENCE_SCHEMA,
        content: JSON.stringify({
          schema: LOCAL_EVIDENCE_SCHEMA,
          applicability: "mismatch",
          context: "complete",
          injection: "absent",
        }),
      };
      const request = {
        ...initial.review,
        approvedProjection: {
          kind: "parsed-json" as const,
          codecVersion: payload.schemaVersion,
          bindingRef: payload.bindingRef,
          privateRef: "test:required-private-projection",
        },
      };
      const transport =
        outcome === "not-fit"
          ? offlineTransport
          : {
              ...offlineTransport,
              version: "offline-unavailable-test/v1",
              invoke: async () => {
                throw new Error("Designated offline transport unavailable");
              },
            };
      const judge = createLocalReviewJudge({
        manifest: {
          ref: initial.review.judgeConfigRef,
          methodVersion: referenceMethod.version,
          transportVersion: transport.version,
          modelVersion: "none",
          promptVersion: "none",
          configVersion: referenceMethod.configVersion,
          inputSchema: LOCAL_EVIDENCE_SCHEMA,
          outputSchema: LOCAL_ADVICE_SCHEMA,
          destination: "offline:fixture",
          destinationPolicyRef: initial.review.destinationPolicyRef,
          projectionPolicyRevision: initial.review.projectionPolicyRevision,
        },
        method: referenceMethod,
        transport,
        limits: { maxPending: 1, maxCalls: 1, maxPayloadBytes: 2048, maxResponseBytes: 512, maxTimeoutMs: 100 },
      });
      const bound = await invocation.bindReview(initial.pending, request, signal);
      const assessed = await judge.assess(request, payload, signal);
      expect(assessed).toMatchObject(
        outcome === "not-fit"
          ? { execution: "evaluated", result: "not-fit" }
          : { execution: "unavailable", result: "indeterminate" },
      );
      const verdict = await invocation.completeReview(bound, assessed, signal);
      expect(verdict).toMatchObject(
        outcome === "not-fit"
          ? { outcome: "deny", reason: "judge-not-fit" }
          : { outcome: "indeterminate", reason: "judge-unavailable" },
      );
      const expectedReview = {
        result: outcome === "not-fit" ? ("failed" as const) : ("unavailable" as const),
        sourceRefs: [],
      };
      const executionReview = invocation.reviewProvenance();
      expect(executionReview).toEqual(expectedReview);
      const normalizedRef = `${invocation.action.bindingRef}:review`;
      const normalized = (await f.base.store.getPayload(
        invocation.action.invocation.runId,
        normalizedRef,
        "agent.update",
      )) as { update: { text: string } };
      expect(JSON.parse(normalized.update.text)).toMatchObject({ result: assessed, verdict });

      // A separate working persistence capability is available to this caller.
      // Its encrypted, sealed attestation retains the real failed/unavailable result.
      const execution = fileStores(root).execution,
        runId = invocation.action.invocation.runId,
        ref = randomUUID();
      await execution.putInputs({
        runId,
        workflowId: "required-judge-test",
        workflowVersion: "1",
        vars: {},
        sensitiveNames: [],
        secrets: [],
      });
      const attestation = {
        action: invocation.action,
        executionReview,
        normalizedRef,
        reviewer: "designated-test-persistence-reviewer",
        purpose: "permission persistence only",
      };
      await execution.putPayload(ref, {
        type: "agent.update",
        runId,
        payload: {
          stepRunId: invocation.action.invocation.stepRunId,
          sessionId: invocation.action.invocation.sessionId,
          update: { kind: "test-persistence-attestation", text: JSON.stringify(attestation) },
        },
      });
      const persistence: Required<Pick<ScopedPermissionCapturePort, "verifyPersistenceReview">> = {
        verifyPersistenceReview: async (action, refs) => {
          expect(action).toEqual(invocation.action);
          expect(refs).toEqual([ref]);
          const observed = await execution.observe!(
            async () => {
              const record = (await execution.getPayload(runId, ref, "agent.update")) as { update: { text: string } };
              expect(JSON.parse(record.update.text)).toEqual(attestation);
            },
            { maxRecords: 32 },
          );
          await observed.verifyUnchanged();
          return {
            assertCurrent: () => {
              invocation.assertCurrent();
              return observed.assertUnchanged!();
            },
          };
        },
      };
      const persistenceReview = { result: "passed" as const, sourceRefs: [ref] };
      const proof = await persistence.verifyPersistenceReview(invocation.action, persistenceReview.sourceRefs);
      expect(proof.assertCurrent()).toBeUndefined();
      expect(Reflect.set(executionReview, "result", "passed")).toBe(false);
      expect(Reflect.set(verdict, "outcome", "allow")).toBe(false);
      expect(Reflect.set(invocation, "reviewProvenance", () => ({ result: "passed", sourceRefs: [ref] }))).toBe(false);
      const relabeled = { ...structuredClone(executionReview), result: "passed" as const };
      expect(relabeled.result).toBe("passed");
      expect(invocation.reviewProvenance()).toEqual(expectedReview);
      const unregisteredAllow = {
        ...strictDecisionBinding(invocation.action),
        outcome: "allow" as const,
        authorizedBy: { kind: "rule" as const, ruleId: rule.ruleId, ruleRevision: rule.ruleRevision },
        judgeResultRef: persistenceReview.sourceRefs[0]!,
      };
      await expect(invocation.authorize(invocation.action, unregisteredAllow, signal)).rejects.toMatchObject({
        code: "RUN_STATE",
      });
      expect(await invocation.evaluate(signal)).toMatchObject({ phase: "final", verdict });
      expect(f.base.state.authWrites).toBe(0);
      expect(resourceReads).toEqual([]);

      // A fresh invocation of the same service/rule still requires an actual fit;
      // the unchanged unqualified fixture can execute after that genuine completion.
      const control = (await f.binding()).capture();
      expect((await f.run(control)).state).toBe("completed");
      expect(f.base.state.authWrites).toBe(1);
      expect(resourceReads).toEqual([f.parameters.length]);
      expect(invocation.action.coverage).toMatchObject({
        level: "policy-per-ask",
        evidence: { installedRefs: [], independentlyObservedEffects: false },
      });
    } finally {
      f.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
