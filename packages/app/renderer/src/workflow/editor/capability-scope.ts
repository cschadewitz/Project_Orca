/**
 * A workflow's or node's capability scope (#335) as the editor edits it: which catalog MCP
 * servers and skills to turn on, turn off, or use exclusively. Plain data; the daemon checks
 * ids against the catalog and the agent's permitted set when it validates the draft.
 */
import type { DraftCapabilityScope } from "@orca/protocol";

export const SCOPE_KINDS = ["mcpServers", "skills"] as const;
export const SCOPE_OPS = ["enable", "disable", "replace"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export type ScopeOp = (typeof SCOPE_OPS)[number];
export type Scope = { [K in ScopeKind]?: { [O in ScopeOp]?: string[] } };

/** The core catalog id rule, as fixed code. */
export const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The scope a document holds, or `undefined` when it holds something the editor cannot show
 * faithfully (an unknown key, a non-list, a non-id); the inspector then edits it as YAML.
 * An absent scope is an empty one.
 */
export function readScope(value: unknown): Scope | undefined {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return undefined;
  const scope: Scope = {};
  for (const [kind, selection] of Object.entries(value)) {
    if (!(SCOPE_KINDS as readonly string[]).includes(kind) || !isRecord(selection)) return undefined;
    const out: { [O in ScopeOp]?: string[] } = {};
    for (const [op, ids] of Object.entries(selection)) {
      if (!(SCOPE_OPS as readonly string[]).includes(op) || !Array.isArray(ids)) return undefined;
      if (!ids.every((id) => typeof id === "string" && CAPABILITY_ID.test(id))) return undefined;
      out[op as ScopeOp] = [...(ids as string[])];
    }
    scope[kind as ScopeKind] = out;
  }
  return scope;
}

/** Empty lists and kinds dropped; `undefined` when nothing is left, so the key is removed. */
export function normalizeScope(scope: Scope): DraftCapabilityScope | undefined {
  const out: DraftCapabilityScope = {};
  for (const kind of SCOPE_KINDS) {
    const selection: { [O in ScopeOp]?: string[] } = {};
    for (const op of SCOPE_OPS) {
      const ids = scope[kind]?.[op];
      if (ids && ids.length) selection[op] = ids;
    }
    if (Object.keys(selection).length) out[kind] = selection;
  }
  return Object.keys(out).length ? out : undefined;
}

export function addToScope(scope: Scope, kind: ScopeKind, op: ScopeOp, id: string): Scope {
  const ids = scope[kind]?.[op] ?? [];
  if (ids.includes(id) || !CAPABILITY_ID.test(id)) return scope;
  return { ...scope, [kind]: { ...scope[kind], [op]: [...ids, id] } };
}

export function removeFromScope(scope: Scope, kind: ScopeKind, op: ScopeOp, id: string): Scope {
  const ids = scope[kind]?.[op] ?? [];
  return { ...scope, [kind]: { ...scope[kind], [op]: ids.filter((other) => other !== id) } };
}

/** Whether `setWorkflow` takes `capabilities`: protocol 2.10 on. Unknown is taken as yes. */
export function workflowScopeSupported(daemon: string | undefined): boolean {
  if (daemon === undefined) return true;
  const [major, minor] = daemon.split(".").map(Number);
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) return false;
  return major > 2 || (major === 2 && minor >= 10);
}

/** Catalog ids the configuration offers, when it could be read. */
export interface CapabilityChoices {
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
}

export function catalogChoices(parsedConfig: unknown): CapabilityChoices | undefined {
  if (!isRecord(parsedConfig)) return undefined;
  const capabilities = isRecord(parsedConfig.capabilities) ? parsedConfig.capabilities : {};
  const ids = (kind: ScopeKind) =>
    isRecord(capabilities[kind])
      ? Object.keys(capabilities[kind])
          .filter((id) => CAPABILITY_ID.test(id))
          .sort()
      : [];
  return { mcpServers: ids("mcpServers"), skills: ids("skills") };
}
