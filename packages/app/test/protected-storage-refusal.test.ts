/**
 * #857: a refused keyring (locked, or its unlock prompt cancelled), a missing keyring
 * (`basic_text`) or an unavailable OS keychain is a specific, fail-closed refusal with
 * recovery guidance. Nothing is retained or sent, nothing falls back to plain text, and a
 * retry after unlocking submits the same reviewed command.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaunchReview } from "../src/configuration-launch-contract.js";
import {
  AdmissionIntents,
  ProtectedStorageRefusal,
  isProtectedStorageRefusal,
  protectedStorageBridgeError,
  type IntentEncryption,
} from "../src/main/admission-intents.js";
import { GuidedLaunchController, type GuidedIntentConnection } from "../src/main/guided-launch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(storage: { available: boolean; backend?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "orca-storage-"));
  dirs.push(dir);
  const path = join(dir, "intent.enc"),
    key = randomBytes(32);
  const state: { available: boolean; backend?: string | undefined } = { ...storage };
  const encryptString = vi.fn((value: string) => {
    if (!state.available) throw new Error("Encryption is not available.");
    const nonce = randomBytes(12),
      c = createCipheriv("aes-256-gcm", key, nonce);
    const bytes = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([nonce, c.getAuthTag(), bytes]);
  });
  const encryption: IntentEncryption = {
    isEncryptionAvailable: () => state.available,
    ...(state.backend === undefined ? {} : { getSelectedStorageBackend: () => state.backend! }),
    encryptString,
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
  const scope = { target: "bundled:/workspace", workspaceId: target.workspaceId, principalId: "local" };
  const params = {
    workflowId: "orca-beta-local-check", // rename-keep: the first-run sample's id, kept so existing workspaces still match
    workflowVersion: "1",
    expectedWorkflowRevision: "revision",
    expectedConfigGeneration: "generation",
    vars: { task: "private sample task needle" },
  };
  const review: LaunchReview = {
    target,
    draftSequence: 1,
    workflowId: "orca-beta-local-check", // rename-keep: the first-run sample's id, kept so existing workspaces still match
    workflowVersion: "1",
    expectedWorkflowRevision: "revision",
    expectedConfigGeneration: "generation",
    checkout: { state: "unavailable", reason: "fixture" },
    command: { mode: "direct", params },
  };
  const send = vi.fn<GuidedIntentConnection["send"]>(async () => ({
    kind: "direct",
    receipt: { state: "accepted", operationId: "operation", admissionId: "admission", runId: "run" },
  }));
  const connection: GuidedIntentConnection = {
    scope,
    target,
    assertCurrent() {},
    verifyReview: vi.fn(async () => {}),
    verifyRecovery: vi.fn(async () => {}),
    send,
    recover: vi.fn(),
  };
  const controller = new GuidedLaunchController(journal, async () => connection);
  return { path, state, encryptString, journal, review, send, controller, scope };
}
async function refusal(promise: Promise<unknown>): Promise<ProtectedStorageRefusal> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isProtectedStorageRefusal(error)).toBe(true);
  return error as ProtectedStorageRefusal;
}

describe("protected-storage refusal (#857)", () => {
  it.each([
    ["gnome_libsecret", "cancelled or locked GNOME keyring"],
    ["kwallet5", "locked KWallet"],
    ["kwallet6", "locked KWallet 6"],
  ])("names a %s refusal (%s) and says to reopen, unlock, then launch again", async (backend) => {
    const f = fixture({ available: false, backend });
    const error = await refusal(f.controller.submit(f.review));
    expect(error.reason).toBe("keyring-locked");
    expect(error.stage).toBe("before-send");
    expect(error.message).toMatch(/^Secure run-intent storage is unavailable\. No run was submitted\./);
    expect(error.message).toContain("not set up yet, or its prompt was cancelled");
    expect(error.message).toContain("only once each time it starts");
    expect(error.message).toContain("quit and reopen ORCA, follow the system prompt to create or unlock your keyring");
    expect(error.message).toContain("then launch again");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.encryptString).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
  });
  it.each([true, false])(
    "refuses basic_text even when Electron reports it available (%s), with no plain-text fallback",
    async (available) => {
      const f = fixture({ available, backend: "basic_text" });
      const error = await refusal(f.controller.submit(f.review));
      expect(error.reason).toBe("no-keyring");
      expect(error.message).toContain("No supported system keyring");
      expect(error.message).toContain("does not store run intents in plain text");
      expect(f.send).not.toHaveBeenCalled();
      expect(f.encryptString).not.toHaveBeenCalled();
      expect(existsSync(f.path)).toBe(false);
    },
  );
  it.each([undefined, "unknown"])("keeps the OS keychain refusal when the backend is %s", async (backend) => {
    const f = fixture({ available: false, ...(backend === undefined ? {} : { backend }) });
    const error = await refusal(f.controller.submit(f.review));
    expect(error.reason).toBe("unavailable");
    expect(error.message).toBe(
      "Secure run-intent storage is unavailable. No run was submitted; restore the OS keychain before retrying.",
    );
    expect(f.send).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
  });
  it("classifies a keyring that fails while encrypting, after reporting available", async () => {
    const f = fixture({ available: true, backend: "gnome_libsecret" });
    f.encryptString.mockImplementationOnce(() => {
      throw new Error("Error while encrypting the text provided to safeStorage.encryptString.");
    });
    const error = await refusal(f.controller.submit(f.review));
    expect(error.reason).toBe("keyring-locked");
    expect(f.send).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
  });
  it("retrying after the keyring is unlocked submits the same reviewed command once", async () => {
    const f = fixture({ available: false, backend: "gnome_libsecret" });
    await refusal(f.controller.submit(f.review));
    f.state.available = true;
    const result = await f.controller.submit(f.review);
    expect(result.response).toMatchObject({ kind: "direct", receipt: { state: "accepted", runId: "run" } });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![0].guided!.review.command).toEqual(f.review.command);
    expect(readFileSync(f.path).toString("utf8")).not.toContain("private sample task needle");
  });
  it("marks a receipt refusal after a send as after-send, never as nothing submitted", async () => {
    const f = fixture({ available: true, backend: "gnome_libsecret" });
    f.send.mockImplementationOnce(async () => {
      f.state.available = false;
      return {
        kind: "direct",
        receipt: { state: "accepted", operationId: "operation", admissionId: "admission", runId: "run" },
      };
    });
    const error = await refusal(f.controller.submit(f.review));
    expect(error.stage).toBe("after-send");
    expect(error.reason).toBe("keyring-locked");
    expect(error.message).toContain("The launch was sent");
    expect(error.message).toContain("recover the original launch");
    expect(error.message).not.toContain("No run was submitted");
    expect(protectedStorageBridgeError(error)).toEqual({
      code: "PROTECTED_STORAGE",
      message: error.message,
      details: { reason: "keyring-locked", stage: "after-send" },
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.state.available = true;
    expect(f.journal.guidedList(f.scope)).toHaveLength(1);
  });
  it("marks a refused read of retained intents as unconfirmed, without a no-run claim", async () => {
    const f = fixture({ available: true, backend: "gnome_libsecret" });
    await f.controller.submit(f.review);
    f.state.available = false;
    const error = await refusal(f.controller.retained());
    expect(error.stage).toBe("unconfirmed");
    expect(error.message).toContain("An earlier launch may still exist");
    expect(error.message).not.toContain("No run was submitted");
    expect(protectedStorageBridgeError(new Error("other"))).toBeUndefined();
  });
  it("keeps a refused read of an existing journal unconfirmed at submit", async () => {
    const f = fixture({ available: true, backend: "gnome_libsecret" });
    f.journal.retain(f.scope, "other-workflow");
    f.state.available = false;
    const error = await refusal(f.controller.submit(f.review));
    expect(error.stage).toBe("unconfirmed");
    expect(error.message).not.toContain("No run was submitted");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([
    ["gnome_libsecret", false, "keyring-locked"],
    ["kwallet6", false, "keyring-locked"],
    ["basic_text", true, "no-keyring"],
    [undefined, false, "unavailable"],
  ] as const)(
    "never directs a %s existing-journal refusal to launch again before the journal is verified",
    async (backend, available, reason) => {
      const f = fixture({ available: true, backend: "gnome_libsecret" });
      await f.controller.submit(f.review);
      f.state.available = available;
      f.state.backend = backend;
      for (const attempt of [f.controller.submit(f.review), f.controller.retained()]) {
        const error = await refusal(attempt);
        expect(error.stage).toBe("unconfirmed");
        expect(error.reason).toBe(reason);
        expect(error.message).toContain("An earlier launch may still exist; do not start new work.");
        expect(error.message).toContain("recover the original launch");
        expect(error.message).toContain("tells you if a new launch is safe");
        expect(error.message).not.toMatch(/launch again|start it again|try again|retry/i);
        expect(error.message).not.toContain("No run was submitted");
      }
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );
  it("is before-send once the existing journal was read and holds nothing for this work", async () => {
    const f = fixture({ available: true, backend: "gnome_libsecret" });
    f.journal.retain(f.scope, "other-workflow");
    f.encryptString.mockImplementationOnce(() => {
      throw new Error("Error while encrypting the text provided to safeStorage.encryptString.");
    });
    const error = await refusal(f.controller.submit(f.review));
    expect(error.stage).toBe("before-send");
    expect(error.message).toContain("No run was submitted");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("reads retained launches with no journal as before-send: nothing can have been sent", async () => {
    const f = fixture({ available: false, backend: "gnome_libsecret" });
    const error = await refusal(f.controller.retained());
    expect(error.stage).toBe("before-send");
    expect(error.message).toContain("No run was submitted");
    expect(error.message).not.toContain("An earlier launch may still exist");
  });
});
