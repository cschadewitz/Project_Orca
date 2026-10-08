/** Guarded #333 fixtures exercise stale/late/refused writes without importing daemon or pretending lowering is implemented. */
import { describe, expect, it, vi } from "vitest";
import type { ConfigApplyResult, ConfigGenerationStatus, ConfigSetResult } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import { StructuredEditorSession } from "../src/config/structured-form/editor-session.js";
import type { ConfigCandidate, EditorTarget, StructuredEditorPorts } from "../src/config/structured-form/contracts.js";
import { CONFIG_GET, CONFIG_REVISION } from "./fixtures-config.js";

const target: EditorTarget = { workspaceId: "w1", instanceId: "i1", epoch: 1 };
// Fixture lowering result only: runtime node/comment-preservation proof belongs to the integrator.
const text = "# untouched extension/comment\nversion: 1\nplugins: [sample]\n";
const generation: ConfigGenerationStatus = {
  savedRevision: "candidate",
  activeGeneration: "g1",
  activeRevision: CONFIG_REVISION,
  state: "pending",
  restartRequired: [],
};
function acknowledgement(written: boolean): { ok: true; result: ConfigSetResult } {
  return {
    ok: true,
    result: {
      document: { ...CONFIG_GET.config, revision: "candidate", text },
      written,
      generation,
      ...(!written ? { validation: { errors: [] } } : {}),
      asOf: "2026-10-08T00:00:00Z",
    },
  };
}
function fixture() {
  const lower = vi.fn<StructuredEditorPorts["lowering"]["lower"]>(async () => ({ status: "ready", text }));
  const set = vi.fn<StructuredEditorPorts["set"]>(async (params) => acknowledgement(params.validateOnly !== true));
  const apply = vi.fn<StructuredEditorPorts["apply"]>(async () => ({
    ok: true,
    result: {
      outcome: "applied",
      status: { ...generation, activeGeneration: "g2", activeRevision: "candidate", state: "active" },
      validation: { errors: [] },
    },
  }));
  const access = vi.fn<StructuredEditorPorts["access"]>(() => ({ allowed: true }));
  const policyChange = vi.fn<StructuredEditorPorts["policyChange"]>(() => false);
  const safeErrors = vi.fn<StructuredEditorPorts["safeErrors"]>((errors) =>
    errors.map((_) => ({ path: ["hosts", 0, "id"], message: "This host is referenced by agents[0].host." })),
  );
  const session = new StructuredEditorSession(target, CONFIG_REVISION, {
    lowering: { preservesComments: true, lower },
    set,
    apply,
    access,
    policyChange,
    safeErrors,
  });
  session.edit([
    { kind: "insert", path: ["hosts"], index: 0, value: { id: "a" } },
    { kind: "move", path: ["hosts"], from: 1, to: 0 },
  ]);
  return { session, lower, set, apply, access, policyChange, safeErrors };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("exact candidate validation, review, save and activation", () => {
  it("passes ordered intents and original target/revision to lowering and saves identical reviewed bytes", async () => {
    const f = fixture();
    await f.session.save();
    expect(f.set).not.toHaveBeenCalled();
    await f.session.validate();
    expect(f.lower.mock.calls[0]?.[0]).toMatchObject({
      target,
      expectedRevision: CONFIG_REVISION,
      draftSequence: 1,
      document: "config",
    });
    expect(f.lower.mock.calls[0]?.[0].edits.map((edit) => edit.kind)).toEqual(["insert", "move"]);
    expect(f.set).toHaveBeenNthCalledWith(1, {
      document: "config",
      expectedRevision: CONFIG_REVISION,
      text,
      validateOnly: true,
    });
    expect(f.session.snapshot().phase).toBe("reviewed");
    await f.session.save();
    expect(f.set).toHaveBeenNthCalledWith(2, { document: "config", expectedRevision: CONFIG_REVISION, text });
    expect(f.session.snapshot().phase).toBe("saved");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.session.snapshot().edits).toEqual([]);
    await f.session.apply();
    expect(f.apply).toHaveBeenCalledWith({ expectedRevision: "candidate", expectedGeneration: "g1" });
    expect(f.session.snapshot().phase).toBe("active");
  });
  it.each(["validated", "restart-required", "invalid"] as const)("never calls %s activation", async (outcome) => {
    const f = fixture();
    f.apply.mockResolvedValue({ ok: true, result: { outcome, status: generation, validation: { errors: [] } } });
    await f.session.validate();
    await f.session.save();
    await f.session.apply();
    expect(f.session.snapshot()).toMatchObject({ phase: "saved", applyOutcome: outcome });
    await f.session.apply();
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("requires confirmation of the current policy review and invalidates it on edit", async () => {
    const f = fixture();
    f.policyChange.mockReturnValue(true);
    await f.session.validate();
    await f.session.save();
    expect(f.set).toHaveBeenCalledTimes(1);
    expect(f.session.confirmPolicy(0)).toBe(false);
    expect(f.session.confirmPolicy(1)).toBe(true);
    f.session.edit([{ kind: "set", path: ["policy"], value: "deny" }]);
    await f.session.save();
    expect(f.set).toHaveBeenCalledTimes(1);
    await f.session.validate();
    expect(f.session.confirmPolicy(1)).toBe(false);
    f.session.confirmPolicy(2);
    await f.session.save();
    expect(f.set).toHaveBeenCalledTimes(3);
    expect(f.set.mock.calls.every(([params]) => params.document === "config")).toBe(true);
  });
  it("uses daemon errors for cross references and sanitizes their values before display", async () => {
    const f = fixture();
    f.set.mockResolvedValue({
      ok: true,
      result: {
        ...acknowledgement(false).result,
        validation: { errors: [{ path: "hosts.0.id", message: "secret-bearing rejected value" }] },
      },
    });
    await f.session.validate();
    expect(f.session.snapshot()).toMatchObject({
      phase: "blocked",
      errors: [{ path: ["hosts", 0, "id"], message: "This host is referenced by agents[0].host." }],
    });
    expect(JSON.stringify(f.session.snapshot())).not.toContain("secret-bearing");
    await f.session.save();
    expect(f.set).toHaveBeenCalledTimes(1);
  });
});

describe("draft retention and optimistic fences", () => {
  it("places sanitized daemon save-refusal reference errors and requires a new review", async () => {
    const f = fixture();
    await f.session.validate();
    f.set.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "CONFIG_INVALID",
        message: "secret",
        details: { errors: [{ path: "hosts.0.id", message: "secret-reference" }] },
      },
    });
    await f.session.save();
    expect(f.session.snapshot()).toMatchObject({
      phase: "blocked",
      errors: [{ path: ["hosts", 0, "id"], message: "This host is referenced by agents[0].host." }],
    });
    expect(f.session.snapshot().edits).toHaveLength(2);
    expect(JSON.stringify(f.session.snapshot())).not.toContain("secret");
    await f.session.save();
    expect(f.set).toHaveBeenCalledTimes(2);
    await f.session.validate();
    expect(f.set).toHaveBeenCalledTimes(3);
  });
  it("does not call a mismatched apply receipt active", async () => {
    const f = fixture();
    await f.session.validate();
    await f.session.save();
    f.apply.mockResolvedValueOnce({
      ok: true,
      result: {
        outcome: "applied",
        status: { ...generation, state: "active", activeRevision: "other" },
        validation: { errors: [] },
      },
    });
    await f.session.apply();
    expect(f.session.snapshot().phase).toBe("blocked");
    expect(f.session.snapshot().applyOutcome).toBeUndefined();
  });
  it("keeps a newly edited draft separate from a successful apply of the earlier saved revision", async () => {
    const f = fixture();
    await f.session.validate();
    await f.session.save();
    const hold = deferred<BridgeResult<ConfigApplyResult>>();
    f.apply.mockReturnValueOnce(hold.promise);
    const applying = f.session.apply();
    f.session.edit([{ kind: "set", path: ["version"], value: 2 }]);
    hold.resolve({
      ok: true,
      result: {
        outcome: "applied",
        status: { ...generation, state: "active", activeRevision: "candidate" },
        validation: { errors: [] },
      },
    });
    await applying;
    expect(f.session.snapshot()).toMatchObject({ phase: "editing", applyOutcome: "applied" });
    expect(f.session.snapshot().edits).toHaveLength(1);
  });
  it("still blocks validation when all daemon diagnostic text was withheld", async () => {
    const f = fixture();
    f.safeErrors.mockReturnValue([]);
    f.set.mockResolvedValueOnce({
      ok: true,
      result: { ...acknowledgement(false).result, validation: { errors: [{ path: "sensitive", message: "secret" }] } },
    });
    await f.session.validate();
    await f.session.save();
    expect(f.session.snapshot()).toMatchObject({ phase: "blocked", errors: [] });
    expect(f.set).toHaveBeenCalledTimes(1);
  });
  it("freezes CONFIG_STALE without rebasing or resubmitting", async () => {
    const f = fixture();
    await f.session.validate();
    f.set.mockResolvedValue({ ok: false, error: { code: "CONFIG_STALE", message: "private source details" } });
    await f.session.save();
    expect(f.session.snapshot().phase).toBe("blocked");
    expect(f.session.snapshot().edits).toHaveLength(2);
    await f.session.validate();
    await f.session.save();
    expect(f.set).toHaveBeenCalledTimes(2);
    expect(f.session.reconcile(target, "new-base", f.session.snapshot().edits)).toBe(true);
    f.set.mockImplementation(async (params) => acknowledgement(params.validateOnly !== true));
    await f.session.validate();
    expect(f.set.mock.lastCall?.[0].expectedRevision).toBe("new-base");
  });
  it("ignores validation responses after an edit or target epoch change", async () => {
    const f = fixture();
    const hold = deferred<BridgeResult<ConfigSetResult>>();
    f.set.mockReturnValueOnce(hold.promise);
    const validation = f.session.validate();
    await vi.waitFor(() => expect(f.set).toHaveBeenCalledTimes(1));
    f.session.edit([{ kind: "set", path: ["version"], value: 2 }]);
    hold.resolve(acknowledgement(false));
    await validation;
    expect(f.session.snapshot().phase).toBe("editing");
    const hold2 = deferred<BridgeResult<ConfigSetResult>>();
    f.set.mockReturnValueOnce(hold2.promise);
    const second = f.session.validate();
    await vi.waitFor(() => expect(f.set).toHaveBeenCalledTimes(2));
    f.session.setTarget({ ...target, epoch: 2 });
    hold2.resolve(acknowledgement(false));
    await second;
    expect(f.session.snapshot().phase).toBe("blocked");
    expect(f.session.snapshot().edits).toHaveLength(3);
    expect(f.session.reconcile({ ...target, epoch: 2 }, "new", [])).toBe(false);
    expect(f.session.edit([])).toBe(false);
  });
  it("keeps edits made while saving and requires reconciliation before they can be saved", async () => {
    const f = fixture();
    await f.session.validate();
    const hold = deferred<BridgeResult<ConfigSetResult>>();
    f.set.mockReturnValueOnce(hold.promise);
    const saving = f.session.save();
    f.session.edit([{ kind: "set", path: ["version"], value: 2 }]);
    hold.resolve(acknowledgement(true));
    await saving;
    expect(f.session.snapshot()).toMatchObject({ phase: "blocked", sequence: 2 });
    expect(f.session.snapshot().edits).toHaveLength(3);
    await f.session.validate();
    expect(f.set).toHaveBeenCalledTimes(2);
  });
  it("does not retry or claim activation after lost acknowledgements", async () => {
    const f = fixture();
    await f.session.validate();
    f.set.mockRejectedValueOnce(new Error("secret response"));
    await f.session.save();
    expect(f.session.snapshot().phase).toBe("blocked");
    expect(f.session.snapshot().edits).toHaveLength(2);
    await f.session.save();
    expect(f.set).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.session.snapshot())).not.toContain("secret response");
  });
  it("refuses missing comment-preserving lowering and rechecks permission after lowering", async () => {
    const f = fixture();
    f.lower.mockResolvedValueOnce({ status: "unsupported" });
    await f.session.validate();
    expect(f.set).not.toHaveBeenCalled();
    f.lower.mockImplementationOnce(async () => {
      f.access.mockReturnValue({ allowed: false, reason: "Permission revoked" });
      return { status: "ready", text };
    });
    await f.session.validate();
    expect(f.set).not.toHaveBeenCalled();
    expect(f.session.snapshot().message).toBe("Permission revoked");
  });
  it("blocks generation races and ignores late apply acknowledgement from a changed workspace", async () => {
    const f = fixture();
    await f.session.validate();
    await f.session.save();
    f.apply.mockResolvedValueOnce({
      ok: false,
      error: { code: "CONFIG_STALE", message: "generation moved" },
    });
    await f.session.apply();
    expect(f.session.snapshot().phase).toBe("blocked");
    const g = fixture();
    await g.session.validate();
    await g.session.save();
    const hold = deferred<BridgeResult<ConfigApplyResult>>();
    g.apply.mockReturnValueOnce(hold.promise);
    const applying = g.session.apply();
    g.session.setTarget({ ...target, workspaceId: "w2" });
    hold.resolve({ ok: true, result: { outcome: "applied", status: generation, validation: { errors: [] } } });
    await applying;
    expect(g.session.snapshot().phase).toBe("blocked");
  });
  it("does not leak values in semantic change summaries and isolates caller mutations", () => {
    const f = fixture();
    const candidate: ConfigCandidate = f.session.candidate();
    (candidate.edits as unknown as { kind: string }[]).length = 0;
    expect(f.session.snapshot().edits).toHaveLength(2);
    f.session.edit([{ kind: "set", path: ["sensitive"], value: "secret" }]);
    expect(JSON.stringify(f.session.snapshot().changes)).not.toContain("secret");
  });
});
