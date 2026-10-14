import { afterEach, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdmissionIntents,
  AdmissionIntentController,
  type IntentEncryption,
  type IntentRecord,
  type IntentScope,
} from "../src/main/admission-intents.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orca-intent-"));
  dirs.push(dir);
  const path = join(dir, "intent.enc");
  const key = randomBytes(32);
  const encryption: IntentEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
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
  return { path, encryption, scope, journal: new AdmissionIntents(path, encryption) };
}
it("retains the same protected intent across renderer and process reconstruction and credential rotation", () => {
  const f = fixture();
  const first = f.journal.retain(f.scope, "workflow-private");
  expect(new AdmissionIntents(f.path, f.encryption).retain(f.scope, "workflow-private")).toEqual(first);
  expect(f.journal.retain({ ...f.scope }, "workflow-private")).toEqual(first); // no credential or daemon-instance component
  const bytes = readFileSync(f.path).toString("utf8");
  for (const secret of [first.idempotencyKey, first.workflowId, first.principalId, first.workspaceId, first.target])
    expect(bytes).not.toContain(secret);
});
it("refuses implicit new work under changed principal, workspace or endpoint", () => {
  const f = fixture();
  f.journal.retain(f.scope, "workflow");
  for (const scope of [
    { ...f.scope, principalId: "bob" },
    { ...f.scope, workspaceId: "other" },
    { ...f.scope, target: "https://other.example" },
  ]) {
    expect(() => f.journal.retain(scope, "workflow")).toThrow("another target or principal");
    expect(f.journal.list(scope)).toEqual([]);
    expect(() => f.journal.abandon(scope, f.journal.list(f.scope)[0]!.id)).toThrow("changed");
  }
});
it("never replaces a corrupt or undecryptable journal with an empty namespace", () => {
  const f = fixture();
  f.journal.retain(f.scope, "workflow");
  writeFileSync(f.path, "corrupt");
  expect(() => f.journal.retain(f.scope, "workflow")).toThrow("could not be verified");
  expect(readFileSync(f.path, "utf8")).toBe("corrupt");
});
it.each(["unavailable", "basic_text"])(
  "blocks admission when secure storage is %s, without plaintext fallback",
  async (backend) => {
    const f = fixture();
    f.encryption.isEncryptionAvailable = () => backend !== "unavailable";
    f.encryption.getSelectedStorageBackend = () => backend;
    const admit = vi.fn();
    const controller = new AdmissionIntentController(f.journal, async () => ({
      scope: f.scope,
      assertCurrent() {},
      admit,
    }));
    await expect(controller.start("workflow")).rejects.toThrow("Secure run-intent storage is unavailable");
    expect(admit).not.toHaveBeenCalled();
  },
);
it("lost acknowledgement, concurrent clicks and a reconstructed controller reuse exactly one admission", async () => {
  const f = fixture(),
    ids = new Set<string>();
  let lose = true;
  const admit = vi.fn(async (params: { idempotencyKey: string }) => {
    ids.add(params.idempotencyKey);
    if (lose) {
      lose = false;
      throw new Error("lost acknowledgement");
    }
    return { state: "accepted" as const, operationId: "operation", admissionId: "admission", runId: "run" };
  });
  const connect = async () => ({ scope: f.scope, assertCurrent() {}, admit });
  await expect(new AdmissionIntentController(f.journal, connect).start("workflow")).rejects.toThrow(
    "lost acknowledgement",
  );
  const reopened = new AdmissionIntentController(new AdmissionIntents(f.path, f.encryption), connect);
  expect(await Promise.all([reopened.start("workflow"), reopened.start("workflow")])).toEqual([
    { runId: "run" },
    { runId: "run" },
  ]);
  expect(ids.size).toBe(1);
  expect(admit.mock.calls[1]?.[0]).toMatchObject({ expectedScope: { principalId: "alice", workspaceId: "workspace" } });
});
it("cancel keeps the original intent; explicit abandon is durable and enables intentional new work", async () => {
  const f = fixture(),
    admit = vi.fn(async () => ({
      state: "accepted" as const,
      operationId: "operation",
      admissionId: "admission",
      runId: "run",
    }));
  const c = new AdmissionIntentController(f.journal, async () => ({ scope: f.scope, assertCurrent() {}, admit }));
  const first = f.journal.retain(f.scope, "workflow");
  expect(await c.abandon(first.id, async () => false)).toEqual({ abandoned: false });
  expect(f.journal.retain(f.scope, "workflow").idempotencyKey).toBe(first.idempotencyKey);
  await c.abandon(first.id, async () => true);
  expect(new AdmissionIntents(f.path, f.encryption).retain(f.scope, "workflow").idempotencyKey).not.toBe(
    first.idempotencyKey,
  );
  expect(admit).not.toHaveBeenCalled();
});
it("fences stale connection before admission and after confirmation", async () => {
  const f = fixture(),
    admit = vi.fn();
  let stale = false;
  const c = new AdmissionIntentController(f.journal, async () => ({
    scope: f.scope,
    assertCurrent() {
      if (stale) throw new Error("stale target");
    },
    admit,
  }));
  const intent = f.journal.retain(f.scope, "workflow");
  await expect(
    c.abandon(intent.id, async () => {
      stale = true;
      return true;
    }),
  ).rejects.toThrow("stale target");
  await expect(c.start("workflow")).rejects.toThrow("stale target");
  expect(f.journal.retain(f.scope, "workflow")).toEqual(intent);
  expect(admit).not.toHaveBeenCalled();
});
it("current expired/revoked authority blocks before a durable intent or admission is created", async () => {
  const f = fixture();
  const c = new AdmissionIntentController(f.journal, async () => {
    throw new Error("AUTH_INVALID");
  });
  await expect(c.start("workflow")).rejects.toThrow("AUTH_INVALID");
  expect(f.journal.list(f.scope)).toEqual([]);
});
it("does not turn an earlier retry delayed in discovery into new work after abandon", async () => {
  const f = fixture();
  const intent = f.journal.retain(f.scope, "workflow");
  const admit = vi.fn(async () => ({
    state: "accepted" as const,
    operationId: "operation",
    admissionId: "admission",
    runId: "run",
  }));
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const c = new AdmissionIntentController(f.journal, async () => {
    if (first) {
      first = false;
      await delayed;
    }
    return { scope: f.scope, assertCurrent() {}, admit };
  });
  const pending = c.start("workflow");
  await c.abandon(intent.id, async () => true);
  release();
  await expect(pending).rejects.toThrow("Run intent changed");
  expect(admit).not.toHaveBeenCalled();
  expect(f.journal.list(f.scope)).toEqual([]);
  await c.start("workflow");
  expect(admit).toHaveBeenCalledOnce();
});
it("rechecks current principal after abandon confirmation and permits same-principal credential rotation", async () => {
  const f = fixture();
  const intent = f.journal.retain(f.scope, "workflow");
  let scope = f.scope,
    revoked = false;
  const c = new AdmissionIntentController(f.journal, async () => {
    if (revoked) throw new Error("AUTH_INVALID");
    return { scope, assertCurrent() {}, admit: vi.fn() };
  });
  await expect(
    c.abandon(intent.id, async () => {
      scope = { ...scope, principalId: "bob" };
      return true;
    }),
  ).rejects.toThrow("scope changed");
  scope = f.scope;
  await expect(
    c.abandon(intent.id, async () => {
      revoked = true;
      return true;
    }),
  ).rejects.toThrow("AUTH_INVALID");
  revoked = false;
  expect(f.journal.list(f.scope)).toHaveLength(1);
  await expect(
    c.abandon(intent.id, async () => {
      scope = { ...f.scope };
      return true;
    }),
  ).resolves.toEqual({ abandoned: true });
});
/** Decrypt the journal as stored, to see which records a write kept. */
function stored(f: ReturnType<typeof fixture>): IntentRecord[] {
  return JSON.parse(f.encryption.decryptString(readFileSync(f.path))) as IntentRecord[];
}
/** Write a journal directly, abandoned records included, as an earlier version could leave it. */
function seed(f: ReturnType<typeof fixture>, records: IntentRecord[]): void {
  writeFileSync(f.path, f.encryption.encryptString(JSON.stringify(records)), { mode: 0o600 });
}
function record(f: ReturnType<typeof fixture>, i: number, state: IntentRecord["state"]): IntentRecord {
  return { ...f.scope, workflowId: `workflow-${i}`, id: randomUUID(), idempotencyKey: randomUUID(), state };
}
it("keeps starting runs past 1000 start/abandon cycles across workspaces, holding only live intents", async () => {
  const f = fixture();
  const scopes = [f.scope, { ...f.scope, workspaceId: "other" }, { ...f.scope, target: "https://other.example" }];
  let scope = f.scope;
  const keys = new Set<string>();
  const admit = vi.fn(async (params: { idempotencyKey: string }) => {
    keys.add(params.idempotencyKey);
    return { state: "accepted" as const, operationId: "operation", admissionId: "admission", runId: "run" };
  });
  const c = new AdmissionIntentController(f.journal, async () => ({ scope, assertCurrent() {}, admit }));
  for (let i = 0; i < 1100; i++) {
    scope = scopes[i % scopes.length]!;
    await expect(c.start(`workflow-${i % 7}`)).resolves.toEqual({ runId: "run" });
    const [intent] = f.journal.list(scope);
    await expect(c.abandon(intent!.id, async () => true)).resolves.toEqual({ abandoned: true });
  }
  expect(admit).toHaveBeenCalledTimes(1100);
  expect(keys.size).toBe(1100);
  expect(stored(f)).toEqual([]);
  // The compacted journal is still the encrypted one, and survives a restart.
  scope = f.scope;
  await c.start("workflow");
  const live = f.journal.retain(f.scope, "workflow");
  expect(stored(f)).toEqual([live]);
  expect(new AdmissionIntents(f.path, f.encryption).retain(f.scope, "workflow")).toEqual(live);
  for (const plain of [live.idempotencyKey, live.workflowId, live.principalId]) {
    expect(readFileSync(f.path).toString("utf8")).not.toContain(plain);
  }
});
it("compacts a journal an earlier version filled with abandoned records, keeping every unresolved one", () => {
  const f = fixture();
  const unresolved = [record(f, 0, "retained"), record(f, 500, "retained"), record(f, 999, "retained")];
  seed(
    f,
    Array.from(
      { length: 1000 },
      (_, i) => unresolved.find((r) => r.workflowId === `workflow-${i}`) ?? record(f, i, "abandoned"),
    ),
  );
  const fresh = f.journal.retain(f.scope, "new-workflow");
  expect(stored(f)).toEqual([...unresolved, fresh]);
  // Each unresolved intent still retries with its original key, from a reopened journal too.
  const reopened = new AdmissionIntents(f.path, f.encryption);
  for (const r of unresolved) expect(reopened.retain(f.scope, r.workflowId)).toEqual(r);
  expect(reopened.list(f.scope).map((r) => r.id)).toEqual([...unresolved, fresh].map((r) => r.id));
});
it("never prunes unresolved intents: at the live cap it refuses new work and says why", () => {
  const f = fixture();
  const live = Array.from({ length: 1000 }, (_, i) => record(f, i, "retained"));
  seed(f, live);
  const before = readFileSync(f.path);
  let message = "";
  try {
    f.journal.retain(f.scope, "one-too-many");
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/Too many retained run intents \(1000\)/);
  expect(message).toMatch(/No run was submitted/);
  expect(message).not.toMatch(/keychain/i);
  expect(readFileSync(f.path).equals(before)).toBe(true);
  // An unresolved intent is still reachable for retry at the cap.
  expect(f.journal.retain(f.scope, "workflow-7")).toEqual(live[7]);
  // Abandoning one frees exactly one place; the other 999 keep their keys.
  f.journal.abandon(f.scope, live[3]!.id);
  const fresh = f.journal.retain(f.scope, "one-too-many");
  expect(stored(f)).toEqual([...live.filter((_, i) => i !== 3), fresh]);
  expect(() => f.journal.retain(f.scope, "and-another")).toThrow("Too many retained run intents");
});
it.each(["prepared", "recoverable-failure"] as const)(
  "retains unresolved %s through restart and retries the same key",
  async (state) => {
    const f = fixture();
    const keys: string[] = [];
    const connect = async () => ({
      scope: f.scope,
      assertCurrent() {},
      admit: async (params: { idempotencyKey: string }) => {
        keys.push(params.idempotencyKey);
        return { state, operationId: "operation", admissionId: "admission" };
      },
    });
    for (let i = 0; i < 2; i++) {
      const c = new AdmissionIntentController(new AdmissionIntents(f.path, f.encryption), connect);
      await expect(c.start("workflow")).rejects.toThrow("unresolved");
    }
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(f.journal.list(f.scope)).toHaveLength(1);
  },
);
