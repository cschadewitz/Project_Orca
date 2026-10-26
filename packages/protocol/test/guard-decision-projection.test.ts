/** Synthetic #706 privacy/lifecycle views; no protected adapter, installed qualification or real effects. */
import { describe, expect, it } from "vitest";
import type { FactV1 } from "@orca/core";
import {
  projectGuardDecision,
  type GuardDecisionProjectionInput,
  type GuardProjectionDisclosure,
} from "../src/guard-decision-projection.js";

const now = Date.parse("2026-10-26T05:00:00Z");
const before = "2026-10-26T04:59:00Z";
const after = "2026-10-26T05:01:00Z";
const complete = <T>(value: T): FactV1<T> => ({ state: "complete", value });
const unknown = { state: "unknown", reason: "CREDENTIAL_CANARY unknown scope /private/path" } as const;
const absent = { state: "absent", reason: "MODEL_RATIONALE_CANARY" } as const;
const publicId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const approvals = new Map([
  ["coverage:coverage-private", publicId(1)],
  ["rule:rule-private", publicId(2)],
  ["revision:revision-private", publicId(3)],
  ["authorizer:answer-private", publicId(4)],
  ["review:review-private", publicId(5)],
  ["receipt:receipt-private", publicId(6)],
  ["observation:observer-private", publicId(7)],
]);
const disclosure: GuardProjectionDisclosure = {
  requiredDisclosure: () => "complete",
  reference: (kind, ref) => {
    const id = approvals.get(`${kind}:${ref}`);
    return id ? { id } : undefined;
  },
};
const binding = {
  version: 1,
  actionBindingRef: "action-private",
  coverageId: "coverage-private",
  authority: {
    capturedGeneration: "generation-private",
    currentPolicyRevision: "policy-private",
    authorityRevision: "authority-private",
    revocationEpoch: "revoke-private",
    leaseEpoch: "lease-private",
  },
} as const;
function fixture(): GuardDecisionProjectionInput {
  return {
    coverage: {
      version: 1,
      coverageId: "coverage-private",
      boundaryId: "boundary-private",
      provider: "provider-private",
      providerVersion: "version-private",
      adapterVersion: "adapter-private",
      tool: "tool-private",
      toolSchemaVersion: "schema-private",
      hostId: "host-private",
      platform: "platform-private",
      level: "verified-per-execution",
      evidence: {
        sourceRefs: ["source-private"],
        installedRefs: ["installed-private"],
        independentlyObservedEffects: true,
      },
      negotiatedHook: complete("hook-private"),
      protectedConfiguration: complete("configuration-private"),
      guaranteedEffects: ["SCOPE_CANARY"],
      unsupportedPaths: ["PATH_CANARY"],
    },
    unsupported: complete(false),
    verdict: {
      ...binding,
      outcome: "allow",
      authorizedBy: { kind: "rule", ruleId: "rule-private", ruleRevision: "revision-private" },
      judgeResultRef: "review-private",
    },
    review: {
      ...binding,
      reviewId: "review-id-private",
      reasonCode: "MODEL_RATIONALE_CANARY",
      judgeVersion: "judge-private",
      projectionBindingRef: "projection-private",
      execution: "evaluated",
      result: "fit",
    },
    reviewRef: "review-private",
    receipt: { version: 1, actionId: "action-private", state: "completed", protectedEvidenceRef: "receipt-private" },
    currentAuthority: complete(true),
    authorityKind: complete("stored-rule"),
    expiresAt: complete(after),
    revocation: complete("active"),
    revocationLatencyMs: complete(0),
  };
}
const project = (input: unknown = fixture()) => projectGuardDecision(input, disclosure, now);
const observed = (status: "observed" | "not-observed" = "observed") =>
  complete({ status, sourceRef: "observer-private", observedAt: before });

