/** Inactive owner binding: no wire grant method and no live policy mutations. */
import { describe, expect, it, vi } from "vitest";
import { strictPermissionRuleRevision } from "@orca/agents";
import { ruleFixture } from "../../agents/test/strict-permission-fixtures.js";
import { Authorizer, OwnershipStore, type Principal, type ResourceResolver } from "../src/auth/index.js";
const original: Principal = {
  id: "alice",
  kind: "credential",
  credentialId: "alice-token",
  permissions: new Set(["permissions.grant"]),
  scope: { workflows: "*", runs: "all" },
};
const resolver: ResourceResolver = {
  run: async () => undefined,
  inputRun: async () => undefined,
  artifactRun: async () => undefined,
  claimRun: async () => undefined,
  workflowExists: () => false,
};
function fixture(principal = structuredClone(original)) {
  let current = principal;
  const authorizer = new Authorizer({ ownership: new OwnershipStore(), resolver, currentPrincipal: () => current });
  const readAuthorityRevision = vi.fn(async () => "authority-current");
  const verifyApproval = vi.fn(async () => ({ scopeEvidenceRef: "protected:scope" }));
  const assertCommitCurrent = vi.fn(() => undefined);
  const authority = authorizer.scopedRuleGrantAuthority(principal, {
    readAuthorityRevision,
    verifyApproval,
    assertCommitCurrent,
  });
  return {
    authority,
    principal,
    readAuthorityRevision,
    verifyApproval,
    assertCommitCurrent,
    setCurrent: (p: Principal) => {
      current = p;
    },
  };
}
describe("inactive original-principal typed grant authority", () => {
  it("uses the captured original credential and existing permissions.grant check", async () => {
    const f = fixture();
    expect(f.authority.actor).toEqual({ principalId: "alice", credentialId: "alice-token" });
    expect(await f.authority.authorizeGrant()).toBe("authority-current");
    f.setCurrent({ ...original, permissions: new Set(["inputs.answer", "config.write"]) });
    await expect(f.authority.authorizeGrant()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
  it.each([
    { ...original, id: "bob" },
    { ...original, credentialId: "replacement-token" },
    { ...original, permissions: new Set<"permissions.grant">() },
    { ...original, scope: { workflows: ["restricted"], runs: "all" as const } },
    { ...original, scope: { workflows: "*" as const, runs: "owned" as const } },
  ])("refuses substituted/revoked/restricted current principal %j", async (current) => {
    const f = fixture();
    f.setCurrent(current);
    await expect(f.authority.authorizeGrant()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(f.readAuthorityRevision).not.toHaveBeenCalled();
  });
  it("does not widen an originally absent grant when a credential later gains one", async () => {
    const f = fixture({ ...original, permissions: new Set() });
    f.setCurrent(original);
    await expect(f.authority.authorizeGrant()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
  it("rechecks current authority after the protected revision read awaits", async () => {
    const f = fixture();
    f.readAuthorityRevision.mockImplementationOnce(async () => {
      f.setCurrent({ ...original, permissions: new Set() });
      return "authority-revoked";
    });
    await expect(f.authority.authorizeGrant()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
  it("captures the original actor and ceiling before caller mutation", async () => {
    const f = fixture();
    Object.assign(f.principal, { id: "attacker", credentialId: "attacker-token" });
    f.setCurrent(original);
    expect(await f.authority.authorizeGrant()).toBe("authority-current");
    expect(f.authority.actor.principalId).toBe("alice");
  });
  it("requires a current-principal resolver and protected authority revision", async () => {
    const authorizer = new Authorizer({ ownership: new OwnershipStore(), resolver });
    const f = fixture();
    const unavailable = authorizer.scopedRuleGrantAuthority(original, {
      readAuthorityRevision: f.readAuthorityRevision,
      verifyApproval: f.verifyApproval,
      assertCommitCurrent: () => undefined,
    });
    await expect(unavailable.authorizeGrant()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    f.readAuthorityRevision.mockResolvedValueOnce("");
    await expect(f.authority.authorizeGrant()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
});

it("synchronous commit assertion rechecks original credentials after the asynchronous authority observation", async () => {
  const f = fixture();
  const authorityRevision = await f.authority.authorizeGrant();
  const command = {
    rule: { ...ruleFixture(), ruleRevision: strictPermissionRuleRevision(ruleFixture()) },
    expectedRevision: "a".repeat(64),
    approvalRecordRef: "protected:approval",
  };
  f.setCurrent({ ...original, permissions: new Set() });
  expect(() =>
    f.authority.assertCommitCurrent(command, f.authority.actor, {
      authorityRevision,
      scopeEvidenceRef: "protected:scope",
    }),
  ).toThrow();
  expect(f.assertCommitCurrent).not.toHaveBeenCalled();
});

it("the synchronous original grant check is last even if protected review assertion invalidates authority", async () => {
  const f = fixture();
  const command = {
    rule: { ...ruleFixture(), ruleRevision: strictPermissionRuleRevision(ruleFixture()) },
    expectedRevision: "a".repeat(64),
    approvalRecordRef: "protected:approval",
  };
  f.assertCommitCurrent.mockImplementationOnce(() => {
    f.setCurrent({ ...original, permissions: new Set() });
    return undefined;
  });
  expect(() =>
    f.authority.assertCommitCurrent(command, f.authority.actor, {
      authorityRevision: "authority-current",
      scopeEvidenceRef: "protected:scope",
    }),
  ).toThrow();
  expect(f.assertCommitCurrent).toHaveBeenCalledTimes(1);
});
