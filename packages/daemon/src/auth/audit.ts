/**
 * The security audit trail: who did what to which thing, when, and how it ended.
 *
 * A record holds identifiers and outcomes, never payloads. Params are reduced to the ids in
 * `TARGET_KEYS` - a run, a workflow, a gate - so vars, notes, free-text answers, configuration
 * text and every credential stay out of it by construction rather than by redaction. A token
 * cannot appear because nothing that writes here is ever handed one: the transport passes the
 * credential *id*, which is public.
 *
 * Mutations and decisions are recorded with their outcome either way; every denial is
 * recorded, with an internal `reason` (an expired credential, an unknown method, a run outside
 * scope) that the caller was never told. The log is JSON lines, appended, owner-readable only.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { chmodSync, closeSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Principal } from "./principal.js";

export type AuditEvent = "authn.denied" | "authz.denied" | "operation" | "connection.closed";

export interface AuditActor {
  principal: string;
  kind: Principal["kind"];
  credential?: string | undefined;
}

export interface AuditRecord {
  at: string;
  event: AuditEvent;
  transport: "http" | "socket";
  actor?: AuditActor | undefined;
  operation?: string | undefined;
  target?: Record<string, string> | undefined;
  outcome: "succeeded" | "failed" | "denied";
  /** The wire error code for a failure or a denial. */
  code?: string | undefined;
  /** Why, in the daemon's own words - never sent to the caller. */
  reason?: string | undefined;
  /** The peer, or the client address a trusted proxy forwarded. */
  remote?: string | undefined;
}

export interface AuditSink {
  record(entry: AuditRecord): void;
}

/** The params worth naming in a record. Everything else in a call is payload. */
const TARGET_KEYS = [
  "runId",
  "workflowId",
  "id",
  "version",
  "requestId",
  "workItemId",
  "artifactId",
  "planId",
  "dependencyId",
  "decisionId",
  "riskId",
  "document",
  "agentId",
  "subscriptionId",
  "action",
] as const;

export function targetOf(
  params: unknown,
  extra?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (params && typeof params === "object") {
    for (const key of TARGET_KEYS) {
      const value = (params as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number") out[key] = String(value).slice(0, 200);
    }
    // A standing-permission answer is recorded as such: which decision, never the answer text.
    const always = (params as { always?: { decision?: unknown } }).always;
    if (always && typeof always.decision === "string") out.always = always.decision;
  }
  for (const [key, value] of Object.entries(extra ?? {})) if (value !== undefined) out[key] = value.slice(0, 200);
  return Object.keys(out).length ? out : undefined;
}

export function actorOf(principal: Principal): AuditActor {
  return {
    principal: principal.id,
    kind: principal.kind,
    ...(principal.credentialId ? { credential: principal.credentialId } : {}),
  };
}

/** Collects records in memory. For tests, and for an embedder that ships them elsewhere. */
export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  record(entry: AuditRecord): void {
    this.records.push(entry);
  }
}

/**
 * Appends to a JSON-lines file. The file is created owner-only up front, so a daemon that
 * cannot write its audit log fails at startup rather than discovering it on the first denial.
 * Appends after that are queued in order; a failed append is reported to `onError` and the
 * next one is still attempted.
 */
export class FileAuditSink implements AuditSink {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onError: (e: unknown) => void = (e) =>
      process.stderr.write(`orca: audit log write failed: ${(e as Error).message}\n`),
  ) {
    // Synchronous so the failure is the constructor's: see the class comment.
    const fd = openSync(file, "a", 0o600);
    closeSync(fd);
    chmodSync(file, 0o600);
  }

  record(entry: AuditRecord): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue
      .then(() => appendFile(this.file, line, { mode: 0o600 }))
      .catch((e: unknown) => this.onError(e));
  }

  /** Resolves once every queued record has been appended. */
  flush(): Promise<void> {
    return this.queue;
  }

  static async open(file: string): Promise<FileAuditSink> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    return new FileAuditSink(file);
  }
}
