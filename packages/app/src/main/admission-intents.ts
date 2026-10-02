/** Main-process-only durable palette intents. Never stores credentials or arbitrary vars. */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
const refusal = () =>
  new Error("Secure run-intent storage is unavailable. No run was submitted; restore the OS keychain before retrying.");
export class AdmissionIntents {
  constructor(
    private readonly path: string,
    private readonly encryption: IntentEncryption,
  ) {}
  private check(): void {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === "basic_text")
      throw refusal();
  }
  private read(): IntentRecord[] {
    this.check();
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw refusal();
    }
    try {
      const data: unknown = JSON.parse(this.encryption.decryptString(bytes));
      if (!Array.isArray(data) || data.length > 1000) throw refusal();
      const ids = new Set<string>();
      for (const row of data) {
        if (
          typeof row !== "object" ||
          row === null ||
          Object.keys(row).sort().join() !== "id,idempotencyKey,principalId,state,target,workflowId,workspaceId" ||
          ![row.id, row.idempotencyKey, row.principalId, row.target, row.workflowId, row.workspaceId].every(
            (v) => typeof v === "string" && v.length > 0,
          ) ||
          !["retained", "abandoned"].includes(row.state) ||
          ids.has(row.id)
        )
          throw refusal();
        ids.add(row.id);
      }
      return data as IntentRecord[];
    } catch {
      throw new Error(
        "Saved run intents could not be verified. No run was submitted; restore the intent journal and matching OS keychain.",
      );
    }
  }
  private write(records: IntentRecord[]): void {
    this.check();
    try {
      const bytes = this.encryption.encryptString(JSON.stringify(records));
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
      throw refusal();
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
    if (existing) return { ...existing };
    // Never silently turn a known unresolved intent into new work after changing authority/target.
    if (records.some((r) => r.workflowId === workflowId && r.state === "retained"))
      throw new Error(
        "This workflow has a retained intent on another target or principal. Return to that connection to recover or explicitly abandon it.",
      );
    if (records.length >= 1000) throw new Error("Run-intent journal is full. No run was submitted.");
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
      .filter((r) => sameScope(r, scope) && r.state === "retained")
      .map(({ id, workflowId }) => ({ id, workflowId }));
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
