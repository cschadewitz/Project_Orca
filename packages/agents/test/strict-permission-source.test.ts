/** Synthetic owner snapshots and disposable legacy sidecars only; no user state or providers. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateStrictPermission, type StrictPermissionRule, type ActionEvidenceV1 } from "@orca/core";
import {
  createStrictPermissionSource,
  readLegacyStrictRuleMaterial,
  replacePermissionPolicyFile,
  resolvePermission,
  strictPermissionRuleRevision,
  strictRuleProjectionDigest,
  type StrictRuleRead,
} from "@orca/agents";
import { actionFixture, complete, NOW, ruleFixture, stateFixture } from "./strict-permission-fixtures.js";

const signal = () => new AbortController().signal;
function revised(rule: StrictPermissionRule): StrictPermissionRule {
  return { ...rule, ruleRevision: strictPermissionRuleRevision(rule) };
}
function material(rules = [revised(ruleFixture())]): Extract<StrictRuleRead, { state: "qualified" }> {
  return {
    state: "qualified",
    rules,
    provenance: {
      sourceRefs: ["synthetic:protected-source"],
      scopeEvidenceRef: "synthetic:scope-proof",
      approvalRecordRef: "synthetic:grant-authorized-approval",
      policyRevision: "policy-1",
      authorityRevision: "authority-1",
      projectionDigest: strictRuleProjectionDigest(rules),
    },
  };
}
function fixture(initial: StrictRuleRead = material()) {
  const state = stateFixture();
  const { rules: _rules, capturedCeiling, ...boundary } = state;
  let current = initial;
  const readBoundary = vi.fn(async (_action: ActionEvidenceV1, _signal: AbortSignal) => boundary);
  const readRules = vi.fn(async (_action: ActionEvidenceV1, _signal: AbortSignal) => current);
  const source = createStrictPermissionSource({ capturedCeiling, readBoundary, readRules });
  return {
    source,
    boundary,
    capturedCeiling,
    readBoundary,
    readRules,
    set: (next: StrictRuleRead) => {
      current = next;
    },
  };
}
async function outcome(f = fixture(), action = actionFixture()) {
  const state = await f.source.readCurrent(action, signal());
  return evaluateStrictPermission(action, state, NOW, "synthetic:review");
}

describe("strict read projection", () => {
  it("projects an ordered qualified immutable snapshot into accepted strict state, without caching", async () => {
    const typed = material();
    const f = fixture(typed);
    const snapshot = await f.source.readCurrent(actionFixture(), signal());
    expect(snapshot.rules).toEqual(complete(typed.rules));
    expect(snapshot.rules).not.toBe(typed);
    expect(snapshot.rules.state === "complete" && snapshot.rules.value[0]).not.toBe(typed.rules[0]);
    expect(await outcome(f)).toMatchObject({ phase: "final", verdict: { outcome: "allow" } });
    expect(f.readRules).toHaveBeenCalledTimes(2);
    expect(f.readBoundary).toHaveBeenCalledTimes(4);
  });

  it.each(["unavailable", "malformed", "unsupported"] as const)("keeps %s material indeterminate", async (state) => {
    const f = fixture({ state, reason: "synthetic-source" });
    expect((await f.source.readCurrent(actionFixture(), signal())).rules).toEqual({
      state: "unknown",
      reason: `strict-policy-${state}:synthetic-source`,
    });
    expect(await outcome(f)).toMatchObject({ phase: "final", verdict: { outcome: "indeterminate" } });
  });

  it.each(["sourceRefs", "scopeEvidenceRef", "approvalRecordRef", "policyRevision", "authorityRevision"] as const)(
    "requires trustworthy %s provenance",
    async (key) => {
      const typed = material();
      const bad = { ...typed, provenance: { ...typed.provenance, [key]: key === "sourceRefs" ? [] : "" } };
      expect(await outcome(fixture(bad))).toMatchObject({ phase: "final", verdict: { outcome: "indeterminate" } });
    },
  );

  it.each(["policyRevision", "authorityRevision"] as const)("refuses stale %s provenance", async (key) => {
    const typed = material();
    expect(await outcome(fixture({ ...typed, provenance: { ...typed.provenance, [key]: "stale" } }))).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate" },
    });
  });

  it("refuses content changes retaining an immutable rule revision, even with a new projection digest", async () => {
    const rule = { ...revised(ruleFixture()), status: "revoked" as const };
    const f = fixture(material([rule]));
    expect((await f.source.readCurrent(actionFixture(), signal())).rules).toEqual({
      state: "unknown",
      reason: "strict-policy-rule-revision-mismatch",
    });
  });

  it("refuses reordered or altered snapshots under an old projection binding", async () => {
    const first = revised(ruleFixture());
    const second = revised({ ...ruleFixture(), ruleId: "second", decision: "deny" });
    const typed = material([first, second]);
    expect(await outcome(fixture({ ...typed, rules: [second, first] }))).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate" },
    });
  });

  it("refuses ambiguous rule identities", async () => {
    expect(await outcome(fixture(material([revised(ruleFixture()), revised(ruleFixture())])))).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate" },
    });
  });

  it.each([
    { decision: "ask" },
    { status: "unknown" },
    { notBefore: "bad" },
    { expiresAt: "bad" },
    { ruleId: "" },
    { match: { pathPrefix: "/trusted" } },
    { delegation: { requirement: "required" } },
    {
      match: {
        ...ruleFixture().match,
        resources: [{ operation: "read", physicalTargetRef: "x", targetKind: "disposable-memory" }],
      },
    },
  ])("refuses malformed typed data %j", async (change) => {
    const rule = { ...ruleFixture(), ...change } as StrictPermissionRule;
    expect(await outcome(fixture(material([revised(rule)])))).toMatchObject({
      phase: "final",
      verdict: { outcome: "indeterminate" },
    });
  });

  it("reports a thrown read and malformed runtime material without an empty-policy fallback", async () => {
    const f = fixture();
    f.readRules.mockRejectedValueOnce(new Error("unavailable"));
    expect(await outcome(f)).toMatchObject({ phase: "final", verdict: { outcome: "indeterminate" } });
    f.set(null as unknown as StrictRuleRead);
    expect((await f.source.readCurrent(actionFixture(), signal())).rules).toEqual({
      state: "unknown",
      reason: "strict-policy-malformed-material",
    });
  });

  it.each([
    "currentPolicyRevision",
    "authorityRevision",
    "revocationEpoch",
    "leaseEpoch",
    "capturedGeneration",
  ] as const)("detects concurrent %s changes across rule IO", async (key) => {
    const f = fixture();
    f.readRules.mockImplementationOnce(async () => {
      Object.assign(f.boundary.authority, { [key]: "replacement" });
      return material();
    });
    expect((await f.source.readCurrent(actionFixture(), signal())).rules).toEqual({
      state: "unknown",
      reason: "policy-source-changed-during-read",
    });
  });

  it("preserves the captured ceiling despite current owner state becoming permissive", async () => {
    const capturedCeiling = { state: "complete" as const, value: false };
    const { rules: _rules, capturedCeiling: _captured, ...boundary } = stateFixture();
    const source = createStrictPermissionSource({
      capturedCeiling,
      readBoundary: async () => boundary,
      readRules: async () => material(),
    });
    capturedCeiling.value = true;
    const result = evaluateStrictPermission(
      actionFixture(),
      await source.readCurrent(actionFixture(), signal()),
      NOW,
      "review",
    );
    expect(result).toMatchObject({ phase: "final", verdict: { outcome: "deny", reason: "captured-ceiling" } });
  });

  it("snapshots the original action before awaits and refuses cancellation during read", async () => {
    const action = actionFixture();
    const controller = new AbortController();
    const f = fixture();
    f.readBoundary.mockImplementationOnce(async () => {
      Object.assign(action.invocation, { principalRef: "replacement" });
      return f.boundary;
    });
    f.readRules.mockImplementationOnce(async () => {
      controller.abort();
      return material();
    });
    const state = await f.source.readCurrent(action, controller.signal);
    expect(f.readRules.mock.calls[0]?.[0]).toMatchObject({ invocation: { principalRef: "test:principal" } });
    expect(state.rules).toEqual({ state: "unknown", reason: "invocation-expired" });
  });

  it.each([
    { status: "revoked", expected: "deny" },
    { expiresAt: new Date(NOW).toISOString(), expected: "indeterminate" },
    { notBefore: new Date(NOW + 1000).toISOString(), expected: "indeterminate" },
  ] as const)("projects current lifecycle truth: %j", async ({ expected, ...change }) => {
    expect(await outcome(fixture(material([revised({ ...ruleFixture(), ...change })])))).toMatchObject({
      phase: "final",
      verdict: { outcome: expected },
    });
  });

  it.each([
    "principalRef",
    "agentId",
    "hostId",
    "runnerId",
    "operation",
    "profileRef",
    "coverageId",
    "effectiveCwd",
    "workspaceRef",
  ] as const)("does not invent matching %s scope", async (key) => {
    const rule = revised({ ...ruleFixture(), match: { ...ruleFixture().match, [key]: "different" } });
    expect(await outcome(fixture(material([rule])))).toMatchObject({
      phase: "final",
      verdict: { outcome: "require-human" },
    });
  });

  it("retains resource kinds and refuses a different memory resource revision", async () => {
    const target = {
      operation: "read",
      targetKind: "disposable-memory" as const,
      ownerRef: "owner",
      resourceRef: "cell",
      resourceRevision: "one",
    };
    const action = { ...actionFixture(), resources: complete([target]) };
    const rule = revised({ ...ruleFixture(), match: { ...ruleFixture().match, resources: [target] } });
    expect(await outcome(fixture(material([rule])), action)).toMatchObject({
      phase: "final",
      verdict: { outcome: "allow" },
    });
    expect(
      await outcome(fixture(material([rule])), {
        ...action,
        resources: complete([{ ...target, resourceRevision: "two" }]),
      }),
    ).toMatchObject({ phase: "final", verdict: { outcome: "require-human" } });
  });

  it("keeps first-match ordering and rechecks revocation on the next read", async () => {
    const allow = revised(ruleFixture());
    const deny = revised({ ...ruleFixture(), ruleId: "deny", decision: "deny" });
    const f = fixture(material([allow, deny]));
    expect(await outcome(f)).toMatchObject({ phase: "final", verdict: { outcome: "allow" } });
    f.set(material([revised({ ...allow, status: "revoked" }), deny]));
    expect(await outcome(f)).toMatchObject({ phase: "final", verdict: { outcome: "deny", reason: "rule-revoked" } });
  });
});

it.each(["resources", "environmentAndCredentialRefs"] as const)("does not authorize a new %s scope", async (key) => {
  const action = actionFixture();
  const changed =
    key === "resources"
      ? { ...action, resources: complete([{ operation: "read", physicalTargetRef: "different" }]) }
      : { ...action, environmentAndCredentialRefs: complete(["different-credential-reference"]) };
  expect(await outcome(fixture(), changed)).toMatchObject({ phase: "final", verdict: { outcome: "require-human" } });
});

it("retains immutable returned snapshots while the source changes for later reads", async () => {
  const typed = material();
  const f = fixture(typed);
  const previous = await f.source.readCurrent(actionFixture(), signal());
  Object.assign(typed.rules[0]!.match, { principalRef: "replacement" });
  expect(evaluateStrictPermission(actionFixture(), previous, NOW, "review")).toMatchObject({
    phase: "final",
    verdict: { outcome: "allow" },
  });
  expect(await outcome(f)).toMatchObject({ phase: "final", verdict: { outcome: "indeterminate" } });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function sidecar() {
  const dir = await mkdtemp(join(tmpdir(), "orca702-"));
  dirs.push(dir);
  return join(dir, "orca.permissions.json");
}
const legacy = {
  version: 1,
  agents: {
    agent: {
      rules: [
        {
          match: { kind: "read", path: "a" },
          decision: "allow",
          addedAt: new Date(NOW).toISOString(),
          grantedFor: "Read a",
        },
      ],
    },
  },
};

describe("existing persistence compatibility and write boundary seam", () => {
  it("classifies missing, corrupt, unsupported and legacy sources explicitly", async () => {
    const file = await sidecar();
    const inspect = () => readLegacyStrictRuleMaterial({ configured: { rules: [] }, files: [file] });
    expect(await inspect()).toMatchObject({ state: "unavailable" });
    await writeFile(file, "{");
    expect(await inspect()).toMatchObject({ state: "malformed" });
    await writeFile(file, JSON.stringify({ version: 2, agents: {} }));
    expect(await inspect()).toMatchObject({ state: "unsupported", reason: "sidecar-version-unsupported" });
    await writeFile(file, JSON.stringify({ version: 1, agents: { a: { rules: [null] } } }));
    expect(await inspect()).toMatchObject({ state: "malformed" });
    await writeFile(file, JSON.stringify(legacy));
    expect(await inspect()).toMatchObject({
      state: "unsupported",
      reason: "legacy-policy-has-no-qualified-typed-scope",
    });
    expect(await readLegacyStrictRuleMaterial({ configured: { default: "bogus" }, files: [] })).toMatchObject({
      state: "malformed",
    });
    expect(await readLegacyStrictRuleMaterial({ configured: { rules: [] }, files: [] })).toMatchObject({
      state: "unsupported",
    });
  });

  it("does not promote even hand-added typed-looking fields from the legacy sidecar", async () => {
    const read = vi.fn(async () => JSON.stringify({ ...legacy, strictRules: material().rules }));
    expect(await readLegacyStrictRuleMaterial({ configured: { rules: [] }, files: ["synthetic"], read })).toMatchObject(
      { state: "unsupported" },
    );
  });

  it("serializes concurrent revision-guarded legacy mutations with one winner", async () => {
    const file = await sidecar();
    const authorize = vi.fn(async () => {});
    const results = await Promise.allSettled([
      replacePermissionPolicyFile(file, legacy, { expectedRevision: "", authorize }),
      replacePermissionPolicyFile(file, { version: 1, agents: {} }, { expectedRevision: "", authorize }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CONFIG_STALE" } });
    const bytes = await readFile(file, "utf8");
    await expect(replacePermissionPolicyFile(file, legacy, { expectedRevision: "", authorize })).rejects.toMatchObject({
      code: "CONFIG_STALE",
    });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it.each([1, 2])("refuses authority revoked at check %s without replacing the sidecar", async (failAt) => {
    const file = await sidecar();
    await writeFile(file, JSON.stringify(legacy));
    const bytes = await readFile(file, "utf8");
    let calls = 0;
    await expect(
      replacePermissionPolicyFile(
        file,
        { version: 1, agents: {} },
        {
          expectedRevision: createHash("sha256").update(bytes).digest("hex"),
          authorize: async () => {
            if (++calls === failAt) throw new Error("permissions.grant revoked");
          },
        },
      ),
    ).rejects.toThrow("permissions.grant revoked");
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("Allow once never changes a standing rule, including repeated approvals", async () => {
    const file = await sidecar();
    await writeFile(file, JSON.stringify(legacy));
    const bytes = await readFile(file, "utf8");
    for (let i = 0; i < 2; i++) {
      const answer = await resolvePermission(
        { default: "ask", rules: [] },
        {
          request: {
            sessionId: "synthetic",
            toolCall: { toolCallId: "read", title: "Read a", kind: "read" },
            options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
          },
          ask: async () => "once",
        },
      );
      expect(answer.response).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    }
    expect(await readFile(file, "utf8")).toBe(bytes);
  });
});
