/**
 * Identifier helpers.
 *
 * ORCA identifiers are opaque strings with a readable prefix so that a log line
 * or a JSON dump can be understood at a glance (e.g. `run_01J...`, `art_01J...`).
 * They are ULID-like: time-ordered and random, without an external dependency.
 */
import { createHash, randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function encodeTime(ms: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ENCODING[(bytes[i] ?? 0) % 32];
  return out;
}

/** Time-ordered unique id. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

export type IdPrefix =
  | "req" // Request
  | "wi" // WorkItem
  | "wf" // WorkflowDefinition
  | "run" // Run
  | "step" // StepRun
  | "art" // Artifact
  | "evt" // Event
  | "sess" // AgentSession
  | "orc" // Orchestrator instance; the holder of a run lease
  | "tpl" // PromptTemplate
  | "host" // AgentHost
  | "hi" // HumanInput request
  | "plan" // Plan
  | "dep" // Dependency
  | "risk" // Risk
  | "dec" // Decision
  | "pev"; // Plan journal event

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

/**
 * Deterministic id for a record that is unique by key within a scope (a risk's
 * key within a plan, say). The same parts always yield the same id, so two
 * concurrent creators converge on one record instead of writing two.
 */
export function keyedId(prefix: IdPrefix, ...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  let out = "";
  for (let i = 0; i < 26; i++) out += ENCODING[(digest[i] ?? 0) % 32];
  return `${prefix}_${out}`;
}

export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`);
}
