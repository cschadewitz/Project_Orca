/**
 * #857 review regression, main → bridge → renderer: the daemon accepts a guided launch, then
 * protected storage refuses its receipt. The screen must keep the original launch and offer
 * recovery, not a fresh Retry or a "no run was submitted" claim. Recovering while still
 * locked is refused the same way; after unlocking, Recover finds the same original intent
 * and reconciles it with no second admission.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeResult } from "../../src/bridge.js";
import type { LaunchResponse, LaunchReview } from "../../src/configuration-launch-contract.js";
import { AdmissionIntents, protectedStorageBridgeError } from "../../src/main/admission-intents.js";
import { GuidedLaunchController as MainController, type GuidedIntentConnection } from "../../src/main/guided-launch.js";
import { GuidedLaunchController } from "../src/guided-launch/controller.js";
import type { LaunchPorts, LaunchReceipt } from "../src/guided-launch/contracts.js";
import { unwrap } from "../src/guided-launch/production-bindings.js";
import { sharedLaunchResult } from "../src/guided-launch/shared-bindings.js";
import { launchContext, launchDraft, launchPorts } from "./guided-launch-fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** What the IPC handler in main/index.ts does with a thrown error. */
async function bridged<T>(work: () => Promise<T>): Promise<BridgeResult<T>> {
  try {
    return { ok: true, result: await work() };
  } catch (error) {
    return {
      ok: false,
      error: protectedStorageBridgeError(error) ?? {
        code: "AGENT_TRANSPORT",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
const decode = (raw: unknown): LaunchReceipt => raw as LaunchReceipt;

function wire(lockOnSend: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "orca-recovery-"));
  dirs.push(dir);
  const key = randomBytes(32);
  const keyring = { unlocked: true };
  const journal = new AdmissionIntents(join(dir, "intent.enc"), {
    isEncryptionAvailable: () => keyring.unlocked,
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
  });
  const target = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    instanceId: "00000000-0000-4000-8000-000000000002",
    epoch: 1,
  };
  const review: LaunchReview = {
    target,
    draftSequence: 1,
    workflowId: "orca-beta-local-check", // rename-keep: the first-run sample's id, kept so existing workspaces still match
    workflowVersion: "1",
    expectedWorkflowRevision: "revision",
    expectedConfigGeneration: "generation",
    checkout: { state: "unavailable", reason: "fixture" },
    command: {
      mode: "direct",
      params: {
        workflowId: "orca-beta-local-check", // rename-keep: the first-run sample's id, kept so existing workspaces still match
        workflowVersion: "1",
        expectedWorkflowRevision: "revision",
        expectedConfigGeneration: "generation",
        vars: { task: "sample" },
      },
    },
  };
  // The daemon admits once per idempotency key and replays on reconcile.
  const admissions = new Map<string, string>();
  const send = vi.fn<GuidedIntentConnection["send"]>(async (record) => {
    if (!admissions.has(record.idempotencyKey)) admissions.set(record.idempotencyKey, `run-${admissions.size + 1}`);
    if (lockOnSend) keyring.unlocked = false; // the keyring locks before the receipt is written
    return {
      kind: "direct",
      receipt: {
        state: "accepted",
        operationId: "operation",
        admissionId: "admission",
        runId: admissions.get(record.idempotencyKey)!,
      },
    };
  });
  const recover = vi.fn<GuidedIntentConnection["recover"]>(async (record) => ({
    kind: "retry",
    receipt: {
      state: "resolved",
      operationId: "operation",
      replayed: true,
      result: { state: "accepted", admissionId: "admission", runId: admissions.get(record.idempotencyKey)! },
    },
  }));
  const main = new MainController(journal, async () => ({
    scope: { target: "bundled:/workspace", workspaceId: target.workspaceId, principalId: "local" },
    target,
    assertCurrent() {},
    verifyReview: async () => {},
    verifyRecovery: async () => {},
    send,
    recover,
  }));
  const ports: LaunchPorts = {
    ...launchPorts(),
    launch: async () => {
      const result = unwrap(await bridged(() => main.submit(review)));
      return {
        intent: { id: result.intent.intentId },
        response: sharedLaunchResult(result.response, "direct", decode),
      };
    },
    resolveIntent: async () => {
      const handles = unwrap(await bridged(() => main.retained()));
      const handle = handles.find((h) => h.workflowId === review.workflowId);
      return handle ? { id: handle.intentId } : undefined;
    },
    recover: async (intent) => {
      const response: LaunchResponse = unwrap(await bridged(() => main.recover(intent.id, "reconcile")));
      return sharedLaunchResult(response, "direct", decode);
    },
  };
  const ui = new GuidedLaunchController(launchContext(), launchDraft(), ports);
  return { ui, main, journal, keyring, send, recover, admissions, review, target };
}
it("accepted send, refused receipt, Recover while locked, unlock, Recover: one admission", async () => {
  const { ui, keyring, send, recover, admissions } = wire(true);
  await ui.preview();
  await ui.submit();

  let state = ui.read();
  expect(send).toHaveBeenCalledTimes(1);
  expect(state.phase).toBe("blocked");
  expect(state.storageRefusal).toBeUndefined();
  expect(state.unresolvedReview).toBeDefined();
  expect(state.message).toContain("The launch was sent");
  expect(state.message).toContain("recover the original launch");
  expect(state.message).not.toContain("No run was submitted");
  await ui.retryProtectedStorage();
  expect(send).toHaveBeenCalledTimes(1);

  await ui.recover(); // still locked
  state = ui.read();
  expect(state.phase).toBe("blocked");
  expect(state.unresolvedReview).toBeDefined();
  expect(state.message).toContain("An earlier launch may still exist");
  expect(state.message).not.toContain("No run was submitted");
  expect(recover).not.toHaveBeenCalled();

  keyring.unlocked = true;
  await ui.recover();
  state = ui.read();
  expect(state.phase).toBe("admitted");
  expect(state.result).toMatchObject({ state: "resolved", result: { state: "accepted", runId: "run-1" } });
  expect(recover).toHaveBeenCalledTimes(1);
  expect(recover.mock.calls[0]![0].idempotencyKey).toBe(send.mock.calls[0]![0].idempotencyKey);
  expect(send).toHaveBeenCalledTimes(1);
  expect(admissions.size).toBe(1);
});

it("a refused read of an existing journal at submit stays unconfirmed; verified absence makes it launchable", async () => {
  const { ui, journal, keyring, send, recover, admissions, target } = wire(false);
  // An earlier palette intent for another workflow: the journal exists, nothing retained for this review.
  journal.retain({ target: "bundled:/workspace", workspaceId: target.workspaceId, principalId: "local" }, "other");
  keyring.unlocked = false;
  await ui.preview();
  await ui.submit();
  let state = ui.read();
  expect(send).not.toHaveBeenCalled();
  expect(state.phase).toBe("blocked");
  expect(state.storageRefusal).toBeUndefined();
  expect(state.unresolvedReview).toBeDefined();
  expect(state.message).toContain("An earlier launch may still exist");
  expect(state.message).not.toContain("No run was submitted");
  await ui.retryProtectedStorage();
  expect(send).not.toHaveBeenCalled();

  await ui.recover(); // still locked: refused again, nothing sent
  expect(ui.read().phase).toBe("blocked");
  expect(ui.read().unresolvedReview).toBeDefined();
  expect(send).not.toHaveBeenCalled();

  keyring.unlocked = true;
  await ui.recover(); // readable, and no retained launch for this review: verified new
  state = ui.read();
  expect(state.phase).toBe("review");
  expect(state.unresolvedReview).toBeUndefined();
  expect(state.message).toContain("no retained launch exists for this review");
  expect(recover).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  await ui.submit();
  expect(ui.read().phase).toBe("admitted");
  expect(send).toHaveBeenCalledTimes(1);
  expect(admissions.size).toBe(1);
});
it("a refused read at submit with this review already retained recovers it, never sends it again", async () => {
  const { ui, main, keyring, send, recover, admissions, review } = wire(false);
  send.mockImplementationOnce(async () => {
    throw new Error("acknowledgement lost"); // retained, admission unknown to the UI
  });
  await expect(main.submit(review)).rejects.toThrow("acknowledgement lost");
  admissions.set(send.mock.calls[0]![0].idempotencyKey, "run-earlier");
  keyring.unlocked = false;
  await ui.preview();
  await ui.submit();
  expect(ui.read().message).not.toContain("No run was submitted");
  keyring.unlocked = true;
  await ui.recover();
  expect(ui.read().phase).toBe("admitted");
  expect(recover).toHaveBeenCalledTimes(1);
  expect(recover.mock.calls[0]![0].idempotencyKey).toBe(send.mock.calls[0]![0].idempotencyKey);
  expect(send).toHaveBeenCalledTimes(1);
  expect(admissions.size).toBe(1);
});
