import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaunchResponse, LaunchReview } from "../src/configuration-launch-contract.js";
import { AdmissionIntents, type IntentEncryption } from "../src/main/admission-intents.js";
import { GuidedLaunchController, type GuidedIntentConnection } from "../src/main/guided-launch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(mode: "direct" | "request" = "direct") {
  const dir = mkdtempSync(join(tmpdir(), "orca-guided-"));
  dirs.push(dir);
  const path = join(dir, "intent.enc"),
    key = randomBytes(32);
  const encryption: IntentEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value) {
      const nonce = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, nonce);
      const bytes = Buffer.concat([c.update(value, "utf8"), c.final()]);
      return Buffer.concat([nonce, c.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const c = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      c.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString("utf8");
    },
  };
  const journal = new AdmissionIntents(path, encryption);
  const target = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    instanceId: "00000000-0000-4000-8000-000000000002",
    epoch: 1,
  };
  const scope = { target: "https://daemon.example", workspaceId: target.workspaceId, principalId: "alice" };
  const params = {
    workflowId: "sample",
    workflowVersion: "1",
    expectedWorkflowRevision: "revision",
    expectedConfigGeneration: "generation",
    vars: { count: 0, enabled: false, note: "", nullable: null, task: "private task needle" },
  };
  const review: LaunchReview = {
    target,
    draftSequence: 1,
    workflowId: "sample",
    workflowVersion: "1",
    expectedWorkflowRevision: "revision",
    expectedConfigGeneration: "generation",
    checkout: { state: "unavailable", reason: "fixture" },
    command:
      mode === "direct"
        ? { mode, params }
        : { mode, params: { ...params, title: "task", body: "private Request body needle" } },
  };
  const send = vi.fn<GuidedIntentConnection["send"]>(async () =>
    mode === "direct"
      ? {
          kind: "direct",
          receipt: { state: "accepted", operationId: "operation", admissionId: "admission", runId: "run" },
        }
      : {
          kind: "request",
          receipt: { state: "accepted", admissionId: "admission", requestId: "request", runId: "run" },
        },
  );
  const verifyRecovery = vi.fn(async () => {});
  const connection: GuidedIntentConnection = {
    scope,
    target,
    assertCurrent() {},
    verifyReview: vi.fn(async () => {}),
    verifyRecovery,
    send,
    recover: vi.fn<GuidedIntentConnection["recover"]>(async () => ({
      kind: "retry",
      receipt: { state: "in-progress", operationId: "operation", recovery: "inspect-or-retry" },
    })),
  };
  const controller = new GuidedLaunchController(journal, async () => connection);
  return { path, encryption, journal, target, scope, review, send, connection, controller, verifyRecovery };
}
describe("protected guided intent recovery", () => {
  it.each(["direct", "request"] as const)(
    "persists exact %s command before send and retains the distinct receipt",
    async (mode) => {
      const f = fixture(mode);
      f.send.mockImplementationOnce(async () => {
        expect(existsSync(f.path)).toBe(true);
        const record = f.journal.guided(f.scope, f.journal.guidedList(f.scope)[0]!.intentId);
        expect(record.guided!.review.command).toEqual(f.review.command);
        return mode === "direct"
          ? {
              kind: "direct",
              receipt: { state: "accepted", operationId: "operation", admissionId: "admission", runId: "run" },
            }
          : {
              kind: "request",
              receipt: { state: "accepted", admissionId: "admission", requestId: "request", runId: "run" },
            };
      });
      const result = await f.controller.submit(f.review);
      expect(result.response.kind).toBe(mode);
      expect(result.intent.admissionId).toBe("admission");
      expect(result.intent.operationId).toBe(mode === "direct" ? "operation" : undefined);
      const restored = new AdmissionIntents(f.path, f.encryption);
      expect(restored.guided(f.scope, result.intent.intentId).guided!.review.command).toEqual(f.review.command);
      for (const needle of ["private task needle", "private Request body needle", f.scope.principalId])
        expect(readFileSync(f.path).toString()).not.toContain(needle);
      expect(JSON.stringify(result.intent)).not.toContain("needle");
    },
  );
  it("lost acknowledgement and restart recovery retain the same key and frozen guards", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("response lost"));
    await expect(f.controller.submit(f.review)).rejects.toThrow("response lost");
    const id = f.journal.guidedList(f.scope)[0]!.intentId,
      original = f.journal.guided(f.scope, id);
    const recovered = new GuidedLaunchController(new AdmissionIntents(f.path, f.encryption), async () => f.connection);
    f.connection.recover = vi.fn<GuidedIntentConnection["recover"]>(async (record) => {
      expect(record.idempotencyKey).toBe(original.idempotencyKey);
      expect(record.guided!.review).toEqual(original.guided!.review);
      return {
        kind: "retry",
        receipt: {
          state: "resolved",
          operationId: "operation",
          replayed: true,
          result: { state: "accepted", admissionId: "admission", runId: "run" },
        },
      };
    });
    const response = await recovered.recover(id, "reconcile");
    expect(response).toEqual({
      kind: "retry",
      receipt: {
        state: "resolved",
        operationId: "operation",
        replayed: true,
        result: { state: "accepted", admissionId: "admission", runId: "run" },
      },
    });
    expect(f.verifyRecovery).toHaveBeenCalled();
  });
  it("concurrent clicks share one local send and changed commands do not create new intent", async () => {
    const f = fixture();
    let release!: (value: LaunchResponse) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.controller.submit(f.review),
      second = f.controller.submit(f.review);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    release({ kind: "direct", receipt: { state: "prepared", operationId: "operation", admissionId: "admission" } });
    expect(await first).toEqual(await second);
    const changed = structuredClone(f.review);
    changed.command.params.vars = { task: "changed" };
    await expect(f.controller.submit(changed)).rejects.toThrow("retained command changed");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each(["unavailable", "basic_text"])("refuses %s storage before networking", async (backend) => {
    const f = fixture();
    f.encryption.isEncryptionAvailable = () => backend !== "unavailable";
    f.encryption.getSelectedStorageBackend = () => backend;
    await expect(f.controller.submit(f.review)).rejects.toThrow("Secure run-intent storage is unavailable");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("verifies authoritative review and original scope and fences late target replies", async () => {
    const f = fixture();
    f.connection.verifyReview = vi.fn(async () => {
      throw new Error("checkout unavailable");
    });
    await expect(f.controller.submit(f.review)).rejects.toThrow("checkout unavailable");
    expect(existsSync(f.path)).toBe(false);
    f.connection.verifyReview = async () => {};
    const record = f.journal.retainGuided(f.scope, f.review);
    expect(() => f.journal.guided({ ...f.scope, principalId: "bob" }, record.id)).toThrow("unavailable");
    let stale = false;
    f.connection.assertCurrent = () => {
      if (stale) throw new Error("stale target");
    };
    f.send.mockImplementationOnce(async () => {
      stale = true;
      return {
        kind: "direct",
        receipt: { state: "accepted", operationId: "operation", admissionId: "admission", runId: "run" },
      };
    });
    await expect(f.controller.submit(f.review)).rejects.toThrow("stale target");
    expect(f.journal.guided(f.scope, record.id).guided!.operationId).toBeUndefined();
  });
  it("validates nested receipt kind and protects old palette records from guided replay", async () => {
    const f = fixture();
    const old = f.journal.retain(f.scope, "other");
    expect(new AdmissionIntents(f.path, f.encryption).retain(f.scope, "other")).toEqual(old);
    const record = f.journal.retainGuided(f.scope, f.review);
    expect(() => f.journal.retain(f.scope, "sample")).toThrow("guided intent");
    expect(f.journal.list(f.scope)).toEqual([{ id: old.id, workflowId: "other" }]);
    f.connection.recover = async () => ({
      kind: "retry",
      receipt: {
        state: "resolved",
        operationId: "operation",
        replayed: true,
        result: { state: "accepted", admissionId: "admission", requestId: "unexpected-request", runId: "run" },
      },
    });
    await expect(f.controller.recover(record.id, "inspect")).rejects.toThrow();
  });
});
