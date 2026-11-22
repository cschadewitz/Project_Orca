/**
 * Main-process checkpoint-attempt intents (#357): the key and a reserved receipt survive the
 * renderer and the process, a lost answer is asked again with the same key, a refusal ends the
 * intent, a reserved attempt is only ever reconciled, and an answer that arrives after the
 * connection changed settles its own record without being shown.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunsRecoverResult } from "@orca/protocol";
import type { IntentEncryption, IntentScope } from "../src/main/admission-intents.js";
import { RecoveryIntentController, RecoveryIntents, type RecoveryConnection } from "../src/main/recovery-intents.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class Refusal extends Error {}
const OPERATION = "retry_00000000-0000-4000-8000-000000000009";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orca-recovery-intent-"));
  dirs.push(dir);
  const path = join(dir, "recovery-intents.enc");
  const key = randomBytes(32);
  const encryption: IntentEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decryptString: (value) => {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
  const scope: IntentScope = { target: "https://daemon.example", workspaceId: "workspace", principalId: "alice" };
  let current = true;
  const recover = vi.fn<RecoveryConnection["recover"]>();
  const reconcile = vi.fn<RecoveryConnection["reconcile"]>();
  const connection = (over: Partial<RecoveryConnection> = {}): RecoveryConnection => ({
    scope,
    assertCurrent: () => {
      if (!current) throw new Error("stale connection");
    },
    recover,
    reconcile,
    refused: (error) => error instanceof Refusal,
    ...over,
  });
  let connect = async () => connection();
  const confirm = vi.fn(async () => true);
  const controller = (journal = new RecoveryIntents(path, encryption)) =>
    new RecoveryIntentController(journal, () => connect(), confirm);
  return {
    path,
    encryption,
    scope,
    recover,
    reconcile,
    confirm,
    controller,
    switchConnection: () => {
      current = false;
    },
    useConnection: (next: () => Promise<RecoveryConnection>) => {
      connect = next;
    },
    connection,
  };
}

const accepted = (runId: string, sourceRunId = "run-src"): RunsRecoverResult => ({
  state: "accepted",
  operationId: OPERATION,
  admissionId: "adm",
  runId,
  sourceRunId,
});
const reserved: RunsRecoverResult = {
  state: "recoverable-failure",
  operationId: OPERATION,
  admissionId: "adm",
  runId: "run-reserved",
  failure: { code: "RUN_STATE", message: "interrupted", recovery: "reconcile" },
};

it("asks again with the same key after a lost answer, across a new process, then settles", async () => {
  const f = fixture();
  f.recover.mockRejectedValueOnce(new Error("socket hang up"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("socket hang up");
  // A new process (new journal and controller over the same file) still holds the intent.
  expect(await f.controller().list("run-src")).toEqual([
    { id: expect.any(String), sourceRunId: "run-src", checkpoint: "cp-1", reserved: false },
  ]);
  f.recover.mockResolvedValueOnce(accepted("run-attempt"));
  expect(await f.controller().start("run-src", "cp-1")).toEqual({ state: "accepted", runId: "run-attempt" });
  const [first, second] = f.recover.mock.calls.map(([params]) => params);
  expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
  expect(first).toMatchObject({ runId: "run-src", checkpoint: "cp-1", expectedScope: { principalId: "alice" } });
  expect(await f.controller().list("run-src")).toEqual([]);
  // The key is never written in plain text.
  expect(readFileSync(f.path).toString("utf8")).not.toContain(first!.idempotencyKey);
});

it("keeps an in-progress answer and refuses a second checkpoint for the same run meanwhile", async () => {
  const f = fixture();
  f.recover.mockResolvedValueOnce({ state: "in-progress", operationId: OPERATION, recovery: "inspect-or-retry" });
  expect((await f.controller().start("run-src", "cp-1")).state).toBe("pending");
  await expect(f.controller().start("run-src", "cp-2")).rejects.toThrow(/another checkpoint/);
  expect(f.recover).toHaveBeenCalledTimes(1);
});

it("ends the intent when the daemon refuses it, so the next start is new work", async () => {
  const f = fixture();
  f.recover.mockRejectedValueOnce(new Refusal("RECOVERY_BLOCKED"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("RECOVERY_BLOCKED");
  expect(await f.controller().list("run-src")).toEqual([]);
  f.recover.mockResolvedValueOnce(accepted("run-attempt"));
  await f.controller().start("run-src", "cp-1");
  const [first, second] = f.recover.mock.calls.map(([params]) => params);
  expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
});

it("finishes a reserved attempt only by reconciling its receipt, after navigation and restart", async () => {
  const f = fixture();
  f.recover.mockResolvedValueOnce(reserved);
  const outcome = await f.controller().start("run-src", "cp-1");
  expect(outcome).toMatchObject({ state: "reserved", intent: { reserved: true } });
  if (outcome.state !== "reserved") throw new Error("expected reserved");
  // Pressing Start again (or Finish) from a new process reconciles; nothing new is started.
  f.reconcile.mockRejectedValueOnce(new Refusal("NOT_SUPPORTED"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("NOT_SUPPORTED");
  // A refused reconcile keeps the reservation: only its outcome or an abandon ends it.
  expect((await f.controller().list("run-src"))[0]).toMatchObject({ reserved: true });
  f.reconcile.mockResolvedValueOnce(accepted("run-reserved"));
  expect(await f.controller().finish(outcome.intent.id)).toEqual({ state: "accepted", runId: "run-reserved" });
  expect(f.recover).toHaveBeenCalledTimes(1);
  expect(f.reconcile.mock.calls.map(([params]) => params.operationId)).toEqual([OPERATION, OPERATION]);
  expect(await f.controller().list("run-src")).toEqual([]);
});

it("settles a late answer against its own record but does not show it on a new connection", async () => {
  const f = fixture();
  let answer!: (result: RunsRecoverResult) => void;
  f.recover.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  const pending = f.controller().start("run-src", "cp-1");
  await vi.waitFor(() => expect(f.recover).toHaveBeenCalled());
  f.switchConnection();
  answer(accepted("run-attempt"));
  await expect(pending).rejects.toThrow(/connection changed/);
  f.useConnection(async () => f.connection({ assertCurrent: () => {} }));
  expect(await f.controller().list("run-src")).toEqual([]);
});

it("refuses an accepted receipt for another source run and keeps the intent", async () => {
  const f = fixture();
  f.recover.mockResolvedValueOnce(accepted("run-attempt", "run-other"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow(/does not match/);
  expect(await f.controller().list("run-src")).toHaveLength(1);
});

it("keeps an intent to its own connection and principal, and abandons only after confirmation", async () => {
  const f = fixture();
  f.recover.mockRejectedValueOnce(new Error("lost"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("lost");
  const [intent] = await f.controller().list("run-src");
  f.useConnection(async () => f.connection({ scope: { ...f.scope, principalId: "bob" } }));
  expect(await f.controller().list("run-src")).toEqual([]);
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow(/another connection or principal/);
  await expect(f.controller().abandon(intent!.id)).rejects.toThrow(/unavailable on this connection/);
  f.useConnection(async () => f.connection());
  f.confirm.mockResolvedValueOnce(false);
  expect(await f.controller().abandon(intent!.id)).toEqual({ abandoned: false });
  expect(await f.controller().list("run-src")).toHaveLength(1);
  expect(await f.controller().abandon(intent!.id)).toEqual({ abandoned: true });
  expect(await f.controller().list("run-src")).toEqual([]);
  expect(f.recover).toHaveBeenCalledTimes(1);
});
