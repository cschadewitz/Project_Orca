/** Real closed service/strict judge plumbing; existing fixture qualification stays explicitly synthetic. */
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { strictDecisionBinding, type PolicyPortV1 } from "@orca/core";
import { ownedServiceFixture } from "./fixtures/owned-file-service.js";

it.skipIf(process.platform !== "linux")(
  "required-review provenance comes from actual bound completion, not an allow verdict",
  async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const f = await ownedServiceFixture();
    try {
      const first = (await f.binding()).capture();
      await f.save(first.action, true); // Existing lower-level synthetic approval helper only.
      const invocation = (await f.binding()).capture();
      expect(invocation.reviewProvenance()).toEqual({ result: "unavailable", sourceRefs: [] });
      const verdict = await f.allow(invocation); // Actual strict policy, offline judge and record writer.
      if (verdict.outcome !== "allow" || !verdict.judgeResultRef) throw new Error("Actual completed review expected");
      expect(invocation.reviewProvenance()).toEqual({ result: "passed", sourceRefs: [verdict.judgeResultRef] });
      const record = await f.base.store.getPayload(
        invocation.action.invocation.runId,
        verdict.judgeResultRef,
        "agent.update",
      );
      expect(record).toMatchObject({ update: { kind: "test-normalized-review" } });
      expect(invocation.action.coverage.level).toBe("policy-per-ask");
      expect(invocation.action.coverage.evidence.installedRefs).toEqual([]);
      expect(invocation.action.offeredChoices).toEqual([]);
    } finally {
      f.dispose();
      vi.useRealTimers();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "a policy-returned human reference cannot mint a permit without original delivery",
  async () => {
    const f = await ownedServiceFixture();
    const reads = vi.spyOn(fs, "readSync");
    try {
      const binding = await f.binding();
      const policy: PolicyPortV1 = {
        version: 1,
        evaluate: async (action) => ({
          phase: "final",
          verdict: {
            ...strictDecisionBinding(action),
            outcome: "allow",
            authorizedBy: { kind: "human", acceptedAnswerRef: "forged-durable-event-reference" },
            judgeResultRef: "forged-review-reference",
          },
        }),
        bindReview: async () => {
          throw new Error("No review");
        },
        completeReview: async () => {
          throw new Error("No review");
        },
      };
      const invocation = f.service.capture(binding.owner, f.parameters, policy, f.base.evidence);
      const evaluated = await invocation.evaluate(f.base.caller.signal);
      if (evaluated.phase !== "final" || evaluated.verdict.outcome !== "allow")
        throw new Error("Injected test verdict expected");
      expect(invocation.reviewProvenance()).toEqual({ result: "unavailable", sourceRefs: [] });
      await expect(invocation.authorize(invocation.action, evaluated.verdict, f.base.caller.signal)).rejects.toThrow();
      expect(f.base.state.authWrites).toBe(0);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      f.dispose();
    }
  },
);
