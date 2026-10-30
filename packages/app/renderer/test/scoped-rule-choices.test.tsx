// @vitest-environment happy-dom
/** Synthetic read/command ports only: UI evidence, never persistence or execution proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { projectGuardDecision } from "../../../protocol/src/guard-decision-projection.js";
import { PermissionCard, type PermissionCardProps } from "../src/attention/permission-card.js";
import type {
  ScopedRuleReview,
  ScopedRuleReviewPort,
  ScopedChoiceResult,
} from "../src/attention/scoped-rule-review.js";
import { harness, type Harness } from "./harness.js";
import { PERMISSION_ASK } from "./fixtures-inputs.js";

const publicId = "00000000-0000-4000-8000-000000000001";
const complete = <T,>(value: T) => ({ state: "complete", value });
function view(
  patch: Record<string, unknown> = {},
  reference: (kind: string) => { id: string } = () => ({ id: publicId }),
) {
  return projectGuardDecision(
    {
      coverage: {
        version: 1,
        coverageId: "private-coverage",
        boundaryId: "private-boundary",
        provider: "private-provider",
        providerVersion: "1",
        adapterVersion: "1",
        tool: "private-tool",
        toolSchemaVersion: "1",
        hostId: "private-host",
        platform: "private-platform",
        level: "verified-per-execution",
        evidence: {
          sourceRefs: ["private-source"],
          installedRefs: ["private-install"],
          independentlyObservedEffects: true,
        },
        negotiatedHook: complete("private-hook"),
        protectedConfiguration: complete("private-config"),
        guaranteedEffects: ["SECRET_SCOPE_CANARY"],
        unsupportedPaths: ["SECRET_PATH_CANARY"],
      },
      unsupported: complete(false),
      ...patch,
    },
    { requiredDisclosure: () => "complete", reference },
    Date.now(),
  );
}
const ruleIds: Record<string, string> = {
  coverage: "00000000-0000-4000-8000-0000000000c0",
  rule: "00000000-0000-4000-8000-0000000000a1",
  revision: "00000000-0000-4000-8000-0000000000b2",
};
/** A stored-rule allow matched by a specific rule revision; every private reference is replaced. */
function matched(patch: Record<string, unknown> = {}) {
  const stamp = {
    capturedGeneration: "g",
    currentPolicyRevision: "p",
    authorityRevision: "a",
    revocationEpoch: "r",
    leaseEpoch: "l",
  };
  return view(
    {
      verdict: {
        version: 1,
        actionBindingRef: "private-binding",
        coverageId: "private-coverage",
        authority: stamp,
        outcome: "allow",
        authorizedBy: { kind: "rule", ruleId: "private-rule-SECRET", ruleRevision: "private-revision-SECRET" },
      },
      currentAuthority: complete(true),
      authorityKind: complete("stored-rule"),
      expiresAt: complete(new Date(Date.now() + 3_600_000).toISOString()),
      revocation: complete("active"),
      ...patch,
    },
    (kind) => ({ id: ruleIds[kind] ?? publicId }),
  );
}
function reviewed(patch: Partial<ScopedRuleReview> = {}): ScopedRuleReview {
  return {
    scope: {
      principal: "synthetic operator",
      operation: "read bounded fixture",
      resources: "/synthetic/reviewed.txt only",
      environment: "temporary workspace; no network",
      lifetime: "until 2026-10-26T07:00:00Z",
      limits: "one reviewed file; read only",
      authorizer: "synthetic authenticated owner",
      coverage: "ORCA fixture v1, synthetic host; shell, provider and child tools excluded",
    },
    decision: view(),
    reviewUntil: Date.now() + 60_000,
    requiredReview: "passed",
    isCurrent: () => true,
    allowOnce: vi.fn(async () => "confirmed" as const),
    deny: vi.fn(async () => "confirmed" as const),
    createRule: vi.fn(async () => "confirmed" as const),
    ...patch,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  cleanup();
  h.dispose();
  vi.restoreAllMocks();
});
function mount(review = reviewed(), over: Partial<PermissionCardProps> = {}) {
  const port: ScopedRuleReviewPort = { scopeKey: "workspace-a/input-a/review-1", review: vi.fn(async () => review) };
  const onAnswer = vi.fn();
  const props: PermissionCardProps = {
    input: PERMISSION_ASK,
    placement: "inbox",
    focused: true,
    onAnswer,
    scopedRuleReview: port,
    ...over,
  };
  const element = (p: PermissionCardProps) => (
    <h.Providers>
      <PermissionCard {...p} />
    </h.Providers>
  );
  const result = render(element(props));
  return {
    ...result,
    port,
    onAnswer,
    change: (patch: Partial<PermissionCardProps>) => result.rerender(element({ ...props, ...patch })),
  };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Review permission" }));
  await screen.findByText("read bounded fixture");
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("inactive scoped choices in the existing permission card", () => {
  it("leaves ordinary users on existing controls and never loads the opt-in port", () => {
    const { onAnswer } = mount(reviewed(), { scopedRuleReview: undefined });
    expect(screen.queryByRole("button", { name: "Review permission" })).toBeNull();
    click("Answer");
    expect(onAnswer).toHaveBeenCalledWith({ optionId: "allow" });
  });
  it("shows only reviewed disclosure and existing safe projections", async () => {
    mount();
    await open();
    expect(document.body.textContent).toContain("/synthetic/reviewed.txt only");
    expect(document.body.textContent).toContain("until 2026-10-26T07:00:00Z");
    expect(document.body.textContent).toContain("shell, provider and child tools excluded");
    expect(document.body.textContent).toContain("verified-per-execution");
    expect(document.body.textContent).not.toMatch(/rm -rf|claude|build-box|private-|SECRET_/);
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
  });
  it.each(["Allow once", "Deny"])("%s never saves a rule or enters the legacy always path", async (choice) => {
    const review = reviewed();
    const host = mount(review);
    await open();
    click(choice);
    await screen.findByText(/No rule was created/);
    expect(choice === "Allow once" ? review.allowOnce : review.deny).toHaveBeenCalledTimes(1);
    expect(review.createRule).not.toHaveBeenCalled();
    expect(host.onAnswer).not.toHaveBeenCalled();
  });
  it("requires a separate explicit save, returns focus safely, and never approves the ask", async () => {
    const review = reviewed();
    mount(review);
    await open();
    click("Create scoped rule");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" }));
    expect(review.createRule).not.toHaveBeenCalled();
    click("Save scoped rule");
    await screen.findByText(/Scoped rule saved/);
    expect(review.createRule).toHaveBeenCalledTimes(1);
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Scoped permission review");
  });
  it("back, cancel and stack close send nothing and restore trigger focus", async () => {
    const review = reviewed();
    mount(review);
    await open();
    click("Create scoped rule");
    click("Back");
    const cancel = screen.getByRole("button", { name: "Cancel review" });
    cancel.focus();
    click("Cancel review");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review permission" }));
    await open();
    screen.getByRole("button", { name: "Allow once" }).focus();
    act(() => {
      expect(h.layers.closeTop()).toBe("closed");
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review permission" }));
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(review.createRule).not.toHaveBeenCalled();
  });
  it("does not steal focus placed outside the review", async () => {
    mount();
    await open();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    act(() => {
      h.layers.closeTop();
    });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
  it("does not bind ordinary Enter approval shortcuts in the scoped form", async () => {
    const review = reviewed();
    const host = mount(review);
    await open();
    const region = screen.getByRole("region", { name: "permission, Review scoped tool permission" });
    region.focus();
    fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
    expect(host.onAnswer).not.toHaveBeenCalled();
    expect(review.allowOnce).not.toHaveBeenCalled();
  });
  it.each([
    ["unknown coverage", () => reviewed({ decision: view({ coverage: undefined }) })],
    ["unsupported", () => reviewed({ decision: view({ unsupported: complete(true) }) })],
    ["expired review", () => reviewed({ reviewUntil: Date.now() - 1 })],
    ["revoked grant", () => reviewed({ decision: view({ revocation: complete("revoked") }) })],
    ["expired grant", () => reviewed({ decision: view({ expiresAt: complete("2020-01-01T00:00:00Z") }) })],
    ["stale review", () => reviewed({ isCurrent: () => false })],
    ["failed review", () => reviewed({ requiredReview: "failed" })],
    ["unavailable review", () => reviewed({ requiredReview: "unavailable" })],
    [
      "withheld disclosure",
      () =>
        reviewed({
          decision: projectGuardDecision(
            {},
            { requiredDisclosure: () => "unavailable", reference: () => undefined },
            Date.now(),
          ),
        }),
    ],
  ] as const)("blocks positive choices for %s", async (_name, make) => {
    const review = make();
    mount(review);
    await open();
    expect(screen.getByRole("button", { name: "Allow once" }).getAttribute("aria-disabled")).toBe("true");
    click("Allow once");
    click("Create scoped rule");
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(review.createRule).not.toHaveBeenCalled();
  });
  it("a reported tier cannot synthesize missing positive capabilities", async () => {
    mount(reviewed({ allowOnce: undefined, createRule: undefined }));
    await open();
    expect(screen.getByRole("button", { name: "Allow once" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Create scoped rule" }).getAttribute("aria-disabled")).toBe("true");
  });
  it("requests fresh checks for a coherent pending intent without claiming review or execution passed", async () => {
    const review = reviewed({ requiredReview: "unavailable", pendingExecutionIntent: true, executionWindowMs: 55000 });
    const host = mount(review);
    await open();
    expect(screen.getByText(/execution window starts after approval and current checks/).textContent).toContain(
      "55\u00a0seconds",
    );
    expect(screen.getByText(/Current checks may refuse this request/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" }).getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByRole("button", { name: "Create scoped rule" }).getAttribute("aria-disabled")).toBe("true");
    expect(review.allowOnce).not.toHaveBeenCalled();
    click("Allow once");
    await screen.findByText(/One-time answer recorded.*Execution is not confirmed/);
    expect(review.allowOnce).toHaveBeenCalledTimes(1);
    expect(review.createRule).not.toHaveBeenCalled();
    expect(host.onAnswer).not.toHaveBeenCalled();
  });
  it.each([
    ["missing flag", { pendingExecutionIntent: undefined }],
    ["false flag", { pendingExecutionIntent: false as never }],
    ["missing window", { executionWindowMs: undefined }],
    ["zero window", { executionWindowMs: 0 }],
    ["negative window", { executionWindowMs: -1 }],
    ["oversize window", { executionWindowMs: 60001 }],
    ["fractional window", { executionWindowMs: 1.5 }],
    ["NaN window", { executionWindowMs: NaN }],
    ["infinite window", { executionWindowMs: Infinity }],
    ["failed review", { requiredReview: "failed" as const }],
    ["stale", { isCurrent: () => false }],
    ["expired handle", { reviewUntil: 1 }],
    ["expired grant", { decision: view({ expiresAt: complete("2020-01-01T00:00:00Z") }) }],
    ["revoked", { decision: view({ revocation: complete("revoked") }) }],
    ["unsupported", { decision: view({ unsupported: complete(true) }) }],
    ["unverified", { decision: view({ coverage: undefined }) }],
    [
      "withheld disclosure",
      {
        decision: projectGuardDecision(
          {},
          { requiredDisclosure: () => "unavailable", reference: () => undefined },
          Date.now(),
        ),
      },
    ],
    ["missing owner capability", { allowOnce: undefined }],
  ] as const)("pending execution does not bypass %s", async (_name, patch) => {
    const review = reviewed({
      requiredReview: "unavailable",
      pendingExecutionIntent: true,
      executionWindowMs: 55000,
      ...patch,
    });
    mount(review);
    await open();
    expect(screen.getByRole("button", { name: "Allow once" }).getAttribute("aria-disabled")).toBe("true");
    click("Allow once");
    if (review.allowOnce) expect(review.allowOnce).not.toHaveBeenCalled();
    expect(review.createRule).not.toHaveBeenCalled();
  });
  it("keeps Deny independent and Save eligibility unchanged when the execution projection is malformed", async () => {
    const review = reviewed({
      requiredReview: "unavailable",
      pendingExecutionIntent: true,
      saveEligibility: "eligible",
    });
    mount(review);
    await open();
    expect(screen.getByRole("button", { name: "Allow once" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText(/execution window starts/)).toBeNull();
    expect(screen.getByRole("button", { name: "Create scoped rule" }).getAttribute("aria-disabled")).not.toBe("true");
    click("Deny");
    await screen.findByText(/Denial recorded/);
    expect(review.deny).toHaveBeenCalledTimes(1);
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(review.createRule).not.toHaveBeenCalled();
  });
  it("a pending intent rechecks the owner capability when Allow once is selected", async () => {
    let current = true;
    const review = reviewed({
      requiredReview: "unavailable",
      pendingExecutionIntent: true,
      executionWindowMs: 60000,
      isCurrent: () => current,
    });
    mount(review);
    await open();
    current = false;
    click("Allow once");
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(screen.getByText(/This review is stale/)).toBeTruthy();
  });
  it.each([
    ["stale", { isCurrent: () => false }],
    ["revoked", { decision: view({ revocation: complete("revoked") }) }],
    ["unverified", { decision: view({ coverage: undefined }) }],
    ["expired", { reviewUntil: 1 }],
    ["failed", { requiredReview: "failed" as const }],
  ] as const)("Save eligibility does not bypass the shared %s veto", async (_name, patch) => {
    const review = reviewed({ requiredReview: "unavailable", saveEligibility: "eligible", ...patch });
    mount(review);
    await open();
    expect(screen.getByRole("button", { name: "Create scoped rule" }).getAttribute("aria-disabled")).toBe("true");
    click("Create scoped rule");
    expect(review.createRule).not.toHaveBeenCalled();
    expect(review.allowOnce).not.toHaveBeenCalled();
  });

  it("rechecks persistence-only Save freshness at confirmation time", async () => {
    let current = true;
    const review = reviewed({ requiredReview: "unavailable", saveEligibility: "eligible", isCurrent: () => current });
    mount(review);
    await open();
    click("Create scoped rule");
    current = false;
    click("Save scoped rule");
    expect(review.createRule).not.toHaveBeenCalled();
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(screen.getByText(/This review is stale/)).toBeTruthy();
  });
  it("rechecks owner authority and expiry at save time", async () => {
    let current = true;
    const review = reviewed({ isCurrent: () => current });
    mount(review);
    await open();
    click("Create scoped rule");
    current = false;
    click("Save scoped rule");
    expect(review.createRule).not.toHaveBeenCalled();
    expect(screen.getByText(/This review is stale/)).toBeTruthy();
  });
  it.each(["confirmed", "refused", "stale", "uncertain", "throws"] as const)(
    "latches repeated saves and conservatively reports %s",
    async (result) => {
      const pending = deferred<ScopedChoiceResult>();
      const review = reviewed({
        createRule: vi.fn(() => (result === "throws" ? Promise.reject(new Error("SECRET_FAILURE")) : pending.promise)),
      });
      mount(review);
      await open();
      click("Create scoped rule");
      act(() => {
        click("Save scoped rule");
        click("Save scoped rule");
      });
      expect(review.createRule).toHaveBeenCalledTimes(1);
      if (result !== "throws")
        await act(async () => {
          pending.resolve(result);
        });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Save scoped rule" })).toBeNull());
      expect(document.body.textContent).not.toContain("SECRET_FAILURE");
      if (result !== "confirmed") expect(document.body.textContent).not.toContain("Scoped rule saved");
      expect(review.allowOnce).not.toHaveBeenCalled();
    },
  );
  it("drops cancelled late review reads", async () => {
    const pending = deferred<ScopedRuleReview | undefined>();
    mount(reviewed(), { scopedRuleReview: { scopeKey: "a", review: () => pending.promise } });
    click("Review permission");
    click("Cancel review");
    await act(async () => {
      pending.resolve(reviewed());
    });
    expect(screen.queryByText("read bounded fixture")).toBeNull();
  });
  it.each(["workspace", "input", "callback"])(
    "invalidates old review and ignores late acknowledgement on %s changes",
    async (change) => {
      const pending = deferred<ScopedChoiceResult>();
      const review = reviewed({ createRule: () => pending.promise });
      const host = mount(review);
      await open();
      click("Create scoped rule");
      click("Save scoped rule");
      host.change(
        change === "workspace"
          ? { scopedRuleReview: { scopeKey: "workspace-b", review: async () => reviewed() } }
          : {
              input: {
                ...PERMISSION_ASK,
                ...(change === "input"
                  ? { id: "other-input" }
                  : { live: { ...PERMISSION_ASK.live!, state: "expired" } }),
              },
            },
      );
      await act(async () => {
        pending.resolve("confirmed");
      });
      expect(screen.queryByText(/Scoped rule saved/)).toBeNull();
      expect(screen.queryByText("read bounded fixture")).toBeNull();
    },
  );
  it.each([undefined, new Error("SECRET_READ_FAILURE")])(
    "handles unavailable/failed review without exposing errors",
    async (failure) => {
      const port = {
        scopeKey: "a",
        review: failure
          ? async () => {
              throw failure;
            }
          : async () => undefined,
      };
      mount(reviewed(), { scopedRuleReview: port });
      click("Review permission");
      await screen.findByText(/No choice was sent/);
      expect(document.body.textContent).not.toContain("SECRET_READ_FAILURE");
    },
  );
  it("checks review expiry again after the confirmation step opens", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const review = reviewed();
    mount(review);
    await open();
    click("Create scoped rule");
    now = review.reviewUntil + 1;
    click("Save scoped rule");
    expect(review.createRule).not.toHaveBeenCalled();
    expect(screen.getByText(/This review expired/)).toBeTruthy();
  });
  it("checks grant expiry again without upgrading the historical decision view", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const expiry = now + 1000;
    const review = reviewed({ decision: view({ expiresAt: complete(new Date(expiry).toISOString()) }) });
    mount(review);
    await open();
    click("Create scoped rule");
    now = expiry + 1;
    click("Save scoped rule");
    expect(review.createRule).not.toHaveBeenCalled();
    expect(screen.getByText(/The reviewed grant expired/)).toBeTruthy();
  });
  it("permits only the separately supplied current denial on unknown coverage", async () => {
    const review = reviewed({ decision: view({ coverage: undefined }) });
    mount(review);
    await open();
    click("Deny");
    await screen.findByText(/Denial recorded/);
    expect(review.deny).toHaveBeenCalledTimes(1);
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(review.createRule).not.toHaveBeenCalled();
  });
  it("blocks close/cancel during a pending save and never replays an uncertain acknowledgement", async () => {
    const pending = deferred<ScopedChoiceResult>();
    const review = reviewed({ createRule: vi.fn(() => pending.promise) });
    mount(review);
    await open();
    click("Create scoped rule");
    click("Save scoped rule");
    click("Cancel review");
    act(() => {
      expect(h.layers.closeTop()).toBe("kept");
    });
    expect(review.createRule).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve("uncertain");
    });
    click("Close review");
    click("Review permission");
    expect(screen.queryByRole("button", { name: "Create scoped rule" })).toBeNull();
    expect(review.createRule).toHaveBeenCalledTimes(1);
  });
  it("ignores late review reads after workspace changes", async () => {
    const pending = deferred<ScopedRuleReview | undefined>();
    const host = mount(reviewed(), { scopedRuleReview: { scopeKey: "old", review: () => pending.promise } });
    click("Review permission");
    host.change({ scopedRuleReview: { scopeKey: "new", review: async () => reviewed() } });
    await act(async () => {
      pending.resolve(reviewed());
    });
    expect(screen.queryByText("read bounded fixture")).toBeNull();
  });
  it("moves focus to the existing card on workspace invalidation", async () => {
    const host = mount();
    await open();
    screen.getByRole("button", { name: "Allow once" }).focus();
    host.change({ scopedRuleReview: { scopeKey: "new", review: async () => reviewed() } });
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "permission, Review scoped tool permission" }),
    );
  });
  it("keeps external focus on late save acknowledgement", async () => {
    const pending = deferred<ScopedChoiceResult>();
    mount(reviewed({ createRule: () => pending.promise }));
    await open();
    click("Create scoped rule");
    click("Save scoped rule");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await act(async () => {
      pending.resolve("confirmed");
    });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
  it("never retries a throwing current-authority check", async () => {
    const review = reviewed({
      isCurrent: () => {
        throw new Error("SECRET_AUTHORITY");
      },
    });
    mount(review);
    await open();
    click("Allow once");
    click("Deny");
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(review.deny).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("SECRET_AUTHORITY");
  });
  it("does not render extension fields from the scope port", async () => {
    const review = reviewed();
    mount({ ...review, scope: { ...review.scope, ...{ privateExtension: "SECRET_EXTENSION_CANARY" } } });
    await open();
    expect(document.body.textContent).not.toContain("SECRET_EXTENSION_CANARY");
  });
  it("disables positive choices when exact scope disclosure is incomplete", async () => {
    const review = reviewed();
    mount({ ...review, scope: { ...review.scope, limits: "" } });
    await open();
    click("Allow once");
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(screen.getByText("Allow once: Exact scope disclosure is unavailable.")).toBeTruthy();
  });
  it("preserves the explicit revision and read-only boundaries", () => {
    const port = { scopeKey: "a", review: vi.fn(async () => reviewed()) };
    const host = mount(reviewed(), {
      scopedRuleReview: port,
      input: { ...PERMISSION_ASK, revisionActionId: "revise" },
    });
    click("Review permission");
    expect(port.review).not.toHaveBeenCalled();
    host.change({ scopedRuleReview: port, cannotWrite: "Read-only connection." });
    click("Review permission");
    expect(port.review).not.toHaveBeenCalled();
  });
});

describe("scoped choice boundaries", () => {
  it("shows the matched rule, its revision and the effective scope without private references", async () => {
    mount(reviewed({ decision: matched() }));
    await open();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(new RegExp(`Matched rule ${ruleIds.rule!}\\s*revision\\s*${ruleIds.revision!}`));
    expect(text).toContain("stored-rule");
    expect(text).toContain("/synthetic/reviewed.txt only");
    expect(text).toContain("temporary workspace; no network");
    expect(text).not.toMatch(/SECRET|private-|rm -rf/);
  });
  it.each([
    ["revoked", { revocation: complete("revoked") }, "revoked"],
    ["expired", { expiresAt: complete("2020-01-01T00:00:00Z") }, "expired"],
  ] as const)("a %s matched rule stays identified but cannot authorize a positive choice", async (_n, patch, word) => {
    const review = reviewed({ decision: matched(patch) });
    mount(review);
    await open();
    expect(document.body.textContent).toContain(word);
    expect(screen.getByText("Allow once: The reviewed grant expired or was revoked.")).toBeTruthy();
    click("Allow once");
    click("Create scoped rule");
    expect(review.allowOnce).not.toHaveBeenCalled();
    expect(review.createRule).not.toHaveBeenCalled();
  });
  it.each(["Allow once", "Deny"] as const)("latches duplicate %s clicks to one owner call", async (name) => {
    const pending = deferred<ScopedChoiceResult>();
    const review = reviewed({ allowOnce: vi.fn(() => pending.promise), deny: vi.fn(() => pending.promise) });
    mount(review);
    await open();
    act(() => {
      click(name);
      click(name);
    });
    click(name === "Deny" ? "Allow once" : "Deny");
    expect(review.allowOnce).toHaveBeenCalledTimes(name === "Allow once" ? 1 : 0);
    expect(review.deny).toHaveBeenCalledTimes(name === "Deny" ? 1 : 0);
    // A pending one-time answer cannot be cancelled or closed away from under the owner.
    click("Cancel review");
    act(() => {
      expect(h.layers.closeTop()).toBe("kept");
    });
    await act(async () => {
      pending.resolve("confirmed");
    });
    expect(review.createRule).not.toHaveBeenCalled();
    expect(
      (review.allowOnce as ReturnType<typeof vi.fn>).mock.calls.length +
        (review.deny as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });
  it("a stale result (nothing sent) reports it and lets the person review again", async () => {
    const review = reviewed({ allowOnce: vi.fn(async () => "stale" as const) });
    const host = mount(review);
    await open();
    click("Allow once");
    await screen.findByText(/Nothing is confirmed; review again/);
    click("Close review");
    expect(screen.getByRole("button", { name: "Review permission" }).getAttribute("aria-disabled")).not.toBe("true");
    await open();
    expect(host.port.review).toHaveBeenCalledTimes(2);
    expect(review.allowOnce).toHaveBeenCalledTimes(1);
  });
  it("moves focus from a settled choice to the region and back to the trigger on close", async () => {
    const review = reviewed({ deny: vi.fn(async () => "refused" as const) });
    mount(review);
    await open();
    const deny = screen.getByRole("button", { name: "Deny" });
    deny.focus();
    click("Deny");
    await screen.findByText(/The choice was refused/);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Scoped permission review");
    const close = screen.getByRole("button", { name: "Close review" });
    close.focus();
    click("Close review");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review permission" }));
  });
  it("unmounting during a pending one-time answer cancels the review and claims nothing late", async () => {
    const pending = deferred<ScopedChoiceResult>();
    const cancel = vi.fn(async () => undefined);
    const review = reviewed({ allowOnce: vi.fn(() => pending.promise), cancel });
    const host = mount(review);
    await open();
    click("Allow once");
    host.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve("confirmed");
    });
    expect(document.body.textContent).not.toContain("One-time answer recorded");
    expect(review.createRule).not.toHaveBeenCalled();
  });
});
