/** Actual rule tombstone/read boundary, retaining #734's explicitly synthetic approval assumption. */
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { ownedServiceFixture } from "./fixtures/owned-file-service.js";

it.skipIf(process.platform !== "linux")(
  "a revoked exact stored rule stops an issued permit and a second fresh invocation",
  async () => {
    const f = await ownedServiceFixture();
    const reads = vi.spyOn(fs, "readSync");
    try {
      const first = (await f.binding()).capture();
      // Existing lower-level synthetic approval helper, not protected Save acceptance.
      const rule = await f.save(first.action);
      const bound = await f.binding();
      const invocation = bound.capture();
      const verdict = await f.allow(invocation);
      if (verdict.outcome !== "allow") throw new Error("Existing fixture rule expected");
      const permit = await invocation.authorize(invocation.action, verdict, f.base.caller.signal);
      await f.store.revokeScopedRule(
        {
          ruleId: rule.ruleId,
          ruleRevision: rule.ruleRevision,
          expectedRevision: (await f.store.read()).revision,
          approvalRecordRef: "test:explicit-revoke",
        },
        {
          actor: { principalId: "test:operator", credentialId: "test:credential" },
          authorizeGrant: async () => f.base.state.snapshot.authority.authorityRevision,
          verifyApproval: async () => ({ scopeEvidenceRef: "test:scope" }),
          assertCommitCurrent: () => undefined,
        },
      );
      expect((await invocation.dispatch(permit, f.base.caller.signal)).state).toBe("not-dispatched");
      expect((await invocation.dispatch(permit, f.base.caller.signal)).state).toBe("not-dispatched");
      const fresh = (await f.binding()).capture();
      expect(await fresh.evaluate(f.base.caller.signal)).toMatchObject({
        phase: "final",
        verdict: { outcome: "deny", reason: "rule-revoked" },
      });
      expect((await f.store.read()).document.scopedRules.records).toMatchObject([{ rule: { status: "revoked" } }]);
      expect(reads).not.toHaveBeenCalled();
      expect(f.outputs).toEqual([]);
    } finally {
      reads.mockRestore();
      f.dispose();
    }
  },
);
