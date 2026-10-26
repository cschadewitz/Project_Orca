// @vitest-environment happy-dom
/** Actual PermissionCard + scopedRulePort. Transport, approval, disclosure and managed owners are synthetic. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SCOPED_PERMISSION_CONTRACTS, type ScopedPermissionMethod } from "@orca/protocol";
import { projectGuardDecision } from "../../../protocol/src/guard-decision-projection.js";
import type { ScopedPermissionBridge } from "../../src/scoped-permission-bridge.js";
import { PermissionCard } from "../src/attention/permission-card.js";
import { harness, type Harness } from "./harness.js";
import { fakeBridge } from "./fake-bridge.js";
import { PERMISSION_ASK } from "./fixtures-inputs.js";
const publicId = "00000000-0000-4000-8000-000000000001";
const complete = <T,>(value: T) => ({ state: "complete", value });
function view(patch: Record<string, unknown> = {}) {
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
    { requiredDisclosure: () => "complete", reference: () => ({ id: publicId }) },
    Date.now(),
  );
}

let h: Harness;
let restore: () => void;
afterEach(() => {
  cleanup();
  h?.dispose();
  restore?.();
  vi.restoreAllMocks();
});
beforeEach(() => {
  restore = () => {};
});
const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
function fixture() {
  const fake = fakeBridge({
    connection: {
      state: "live",
      since: new Date().toISOString(),
      generation: 1,
      methods: Object.keys(SCOPED_PERMISSION_CONTRACTS),
    },
  });
  fake.script({
    hello: async () => ({
      ok: true,
      result: { protocol: { major: 1, minor: 0 }, orcaVersion: "synthetic", capabilities: [], identity: target },
    }),
  });
  const calls: { method: ScopedPermissionMethod; params: Record<string, unknown> }[] = [];
  const handles = new Map<string, string>();
  let counter = 0;
  let lost = false;
  let stale = false;
  let mismatch = false;
  let pause: Promise<void> | undefined;
  const call = vi.fn(async (method: ScopedPermissionMethod, raw: unknown) => {
    const params = SCOPED_PERMISSION_CONTRACTS[method].params.parse(raw) as Record<string, unknown>;
    calls.push({ method, params });
    if (method === "scopedPermissions.review") {
      if (stale) return { ok: false, error: { code: "CONFIG_STALE", message: "Synthetic review unavailable" } };
      const handle = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
      handles.set(handle, "ready");
      return {
        ok: true,
        result: SCOPED_PERMISSION_CONTRACTS[method].result.parse({
          handle,
          scope: {
            principal: "Synthetic operator",
            operation: "Read fixture",
            resources: "One disposable file",
            environment: "Synthetic fixture",
            lifetime: "One minute",
            limits: "Read only",
            authorizer: "Synthetic owner",
            coverage: "Synthetic verified boundary",
          },
          reviewUntil: Date.now() + 60000,
          requiredReview: "passed",
          decision: view(),
        }),
      };
    }
    const handle = params.handle as string;
    if (method === "scopedPermissions.cancel") {
      handles.set(handle, "cancelled");
      return { ok: true, result: { outcome: "cancelled" } };
    }
    if (method === "scopedPermissions.choose") {
      if (stale || handles.get(handle) !== "ready")
        return { ok: false, error: { code: "CONFIG_STALE", message: "Synthetic stale review" } };
      handles.set(handle, "pending");
      await pause;
      const outcome = (params.choice === "save") !== mismatch ? "saved" : "answered";
      handles.set(handle, outcome);
      if (lost) throw new Error("PRIVATE_LOST_ACK");
      return { ok: true, result: { outcome } };
    }
    throw new Error("Unexpected synthetic transport method");
  });
  fake.bridge.scopedPermissions = { call: call as ScopedPermissionBridge["call"] };
  restore = fake.install();
  h = harness();
  const onAnswer = vi.fn();
  const element = () => (
    <h.Providers>
      <PermissionCard input={PERMISSION_ASK} placement="inbox" onAnswer={onAnswer} />
    </h.Providers>
  );
  const host = render(element());
  return {
    fake,
    calls,
    handles,
    onAnswer,
    host,
    rerender: () => host.rerender(element()),
    lose: () => {
      lost = true;
    },
    mismatch: () => {
      mismatch = true;
    },
    stale: () => {
      stale = true;
    },
    hold: () => {
      let release!: () => void;
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
async function open() {
  click("Review permission");
  await screen.findByText("Read fixture");
}
async function save() {
  await open();
  click("Create scoped rule");
  click("Save scoped rule");
  await screen.findByText(/Scoped rule saved/);
}
it("confirms save only, then loads a fresh handle for a separately selected answer", async () => {
  const f = fixture();
  await save();
  const first = f.calls.find((c) => c.method === "scopedPermissions.choose")!;
  expect(first.params.choice).toBe("save");
  expect(f.onAnswer).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  click("Review separate answer");
  await screen.findByRole("button", { name: "Allow once" });
  expect(screen.queryByRole("button", { name: "Create scoped rule" })).toBeNull();
  await waitFor(() => expect(f.handles.get(first.params.handle as string)).toBe("cancelled"));
  click("Allow once");
  await screen.findByText(/One-time answer recorded/);
  const choices = f.calls.filter((c) => c.method === "scopedPermissions.choose");
  expect(choices.map((c) => c.params.choice)).toEqual(["save", "allow-once"]);
  expect(choices[1]!.params.handle).not.toBe(choices[0]!.params.handle);
  expect(Object.keys(choices[1]!.params).sort()).toEqual(["choice", "handle", "target"]);
  expect(f.onAnswer).not.toHaveBeenCalled();
});
it("close after save cancels that handle; reopening permits only a fresh separate answer", async () => {
  const f = fixture();
  await save();
  const first = [...f.handles.keys()][0]!;
  click("Close review");
  await waitFor(() => expect(f.handles.get(first)).toBe("cancelled"));
  await open();
  expect(screen.queryByRole("button", { name: "Create scoped rule" })).toBeNull();
  click("Cancel review");
  await waitFor(() => expect([...f.handles.values()]).toEqual(["cancelled", "cancelled"]));
  expect(f.calls.filter((c) => c.method === "scopedPermissions.choose")).toHaveLength(1);
});
it("a lost save acknowledgement never unlocks another review or answer", async () => {
  const f = fixture();
  f.lose();
  await open();
  click("Create scoped rule");
  click("Save scoped rule");
  await screen.findByText(/Acknowledgement is uncertain/);
  expect(screen.queryByRole("button", { name: "Review separate answer" })).toBeNull();
  click("Close review");
  click("Review permission");
  expect(f.calls.filter((c) => c.method === "scopedPermissions.review")).toHaveLength(1);
  expect(f.calls.filter((c) => c.method === "scopedPermissions.choose")).toHaveLength(1);
  expect(document.body.textContent).not.toContain("PRIVATE_LOST_ACK");
});
it("revalidates the fresh answer at the transport and reports a stale refusal", async () => {
  const f = fixture();
  await save();
  click("Review separate answer");
  await screen.findByRole("button", { name: "Allow once" });
  f.stale();
  click("Allow once");
  await screen.findByText(/The choice was refused/);
  expect([...f.handles.values()]).not.toContain("answered");
});
it("does not confirm an acknowledgement from an older connection generation", async () => {
  const f = fixture();
  await open();
  click("Create scoped rule");
  const release = f.hold();
  click("Save scoped rule");
  f.fake.connect({ ...f.fake.connection, generation: 2 });
  await act(async () => {
    release();
  });
  await screen.findByText(/Acknowledgement is uncertain/);
  expect(screen.queryByRole("button", { name: "Review separate answer" })).toBeNull();
});
it("a changed binding before a separate answer prevents transport submission", async () => {
  const f = fixture();
  await save();
  click("Review separate answer");
  await screen.findByRole("button", { name: "Allow once" });
  f.fake.connect({ ...f.fake.connection, generation: 2 });
  click("Allow once");
  expect(f.calls.filter((c) => c.method === "scopedPermissions.choose")).toHaveLength(1);
});
it("double clicks cannot duplicate save or the separate answer", async () => {
  const f = fixture();
  await open();
  click("Create scoped rule");
  const release = f.hold();
  act(() => {
    click("Save scoped rule");
    click("Save scoped rule");
  });
  await act(async () => {
    release();
  });
  await screen.findByText(/Scoped rule saved/);
  click("Review separate answer");
  await screen.findByRole("button", { name: "Allow once" });
  act(() => {
    click("Allow once");
    click("Allow once");
  });
  await screen.findByText(/One-time answer recorded/);
  expect(f.calls.filter((c) => c.method === "scopedPermissions.choose").map((c) => c.params.choice)).toEqual([
    "save",
    "allow-once",
  ]);
});

it.each(["save", "allow-once", "deny"] as const)(
  "never confirms mismatched success for %s or retries it",
  async (choice) => {
    const f = fixture();
    await open();
    f.mismatch();
    if (choice === "save") {
      click("Create scoped rule");
      click("Save scoped rule");
    } else click(choice === "allow-once" ? "Allow once" : "Deny");
    await screen.findByText(/Acknowledgement is uncertain/);
    expect(screen.queryByText(/Scoped rule saved|One-time answer recorded|Denial recorded/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Review separate answer" })).toBeNull();
    click("Close review");
    click("Review permission");
    expect(f.calls.filter((c) => c.method === "scopedPermissions.choose")).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === "scopedPermissions.review")).toHaveLength(1);
  },
);

it("a refused fresh review cannot reuse the saved handle or resend save", async () => {
  const f = fixture();
  await save();
  const first = [...f.handles.keys()][0]!;
  f.stale();
  click("Review separate answer");
  await screen.findByText(/Review is unavailable. No choice was sent/);
  await waitFor(() => expect(f.handles.get(first)).toBe("cancelled"));
  click("Allow once");
  expect(screen.queryByRole("button", { name: "Create scoped rule" })).toBeNull();
  expect(f.calls.filter((c) => c.method === "scopedPermissions.choose")).toHaveLength(1);
});
