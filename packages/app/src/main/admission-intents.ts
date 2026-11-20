/**
 * Main-process-only durable run intents, encrypted with OS safeStorage. A palette record holds
 * scope, workflow id and retry key; a guided record also holds its reviewed command, every input
 * var (sensitive ones too) and Request text included. No daemon credential is stored. Abandoned
 * records are dropped on write, so the journal holds only retained (unresolved) intents.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProtectedStorageReason } from "../bridge.js";
import type { LaunchReview, RetainedLaunch } from "../configuration-launch-contract.js";
import { canonicalGuidedValue, parseGuidedReview } from "./guided-intent-contract.js";

export interface IntentScope {
  target: string;
  principalId: string;
  workspaceId: string;
}
export interface IntentRecord extends IntentScope {
  id: string;
  workflowId: string;
  idempotencyKey: string;
  state: "retained" | "abandoned";
  /** Versioned protected submitted command. Palette v1 records deliberately omit it. */
  guided?: { version: 1; review: LaunchReview; operationId?: string; admissionId?: string };
}
/** Electron safeStorage is injected so tests do not require a desktop keychain. */
export interface IntentEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
function sameScope(a: IntentScope, b: IntentScope): boolean {
  return a.target === b.target && a.principalId === b.principalId && a.workspaceId === b.workspaceId;
}
/**
 * Why protected storage refused (#857). Electron cannot tell a cancelled unlock prompt from a
 * locked keyring, so both are `keyring-locked`: the Linux backend is a real keyring that did
 * not hand over ORCA's key. `no-keyring` is Linux's `basic_text`, which ORCA never uses.
 */
const STORAGE_REFUSED = "Secure run-intent storage is unavailable. No run was submitted";
const STORAGE_GUIDANCE: Record<ProtectedStorageReason, string> = {
  "keyring-locked": `${STORAGE_REFUSED}. The system keyring did not give ORCA its encryption key: the keyring is locked, or its unlock prompt was cancelled. Unlock your login keyring (accept the prompt when it appears), then retry. If the retry is refused again, quit and reopen ORCA so it can ask the keyring again.`,
  "no-keyring": `${STORAGE_REFUSED}. No supported system keyring (GNOME Keyring or KWallet) is available in this session, and ORCA does not store run intents in plain text. Start or unlock your desktop keyring, then quit and reopen ORCA and retry.`,
  unavailable: `${STORAGE_REFUSED}; restore the OS keychain before retrying.`,
};
/**
 * A fail-closed refusal of protected storage. The main process maps it to the `PROTECTED_STORAGE`
 * bridge code so the renderer can show the cause and a retry rather than a generic failure.
 * It is only ever raised before anything is sent; a refusal after a send is rethrown as a
 * plain error by the caller, because "no run was submitted" would then be untrue.
 */
export class ProtectedStorageRefusal extends Error {
  override readonly name = "ProtectedStorageRefusal";
  constructor(readonly reason: ProtectedStorageReason) {
    super(STORAGE_GUIDANCE[reason]);
  }
}
export function isProtectedStorageRefusal(error: unknown): error is ProtectedStorageRefusal {
  return error instanceof ProtectedStorageRefusal;
}
const KEYRING_BACKENDS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);
/** Thrown inside validation, where the catch replaces it with the "could not be verified" message. */
const invalid = () => new Error("Saved run intents are invalid.");
const receiptMismatch = () =>
  new Error(
    "The retained intent does not match this admission receipt. Recover the original intent; do not submit new work.",
  );
/** The most retained intents, and so the most rows any journal file holds: no write keeps an abandoned one. */
const RETAINED_LIMIT = 1000;
const full = () =>
  new Error(
    `Too many retained run intents (${RETAINED_LIMIT}). No run was submitted; recover or explicitly abandon earlier intents, on the connection that started each, before starting new work.`,
  );
