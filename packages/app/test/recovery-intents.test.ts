/**
 * Main-process checkpoint-attempt intents (#357): the key, a reserved receipt and the accepted
 * attempt survive the renderer and the process; every error keeps the key; a reserved attempt is
 * only ever reconciled; an answer that arrives after the connection changed is recorded but not
 * shown; and calls for one run, a dismissal's dialog included, never overlap.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunsRecoverResult } from "@orca/protocol";
import type { IntentEncryption, IntentScope } from "../src/main/admission-intents.js";
import {
  RecoveryIntentController,
  RecoveryIntents,
  recoveryTarget,
  type RecoveryConnection,
} from "../src/main/recovery-intents.js";

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
    ...over,
  });
  let connect = async () => connection();
  const confirm = vi.fn(async (_state: "retained" | "resolved") => true);
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

it("keeps the key through a lost reply and a verification error, across a new process", async () => {
  const f = fixture();
  f.recover.mockRejectedValueOnce(new Error("socket hang up"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("socket hang up");
  // The daemon's answer to the retry is an error: it says nothing about the lost request.
  f.recover.mockRejectedValueOnce(new Refusal("RUN_STATE: ownership unavailable"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("RUN_STATE");
  // A new process (new journal and controller over the same file) still holds the intent.
  expect(await f.controller().list("run-src")).toEqual([
    { id: expect.any(String), sourceRunId: "run-src", checkpoint: "cp-1", reserved: false },
  ]);
  f.recover.mockResolvedValueOnce(accepted("run-attempt"));
  expect(await f.controller().start("run-src", "cp-1")).toMatchObject({ state: "accepted", runId: "run-attempt" });
  const keys = f.recover.mock.calls.map(([params]) => params.idempotencyKey);
  expect(new Set(keys).size).toBe(1);
  expect(f.recover.mock.calls[0]![0]).toMatchObject({
    runId: "run-src",
    checkpoint: "cp-1",
    expectedScope: { principalId: "alice" },
  });
  // The key is never written in plain text.
  expect(readFileSync(f.path).toString("utf8")).not.toContain(keys[0]!);
});

it("keeps an in-progress answer and refuses a second checkpoint for the same run meanwhile", async () => {
  const f = fixture();
  f.recover.mockResolvedValueOnce({ state: "in-progress", operationId: OPERATION, recovery: "inspect-or-retry" });
  expect((await f.controller().start("run-src", "cp-1")).state).toBe("pending");
  await expect(f.controller().start("run-src", "cp-2")).rejects.toThrow(/another checkpoint/);
  expect(f.recover).toHaveBeenCalledTimes(1);
});

it("records the accepted attempt before answering, so a reload finds it and Start does not ask again", async () => {
  const f = fixture();
  f.recover.mockResolvedValueOnce(accepted("run-attempt"));
  await f.controller().start("run-src", "cp-1");
  // Reloaded: the intent is resolved, with its attempt.
  const [resolved] = await f.controller().list("run-src");
  expect(resolved).toMatchObject({ checkpoint: "cp-1", reserved: false, attemptRunId: "run-attempt" });
  expect(await f.controller().start("run-src", "cp-1")).toMatchObject({ state: "accepted", runId: "run-attempt" });
  await expect(f.controller().start("run-src", "cp-2")).rejects.toThrow(/Dismiss it to start a separate attempt/);
  expect(f.recover).toHaveBeenCalledTimes(1);

  // A separate attempt is a deliberate dismissal, then a new intent with a new key.
  expect(await f.controller().dismiss(resolved!.id)).toEqual({ abandoned: true });
  expect(f.confirm).toHaveBeenLastCalledWith("resolved");
  f.recover.mockResolvedValueOnce(accepted("run-second"));
  await f.controller().start("run-src", "cp-1");
  const [first, second] = f.recover.mock.calls.map(([params]) => params.idempotencyKey);
  expect(second).not.toBe(first);
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
  expect((await f.controller().list("run-src"))[0]).toMatchObject({ reserved: true });
  f.reconcile.mockResolvedValueOnce(accepted("run-reserved"));
  expect(await f.controller().finish(outcome.intent.id)).toMatchObject({ state: "accepted", runId: "run-reserved" });
  expect(f.recover).toHaveBeenCalledTimes(1);
  expect(f.reconcile.mock.calls.map(([params]) => params.operationId)).toEqual([OPERATION, OPERATION]);
  expect((await f.controller().list("run-src"))[0]).toMatchObject({ attemptRunId: "run-reserved" });
});

it("records a late acceptance against its intent but does not show it on a new connection", async () => {
  const f = fixture();
  let answer!: (result: RunsRecoverResult) => void;
  f.recover.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  const pending = f.controller().start("run-src", "cp-1");
  await vi.waitFor(() => expect(f.recover).toHaveBeenCalled());
  f.switchConnection();
  answer(accepted("run-attempt"));
  await expect(pending).rejects.toThrow(/connection changed/);
  f.useConnection(async () => f.connection({ assertCurrent: () => {} }));
  expect((await f.controller().list("run-src"))[0]).toMatchObject({ attemptRunId: "run-attempt" });
});

it("refuses an accepted receipt for another source run and keeps the intent unresolved", async () => {
  const f = fixture();
  f.recover.mockResolvedValueOnce(accepted("run-attempt", "run-other"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow(/does not match/);
  expect((await f.controller().list("run-src"))[0]).not.toHaveProperty("attemptRunId");
});

it("never dismisses an intent while a call for its run is in flight, nor starts one during the dialog", async () => {
  const f = fixture();
  const controller = f.controller();
  f.recover.mockRejectedValueOnce(new Error("lost"));
  await expect(controller.start("run-src", "cp-1")).rejects.toThrow("lost");
  const [intent] = await controller.list("run-src");

  // A start is out: dismissing (from another window) is refused, so no second key can follow.
  let answer!: (result: RunsRecoverResult) => void;
  f.recover.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  const out = controller.start("run-src", "cp-1");
  await vi.waitFor(() => expect(f.recover).toHaveBeenCalledTimes(2));
  await expect(controller.dismiss(intent!.id)).rejects.toThrow(/still in progress/);
  answer({ state: "in-progress", operationId: OPERATION, recovery: "inspect-or-retry" });
  await out;

  // A dismissal's dialog is open: a start for that run is refused until it closes.
  let decide!: (yes: boolean) => void;
  f.confirm.mockImplementationOnce(() => new Promise((resolve) => (decide = resolve)));
  const dismissing = controller.dismiss(intent!.id);
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled());
  await expect(controller.start("run-src", "cp-1")).rejects.toThrow(/still in progress/);
  decide(true);
  expect(await dismissing).toEqual({ abandoned: true });
  expect(f.confirm).toHaveBeenLastCalledWith("retained");
  expect(await controller.list("run-src")).toEqual([]);
});

it("keeps an intent to its own connection and principal, and dismisses only after confirmation", async () => {
  const f = fixture();
  f.recover.mockRejectedValueOnce(new Error("lost"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("lost");
  const [intent] = await f.controller().list("run-src");
  f.useConnection(async () => f.connection({ scope: { ...f.scope, principalId: "bob" } }));
  expect(await f.controller().list("run-src")).toEqual([]);
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow(/another connection or principal/);
  await expect(f.controller().dismiss(intent!.id)).rejects.toThrow(/unavailable on this connection/);
  f.useConnection(async () => f.connection());
  f.confirm.mockResolvedValueOnce(false);
  expect(await f.controller().dismiss(intent!.id)).toEqual({ abandoned: false });
  expect(await f.controller().list("run-src")).toHaveLength(1);
  expect(await f.controller().dismiss(intent!.id)).toEqual({ abandoned: true });
  expect(await f.controller().list("run-src")).toEqual([]);
  expect(f.recover).toHaveBeenCalledTimes(1);
});

it("finds an SSH profile's intent after a tunnel reconnect, and not on another verified server", async () => {
  const f = fixture();
  const profile = { id: "prof-1", name: "lab", destination: "orca@build-host" };
  const server = JSON.stringify(["orca@build-host", 22, null, null]);
  const endpoint = { id: "prof-1", server, remotePort: 6722, hostKey: "SHA256:aaaa" };
  const via = (port: number, over: Partial<typeof endpoint> = {}) => ({
    ...f.scope,
    target: recoveryTarget({ source: "saved", url: `http://127.0.0.1:${port}`, profile }, "/unused", {
      ...endpoint,
      ...over,
    }),
  });
  f.useConnection(async () => f.connection({ scope: via(40001) }));
  f.recover.mockRejectedValueOnce(new Error("tunnel closed"));
  await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow("tunnel closed");

  // Reconnected through a new tunnel to the same verified server: the same intent and key.
  f.useConnection(async () => f.connection({ scope: via(40517) }));
  expect(await f.controller().list("run-src")).toHaveLength(1);
  f.recover.mockResolvedValueOnce(accepted("run-attempt"));
  await f.controller().start("run-src", "cp-1");
  const [first, second] = f.recover.mock.calls.map(([params]) => params.idempotencyKey);
  expect(second).toBe(first);

  // Another effective endpoint (SSH port, jump host, daemon port) or another host key is not it.
  for (const changed of [
    { server: JSON.stringify(["orca@build-host", 2222, null, null]) },
    { server: JSON.stringify(["orca@build-host", 22, "jump@bastion", 22]) },
    { remotePort: 6723 },
    { hostKey: "SHA256:bbbb" },
  ]) {
    f.useConnection(async () => f.connection({ scope: via(40517, changed) }));
    expect(await f.controller().list("run-src")).toEqual([]);
    await expect(f.controller().start("run-src", "cp-1")).rejects.toThrow(/another connection or principal/);
  }
  // A profile connection that has not verified its server has no scope at all.
  expect(() =>
    recoveryTarget({ source: "saved", url: "http://127.0.0.1:40001", profile }, "/unused", undefined),
  ).toThrow(/not verified its server/);
  // A plain URL target is still its endpoint, and a bundled daemon its store path.
  expect(recoveryTarget({ source: "saved", url: "http://10.0.0.5:6722/" }, "/x", undefined)).toBe(
    recoveryTarget({ source: "saved", url: "http://10.0.0.5:6722" }, "/x", undefined),
  );
  expect(recoveryTarget({ source: "bundled", url: "http://127.0.0.1:6722" }, "/work/orca", undefined)).toBe(
    "bundled:/work/orca",
  );
});