describe("inactive guard decision projections", () => {
  it("retains only approved references and closed operator meaning", () => {
    const view = project();
    expect(view).toMatchObject({
      coverage: { tier: "verified-per-execution", reference: { id: publicId(1) } },
      // Even synthetic installed references do not establish supported operation.
      support: "unknown",
      decision: "allow",
      authorizer: "rule",
      matchedRule: { rule: { id: publicId(2) }, revision: { id: publicId(3) } },
      authorityKind: "stored-rule",
      authority: "current",
      expiry: { state: "bounded", at: after },
      revocation: "active",
      revocationLatencyMs: 0,
      review: "fit",
      execution: "completed",
    });
    expect(JSON.stringify(view)).not.toMatch(/private|CANARY/);
    expect(Object.values(view.observations).map((o) => o.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  });

  it.each(["unknown", "observation", "policy-per-ask", "verified-per-execution"] as const)(
    "shows reported tier %s",
    (level) => {
      expect(project({ ...fixture(), coverage: { ...fixture().coverage, level } }).coverage.tier).toBe(level);
    },
  );

  it.each([
    { evidence: { sourceRefs: ["source"], installedRefs: [], independentlyObservedEffects: true } },
    { evidence: { sourceRefs: [], installedRefs: ["installed"], independentlyObservedEffects: true } },
    { evidence: { sourceRefs: ["source"], installedRefs: ["installed"], independentlyObservedEffects: false } },
    { negotiatedHook: unknown },
    { protectedConfiguration: absent },
  ])("does not upgrade insufficient reported qualification: %j", (patch) => {
    const view = project({ ...fixture(), coverage: { ...fixture().coverage, ...patch } });
    expect(view.coverage.tier).toBe("unknown");
    expect(view.decision).toBe("indeterminate");
    expect(view.authority).toBe("unknown");
  });

  it("separates bounded one-shot human authority from a stored rule and explicit unbounded lifetime", () => {
    const view = project({
      ...fixture(),
      verdict: { ...binding, outcome: "allow", authorizedBy: { kind: "human", acceptedAnswerRef: "answer-private" } },
      authorityKind: complete("one-shot"),
      expiresAt: complete(after),
    });
    expect(view).toMatchObject({
      decision: "allow",
      authorizer: "human",
      authorityKind: "one-shot",
      expiry: { state: "bounded", at: after },
    });
    expect(view.matchedRule).toBeUndefined();
    expect(project({ ...fixture(), expiresAt: complete(null) })).toMatchObject({
      decision: "allow",
      authorityKind: "stored-rule",
      expiry: { state: "unbounded" },
    });
    expect(project({ ...fixture(), authorityKind: complete("one-shot"), expiresAt: complete(null) })).toMatchObject({
      decision: "indeterminate",
      authority: "unknown",
      expiry: { state: "unbounded" },
    });
    expect(
      project({
        ...fixture(),
        verdict: { ...binding, outcome: "allow", authorizedBy: { kind: "human", acceptedAnswerRef: "answer-private" } },
      }),
    ).toMatchObject({ decision: "indeterminate", authorityKind: "unknown" });
  });

  it.each(["expiresAt", "revocation", "currentAuthority", "authorityKind", "unsupported"] as const)(
    "missing/unknown/absent %s cannot show current authority",
    (key) => {
      for (const value of [undefined, unknown, absent]) {
        const view = project({ ...fixture(), [key]: value });
        expect(view.decision).toBe("indeterminate");
        expect(view.authority).toBe("unknown");
        expect(view.review).toBe("unknown");
      }
    },
  );

  it("recomputes expiry, revocation, lost owner and unsupported transitions without retaining positive state", () => {
    const input = fixture();
    expect(project(input).decision).toBe("allow");
    expect(projectGuardDecision(input, disclosure, Date.parse(after))).toMatchObject({
      decision: "indeterminate",
      authority: "expired",
      review: "unknown",
    });
    expect(project({ ...input, revocation: complete("revoked"), revocationLatencyMs: unknown })).toMatchObject({
      decision: "indeterminate",
      authority: "revoked",
      revocation: "revoked",
    });
    expect(
      project({ ...input, revocation: complete("revoked"), revocationLatencyMs: unknown }).revocationLatencyMs,
    ).toBeUndefined();
    expect(project({ ...input, currentAuthority: complete(false) }).authority).toBe("unknown");
    expect(project({ ...input, unsupported: complete(true) })).toMatchObject({
      decision: "indeterminate",
      support: "unsupported",
    });
    expect(project({}).decision).toBe("unknown");
    expect(project(input)).toEqual(project(input));
  });

  it("keeps recording, delivery, dispatch and independent effect observations separate", () => {
    const input = fixture();
    for (const key of ["recording", "delivery", "dispatch", "effect"] as const) {
      const view = project({ ...input, observations: { [key]: observed() } });
      for (const other of ["recording", "delivery", "dispatch", "effect"] as const)
        expect(view.observations[other].status).toBe(key === other ? "observed" : "unknown");
    }
    expect(
      project({ ...input, observations: { recording: observed(), delivery: observed("not-observed"), effect: absent } })
        .observations,
    ).toMatchObject({
      recording: { status: "observed" },
      delivery: { status: "not-observed" },
      dispatch: { status: "unknown" },
      effect: { status: "unknown" },
    });
    // Consumption/crash and cancellation do not erase already observed effects or imply an undo.
    const effect = { effect: observed() };
    expect(
      project({
        ...input,
        receipt: { ...input.receipt, state: "execution-unknown" },
        observations: effect,
        revocation: complete("revoked"),
      }),
    ).toMatchObject({
      execution: "execution-unknown",
      observations: { effect: { status: "observed" }, delivery: { status: "unknown" } },
    });
    expect(project({ ...input, observations: {} }).observations.effect.status).toBe("unknown");
  });

  it.each(["completed", "failed", "not-dispatched", "execution-unknown"] as const)(
    "receipt %s does not manufacture observations",
    (state) => {
      const view = project({ ...fixture(), receipt: { ...fixture().receipt, state } });
      expect(view.execution).toBe(state);
      expect(Object.values(view.observations).every((o) => o.status === "unknown")).toBe(true);
    },
  );

  it("requires approved observation attribution and a non-future timestamp", () => {
    for (const patch of [{ sourceRef: "PATH_CANARY" }, { observedAt: after }, { observedAt: "COMMAND_CANARY" }]) {
      const view = project({
        ...fixture(),
        observations: {
          effect: complete({ status: "observed", sourceRef: "observer-private", observedAt: before, ...patch }),
        },
      });
      expect(view.observations.effect.status).toBe("unknown");
      expect(JSON.stringify(view)).not.toContain("CANARY");
    }
  });

  it("never treats review execution or advice as authority", () => {
    for (const outcome of ["deny", "require-human", "indeterminate"] as const) {
      const view = project({ ...fixture(), verdict: { ...binding, outcome, reason: "COMMAND_CANARY" } });
      expect(view.decision).toBe(outcome);
      expect(view.authority).toBe("unknown");
      expect(view.review).toBe("unknown");
      expect(JSON.stringify(view)).not.toContain("CANARY");
    }
    expect(project({ ...fixture(), verdict: undefined }).review).toBe("unknown");
    expect(
      project({ ...fixture(), review: { ...fixture().review, execution: "unavailable", result: "indeterminate" } })
        .review,
    ).toBe("unavailable");
    expect(project({ ...fixture(), review: { ...fixture().review, result: "indeterminate" } }).review).toBe(
      "indeterminate",
    );
    expect(
      project({ ...fixture(), review: { ...fixture().review, execution: "unavailable", result: "fit" } }).review,
    ).toBe("unknown");
    for (const patch of [
      { actionBindingRef: "wrong" },
      { coverageId: "wrong" },
      { authority: { ...binding.authority, revocationEpoch: "new" } },
    ])
      expect(project({ ...fixture(), review: { ...fixture().review, ...patch } }).review).toBe("unknown");
  });

  it("withholds authority when a verdict's referenced review is missing, undisclosed or inconsistent", () => {
    for (const patch of [
      { review: undefined },
      { reviewRef: undefined },
      { reviewRef: "unapproved-review" },
      { review: { ...fixture().review, actionBindingRef: "different-action" } },
      { review: { ...fixture().review, execution: "unavailable", result: "fit" } },
    ]) {
      expect(project({ ...fixture(), ...patch })).toMatchObject({
        decision: "indeterminate",
        authority: "unknown",
        review: "unknown",
      });
    }
    // A rule may already allow an unavailable advisory review, which must stay visibly unavailable.
    expect(
      project({ ...fixture(), review: { ...fixture().review, execution: "unavailable", result: "indeterminate" } }),
    ).toMatchObject({ decision: "allow", review: "unavailable" });
  });

  it("requires complete canonical identity for reported coverage and review", () => {
    for (const field of [
      "provider",
      "providerVersion",
      "adapterVersion",
      "tool",
      "toolSchemaVersion",
      "hostId",
      "platform",
      "boundaryId",
    ]) {
      expect(project({ ...fixture(), coverage: { ...fixture().coverage, [field]: undefined } })).toMatchObject({
        diagnostic: "invalid-input",
        decision: "unknown",
        coverage: { tier: "unknown" },
      });
    }
    expect(project({ ...fixture(), review: { ...fixture().review, reasonCode: undefined } }).review).toBe("unknown");
  });

  it("fails closed for missing disclosure and thrown raw errors without leaking errors or audit fields", () => {
    for (const access of [
      { ...disclosure, requiredDisclosure: () => "unavailable" as const },
      {
        ...disclosure,
        requiredDisclosure: () => {
          throw new Error("CREDENTIAL_CANARY");
        },
      },
      {
        ...disclosure,
        reference: () => {
          throw new Error("PATH_CANARY");
        },
      },
    ]) {
      const view = projectGuardDecision(fixture(), access, now);
      expect(view).toMatchObject({
        disclosure: "unavailable",
        decision: "unknown",
        authority: "unknown",
        review: "unknown",
        execution: "execution-unknown",
      });
      expect(JSON.stringify(view)).not.toMatch(/CANARY|private/);
    }
  });

  it("supplies the exact parsed snapshot for disclosure approval without sharing mutable projection state", () => {
    const access: GuardProjectionDisclosure = {
      ...disclosure,
      requiredDisclosure: (snapshot) => {
        expect(snapshot).toMatchObject({ verdict: { judgeResultRef: "review-private" }, expiresAt: complete(after) });
        if (snapshot && typeof snapshot === "object")
          Object.assign(snapshot, { verdict: { outcome: "COMMAND_CANARY" } });
        return "complete";
      },
    };
    const input = fixture();
    expect(projectGuardDecision(input, access, now).decision).toBe("allow");
    expect(input.verdict?.outcome).toBe("allow");
    const refuseChanged: GuardProjectionDisclosure = {
      ...disclosure,
      requiredDisclosure: (snapshot) =>
        JSON.stringify(snapshot).includes("changed-expiry") ? "unavailable" : "complete",
    };
    // A destination owner can reject an otherwise well-formed changed snapshot by its retained identity.
    expect(
      projectGuardDecision(
        { ...input, currentAuthority: { state: "unknown", reason: "changed-expiry" } },
        refuseChanged,
        now,
      ).disclosure,
    ).toBe("unavailable");
  });

  it("does not promote arbitrary strings to labels or use format validation as disclosure approval", () => {
    for (const raw of ["COMMAND_CANARY", "./PATH_CANARY", publicId(99)]) {
      const input = fixture();
      const view = project({
        ...input,
        verdict: { ...binding, outcome: "allow", authorizedBy: { kind: "rule", ruleId: raw, ruleRevision: raw } },
      });
      expect(view.matchedRule).toBeUndefined();
      expect(view.authorizer).toBe("unknown");
      expect(view.decision).toBe("indeterminate");
    }
    const unsafe = { ...disclosure, reference: () => ({ id: "CREDENTIAL_CANARY" }) };
    expect(projectGuardDecision(fixture(), unsafe, now).decision).toBe("indeterminate");
    const extra = { ...disclosure, reference: () => ({ id: publicId(1), label: "COMMAND_CANARY" }) };
    expect(projectGuardDecision(fixture(), extra, now).matchedRule).toBeUndefined();
    const identity = { ...disclosure, reference: (_kind: string, privateRef: string) => ({ id: privateRef }) };
    const rawUuid = {
      ...fixture(),
      verdict: {
        ...binding,
        outcome: "allow",
        authorizedBy: { kind: "rule", ruleId: publicId(99), ruleRevision: publicId(98) },
      },
    };
    expect(projectGuardDecision(rawUuid, identity, now).matchedRule).toBeUndefined();
  });

  it.each([
    null,
    [],
    "CREDENTIAL_CANARY",
    { verdict: { outcome: "ALLOW" } },
    { expiresAt: complete("PATH_CANARY") },
    { revocationLatencyMs: complete(-1) },
    { review: { execution: "success", result: "fit" } },
  ])("returns fixed diagnostics for malformed input: %j", (input) => {
    const view = project(input);
    expect(view).toMatchObject({ diagnostic: "invalid-input", decision: "unknown", review: "unknown" });
    expect(JSON.stringify(view)).not.toContain("CANARY");
  });

  it("ignores untrusted extras; getter/proxy failures and invalid clocks cannot escape as raw errors", () => {
    const raw = {
      ...fixture(),
      command: "COMMAND_CANARY",
      path: "PATH_CANARY",
      scope: "SCOPE_CANARY",
      rationale: "MODEL_RATIONALE_CANARY",
      credential: "CREDENTIAL_CANARY",
    };
    const beforeInput = structuredClone(raw);
    const view = project(raw);
    expect(raw).toEqual(beforeInput);
    expect(JSON.stringify(view)).not.toMatch(/CANARY|private/);
    expect(
      project(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("CREDENTIAL_CANARY");
            },
          },
        ),
      ).diagnostic,
    ).toBe("projection-unavailable");
    expect(projectGuardDecision(raw, disclosure, Number.NaN).diagnostic).toBe("invalid-input");
  });
});