export class AdmissionIntents {
  constructor(
    private readonly path: string,
    private readonly encryption: IntentEncryption,
  ) {}
  /** Never falls back: `basic_text` is refused even when Electron reports it as available. */
  private refusal(): ProtectedStorageRefusal {
    const backend = this.encryption.getSelectedStorageBackend?.();
    if (backend === "basic_text") return new ProtectedStorageRefusal("no-keyring");
    if (backend !== undefined && KEYRING_BACKENDS.has(backend)) return new ProtectedStorageRefusal("keyring-locked");
    return new ProtectedStorageRefusal("unavailable");
  }
  private check(): void {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === "basic_text")
      throw this.refusal();
  }
  private read(): IntentRecord[] {
    this.check();
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ProtectedStorageRefusal("unavailable");
    }
    try {
      const data: unknown = JSON.parse(this.encryption.decryptString(bytes));
      if (!Array.isArray(data) || data.length > RETAINED_LIMIT) throw invalid();
      const ids = new Set<string>();
      for (const row of data) {
        if (
          typeof row !== "object" ||
          row === null ||
          ![
            "id,idempotencyKey,principalId,state,target,workflowId,workspaceId",
            "guided,id,idempotencyKey,principalId,state,target,workflowId,workspaceId",
          ].includes(Object.keys(row).sort().join()) ||
          ![row.id, row.idempotencyKey, row.principalId, row.target, row.workflowId, row.workspaceId].every(
            (v) => typeof v === "string" && v.length > 0,
          ) ||
          !["retained", "abandoned"].includes(row.state) ||
          ids.has(row.id)
        )
          throw invalid();
        if (Object.hasOwn(row, "guided")) {
          const guided = row.guided as IntentRecord["guided"];
          if (
            !guided ||
            guided.version !== 1 ||
            Object.keys(guided).some((key) => !["version", "review", "operationId", "admissionId"].includes(key)) ||
            [guided.operationId, guided.admissionId].some(
              (id) => id !== undefined && (typeof id !== "string" || !id.length),
            )
          )
            throw invalid();
          const review = parseGuidedReview(guided.review);
          if (review.workflowId !== row.workflowId || review.target.workspaceId !== row.workspaceId) throw invalid();
        }
        ids.add(row.id);
      }
      return data as IntentRecord[];
    } catch {
      throw new Error(
        "Saved run intents could not be verified. No run was submitted; restore the intent journal and matching OS keychain.",
      );
    }
  }
  /** Compacts: an abandoned record is settled and nothing reads it again, so it is not kept.
   * Every retained record is kept, since retry, recovery and reconciliation need it. */
  private write(records: IntentRecord[]): void {
    this.check();
    const retained = records.filter((r) => r.state === "retained");
    let bytes: Buffer;
    try {
      bytes = this.encryption.encryptString(JSON.stringify(retained));
    } catch {
      throw this.refusal();
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
      // Windows does not permit opening directories with node:fs. File flush still precedes rename.
      if (process.platform !== "win32") {
        const dir = openSync(dirname(this.path), "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
    } catch {
      throw new ProtectedStorageRefusal("unavailable");
    }
  }
  /** Persist before the first network admission. Repeated clicks/restarts reuse exact intent. */
  retain(scope: IntentScope, workflowId: string): IntentRecord {
    if (
      ![scope.target, scope.principalId, scope.workspaceId, workflowId].every(
        (v) => typeof v === "string" && v.length > 0,
      )
    )
      throw new Error("Verified run-intent scope is unavailable. No run was submitted.");
    const records = this.read();
    const existing = records.find((r) => sameScope(r, scope) && r.workflowId === workflowId && r.state === "retained");
    if (existing?.guided)
      throw new Error("This workflow has a retained guided intent. Recover or explicitly abandon that command first.");
    if (existing) return { ...existing };
    // Never silently turn a known unresolved intent into new work after changing authority/target.
    if (records.some((r) => r.workflowId === workflowId && r.state === "retained"))
      throw new Error(
        "This workflow has a retained intent on another target or principal. Return to that connection to recover or explicitly abandon it.",
      );
    if (records.filter((r) => r.state === "retained").length >= RETAINED_LIMIT) throw full();
    const record: IntentRecord = {
      ...scope,
      workflowId,
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      state: "retained",
    };
    this.write([...records, record]);
    return { ...record };
  }
  list(scope: IntentScope): Pick<IntentRecord, "id" | "workflowId">[] {
    return this.read()
      .filter((r) => sameScope(r, scope) && r.state === "retained" && !r.guided)
      .map(({ id, workflowId }) => ({ id, workflowId }));
  }
  /** Read the existing protected journal through its normal validation/decryption path.
   * Main-only recovery comparison; no plaintext, key, write or new intent escapes. */
  continuityHash(): string {
    return createHash("sha256").update(JSON.stringify(this.read())).digest("hex");
  }
  retainGuided(scope: IntentScope, raw: LaunchReview): IntentRecord {
    const review = parseGuidedReview(raw);
    if (scope.workspaceId !== review.target.workspaceId || !scope.target || !scope.principalId)
      throw new Error("Verified run-intent scope is unavailable. No run was submitted.");
    const records = this.read();
    const held = records.find((r) => r.workflowId === review.workflowId && r.state === "retained");
    if (held) {
      if (!sameScope(held, scope))
        throw new Error("This workflow has a retained intent on another target or principal.");
      if (!held.guided || canonicalGuidedValue(held.guided.review) !== canonicalGuidedValue(review))
        throw new Error("The retained command changed. Recover or explicitly abandon it before new work.");
      return structuredClone(held);
    }
    if (records.filter((r) => r.state === "retained").length >= RETAINED_LIMIT) throw full();
    const record: IntentRecord = {
      ...scope,
      workflowId: review.workflowId,
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      state: "retained",
      guided: { version: 1, review },
    };
    this.write([...records, record]);
    return structuredClone(record);
  }
  guided(scope: IntentScope, id: string): IntentRecord {
    const record = this.read().find((r) => sameScope(r, scope) && r.id === id && r.state === "retained" && r.guided);
    if (!record) throw new Error("The retained guided intent is unavailable in this authenticated scope.");
    return structuredClone(record);
  }
  guidedList(scope: IntentScope): RetainedLaunch[] {
    return this.read()
      .filter((r) => sameScope(r, scope) && r.state === "retained" && r.guided)
      .map((r) => ({
        intentId: r.id,
        workflowId: r.workflowId,
        mode: r.guided!.review.command.mode,
        target: { ...r.guided!.review.target },
        ...(r.guided!.operationId ? { operationId: r.guided!.operationId } : {}),
        ...(r.guided!.admissionId ? { admissionId: r.guided!.admissionId } : {}),
      }));
  }
  recordGuidedReceipt(scope: IntentScope, id: string, ids: { operationId?: string; admissionId?: string }): void {
    const records = this.read();
    const record = records.find((r) => sameScope(r, scope) && r.id === id && r.state === "retained");
    if (!record?.guided) throw receiptMismatch();
    for (const key of ["operationId", "admissionId"] as const) {
      const value = ids[key];
      if (value === undefined) continue;
      if (!value || (record.guided[key] && record.guided[key] !== value)) throw receiptMismatch();
      record.guided[key] = value;
    }
    this.write(records);
  }
  /** Only after explicit confirmation. Does not cancel or delete the server operation. */
  abandon(scope: IntentScope, id: string): void {
    const records = this.read();
    const record = records.find((r) => r.id === id && sameScope(r, scope));
    if (!record || record.state !== "retained")
      throw new Error("The retained intent changed. Refresh before abandoning it.");
    record.state = "abandoned";
    this.write(records);
  }
}

export interface IntentConnection {
  scope: IntentScope;
  /** The captured connection, never a lookup of whichever client is current later. */
  assertCurrent(): void;
  admit(params: {
    workflowId: string;
    idempotencyKey: string;
    expectedScope: { principalId: string; workspaceId: string };
  }): Promise<{
    state: "prepared" | "accepted" | "recoverable-failure";
    operationId: string;
    admissionId: string;
    runId?: string | undefined;
  }>;
}
export class AdmissionIntentController {
  private generation = 0;
  constructor(
    private readonly journal: AdmissionIntents,
    private readonly connect: () => Promise<IntentConnection>,
  ) {}
  async start(workflowId: string): Promise<{ runId: string }> {
    const generation = this.generation;
    const connection = await this.connect();
    connection.assertCurrent();
    if (generation !== this.generation)
      throw new Error("Run intent changed while connecting. Choose Start again for new work.");
    const intent = this.journal.retain(connection.scope, workflowId);
    connection.assertCurrent();
    const result = await connection.admit({
      workflowId: intent.workflowId,
      idempotencyKey: intent.idempotencyKey,
      expectedScope: { principalId: intent.principalId, workspaceId: intent.workspaceId },
    });
    connection.assertCurrent();
    if (generation !== this.generation)
      throw new Error("Run intent changed while admission was pending. Inspect the original run separately.");
    if (result.state !== "accepted" || !result.runId)
      throw new Error(
        "Run admission is unresolved. Retry the retained intent, or explicitly abandon it before starting new work.",
      );
    // Do not clear on response: renderer/process loss here must still recover the same intent.
    return { runId: result.runId };
  }
  async list(): Promise<Pick<IntentRecord, "id" | "workflowId">[]> {
    const connection = await this.connect();
    connection.assertCurrent();
    return this.journal.list(connection.scope);
  }
  async abandon(id: string, confirm: () => Promise<boolean>): Promise<{ abandoned: boolean }> {
    const connection = await this.connect();
    connection.assertCurrent();
    if (!this.journal.list(connection.scope).some((r) => r.id === id))
      throw new Error("The retained intent is unavailable in this connection.");
    if (!(await confirm())) return { abandoned: false };
    connection.assertCurrent();
    const current = await this.connect();
    connection.assertCurrent();
    current.assertCurrent();
    if (!sameScope(connection.scope, current.scope))
      throw new Error("The authenticated scope changed. Refresh before abandoning this intent.");
    this.journal.abandon(connection.scope, id);
    this.generation += 1;
    return { abandoned: true };
  }
}
