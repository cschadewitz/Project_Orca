/** Disposable subprocess fixture: synthetic ownership and exact-rule approvals, never a live config. */
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { bindInactiveTypedSidecarOwner, createInactiveTypedSidecarStore } from "../src/typed-sidecar.js";
import { replacePermissionPolicyFile } from "../src/permissions.js";
import { strictPermissionRuleRevision } from "../src/strict-permission-source.js";
import { ruleFixture } from "./strict-permission-fixtures.js";
const [file, mode, expectedRevision, ruleId, ruleRevision] = process.argv.slice(2);
if (!file || !mode || !expectedRevision) throw new Error("missing synthetic fixture input");
const marker = {
  version: 1,
  workspaceRef: "test:workspace",
  sidecarRef: "test:sidecar",
  format: "orca-permissions-v2",
  minimumWriterContract: "orca-typed-sidecar-v1",
  rootBindingRef: "test:original-root-binding",
  enrollmentRef: "test:enrollment",
  state: "enrolled",
} as const;
const owner = bindInactiveTypedSidecarOwner({
  file,
  marker,
  lockTimeoutMs: 40,
  checkCompatibility: async () => marker,
  qualify: async () => {
    throw new Error("not evaluated by lock fixture");
  },
});
const store = createInactiveTypedSidecarStore(owner);
let paused = false;
const authority = {
  actor: { principalId: "test:principal", credentialId: "test:credential" },
  authorizeGrant: async () => "test:authority",
  verifyApproval: async () => {
    if (mode === "pause" && !paused) {
      paused = true;
      process.send?.({ state: "locked" });
      const [message] = await once(process, "message");
      if (message !== "continue") throw new Error("synthetic writer not resumed");
    }
    return { scopeEvidenceRef: "test:scope" };
  },
};
try {
  if (mode === "legacy")
    await replacePermissionPolicyFile(
      file,
      { version: 1, agents: {} },
      {
        expectedRevision,
        lock: { timeoutMs: 40, staleMs: 0 },
      },
    );
  else if (mode === "revoke") {
    if (!ruleId || !ruleRevision) throw new Error("missing synthetic target");
    await store.revokeScopedRule(
      { ruleId, ruleRevision, expectedRevision, approvalRecordRef: "test:revoke" },
      authority,
    );
  } else {
    const rule = { ...ruleFixture(), ruleId: "child-rule" };
    await store.createScopedRule(
      {
        rule: { ...rule, ruleRevision: strictPermissionRuleRevision(rule) },
        expectedRevision,
        approvalRecordRef: "test:child-approval",
      },
      authority,
    );
  }
  process.send?.({ state: "saved" });
} catch (error) {
  process.send?.({
    state: "refused",
    code: (error as { code?: string }).code,
    unchanged: await readFile(file, "utf8"),
  });
} finally {
  process.disconnect?.();
}
