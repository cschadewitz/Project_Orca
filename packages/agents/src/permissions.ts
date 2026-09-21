/**
 * Permission policy evaluation for ACP `session/request_permission`, and the sidecar file
 * that "allow always" writes to.
 *
 * ORCA is usually unattended, so an agent that declares no policy gets the conservative one
 * (`DEFAULT_PERMISSION_POLICY` in `@orca/core`): reads, searches and edits inside the run's
 * workspace are allowed and logged, and everything else — `execute`, the network, a path in
 * a sibling checkout — is `ask`. Rules can deny, allow or route specific tool kinds/paths to
 * a human (or, in ACP-facade mode, to the upstream client that launched ORCA).
 *
 * An `ask` nobody can answer is refused, not parked: `resolvePermission` with no `ask`
 * callback, and a `PausingHumanInput` that declines to persist a permission question,
 * both come back `cancelled`, which ends the tool call rather than the run.
 *
 * A policy has two halves. The configured half is `agents[].permissions` in
 * `orca.config.yaml`: hand-curated, and no place for a machine to append. The written half
 * is `orca.permissions.json` beside it — the workspace sidecar, added to whenever someone
 * answers a prompt with "always", and layered *under* the configured rules so configuration
 * always outranks it. The file is plain JSON with provenance on every rule because a
 * standing permission grant ought to be something a teammate can read in a diff.
 *
 * The schemas, the layering and the derivation are in `@orca/core`
 * (`model/agent.ts`), which is node-free; the reading, writing and locking are here.
 */
import { link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type * as acp from "@agentclientprotocol/sdk";
import {
  derivePermissionRules,
  layerPermissionPolicies,
  OrcaError,
  PERMISSION_POLICY_FILENAME,
  PermissionPolicyFileSchema,
  permissionPathForms,
  samePermissionRule,
  workspaceRelativePath,
  WritablePermissionPolicyFileSchema,
} from "@orca/core";
import type {
  PermissionDecision,
  PermissionDeriveRefusal,
  PermissionPolicy,
  PermissionPolicyFile,
  PermissionRule,
  RecordedPermissionRule,
} from "@orca/core";

export interface PermissionContext {
  request: acp.RequestPermissionRequest;
  /** Called for `ask`; returns the chosen optionId, or undefined to cancel. */
  ask?: (request: acp.RequestPermissionRequest) => Promise<string | undefined>;
  /** Passed through to `decidePermission`, so workspace-relative rules can resolve. */
  scope?: PermissionEvalContext | undefined;
}

/**
 * What a rule's paths are relative to. Rules ORCA writes are workspace-relative so that the
 * same grant still fires in the next run's git worktree, which sits at a different absolute
 * path; without a workspace only absolute rules can match.
 */
export interface PermissionEvalContext {
  /** Absolute path of the run's workspace (`Run.workspace.cwd`). */
  workspaceCwd?: string | undefined;
}

export function decidePermission(
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx?: PermissionEvalContext,
): PermissionDecision {
  const tc = request.toolCall;
  const title = tc.title ?? "";
  const kind = tc.kind ?? "other";
  const cwd = ctx?.workspaceCwd;
  const locations = (tc.locations ?? []).map((l) => l.path);
  const paths = locations.flatMap((p) => permissionPathForms(p, cwd));
  // Both are false for a call with no locations, so `scope` never matches one (#140).
  const allInside = locations.length > 0 && locations.every((p) => workspaceRelativePath(p, cwd) !== undefined);
  const anyOutside = locations.some((p) => workspaceRelativePath(p, cwd) === undefined);
  for (const rule of policy.rules) {
    const m = rule.match;
    if (m.kind && m.kind !== kind) continue;
    if (m.scope === "workspace" && !allInside) continue;
    if (m.scope === "outside-workspace" && !anyOutside) continue;
    if (m.titlePattern && !new RegExp(m.titlePattern).test(title)) continue;
    if (m.path !== undefined) {
      const wanted = permissionPathForms(m.path, cwd);
      if (!wanted.some((w) => paths.includes(w))) continue;
    }
    if (m.pathPrefix) {
      const prefixes = permissionPathForms(m.pathPrefix, cwd).filter((p) => p !== "");
      if (prefixes.length > 0 && !paths.some((p) => prefixes.some((prefix) => p.startsWith(prefix)))) continue;
    }
    return rule.decision;
  }
  return policy.default;
}

function pick(options: acp.PermissionOption[], kinds: acp.PermissionOptionKind[]): acp.PermissionOption | undefined {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return o;
  }
  return undefined;
}

export async function resolvePermission(
  policy: PermissionPolicy,
  ctx: PermissionContext,
): Promise<{ response: acp.RequestPermissionResponse; decision: string }> {
  const decision = decidePermission(policy, ctx.request, ctx.scope);
  const options = ctx.request.options;
  const select = (o: acp.PermissionOption | undefined, label: string) =>
    o
      ? { response: { outcome: { outcome: "selected" as const, optionId: o.optionId } }, decision: label }
      : { response: { outcome: { outcome: "cancelled" as const } }, decision: "cancelled" };
  switch (decision) {
    case "allow":
      return select(pick(options, ["allow_once", "allow_always"]), "allow");
    case "deny":
      return select(pick(options, ["reject_once", "reject_always"]), "deny");
    case "ask": {
      // Nothing to ask through: the run has no human-input channel at all. Say so in the
      // decision rather than logging a bare "cancelled", because "the policy wanted a person
      // and there was none" is the one a person reading the log has to act on (#140).
      if (!ctx.ask) return { response: { outcome: { outcome: "cancelled" } }, decision: "ask:no-answerer" };
      const chosen = await ctx.ask(ctx.request);
      const o = chosen ? options.find((x) => x.optionId === chosen) : undefined;
      return o
        ? { response: { outcome: { outcome: "selected", optionId: o.optionId } }, decision: `ask:${o.kind}` }
        : { response: { outcome: { outcome: "cancelled" } }, decision: "ask:cancelled" };
    }
  }
}

/* -------------------------------------------------------------------------- *
 * The sidecar
 * -------------------------------------------------------------------------- */

const EMPTY_POLICY_FILE: PermissionPolicyFile = { version: 1, agents: {} };

/** Where the workspace sidecar lives: beside `orca.config.yaml`, in the config directory. */
export function permissionPolicyPath(configDir: string): string {
  return join(configDir, PERMISSION_POLICY_FILENAME);
}

/**
 * Read a sidecar. A file that is not there is an empty policy — nobody has answered
 * "always" yet. A file that is there and unreadable is `CONFIG_INVALID`, not an empty
 * policy: silently ignoring a corrupt permissions file would quietly widen what an agent
 * may do, and this is the one file where that is never an acceptable failure mode.
 */
export async function readPermissionPolicyFile(file: string): Promise<PermissionPolicyFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_POLICY_FILE };
    throw e;
  }
  if (text.trim() === "") return { ...EMPTY_POLICY_FILE };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new OrcaError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, {}, { cause: e });
  }
  const parsed = PermissionPolicyFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new OrcaError("CONFIG_INVALID", `${file}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/** The rules a sidecar contributes for one agent, in file order, without their provenance. */
export function permissionOverlayFor(doc: PermissionPolicyFile, agentId: string): PermissionRule[] {
  return (doc.agents[agentId]?.rules ?? []).map((r) => ({ match: { ...r.match }, decision: r.decision }));
}

/**
 * The policy to evaluate for an agent: its configured rules first, then each sidecar in the
 * order given. Today `files` is one entry — the workspace sidecar. A user-scoped file layers
 * *under* it by being passed after it; nothing else about this has to change.
 *
 * A file that is missing contributes nothing, so a workspace where nobody has ever answered
 * "always" evaluates exactly as it did before this existed.
 */
export async function loadEffectivePermissionPolicy(
  agent: { id: string; permissions: PermissionPolicy },
  files: readonly string[],
): Promise<PermissionPolicy> {
  const overlays: PermissionRule[][] = [];
  for (const file of files) overlays.push(permissionOverlayFor(await readPermissionPolicyFile(file), agent.id));
  return layerPermissionPolicies(agent.permissions, ...overlays);
}

export interface RecordAlwaysOptions {
  /** The sidecar to append to; `permissionPolicyPath(configDir)` for the workspace one. */
  file: string;
  /** The agent whose policy is being added to. */
  agentId: string;
  /** The request that was answered. */
  request: acp.RequestPermissionRequest;
  /** `allow` for an `allow_always` answer, `deny` for `reject_always`. */
  decision: "allow" | "deny";
  /** Absolute path of the run's workspace. Without it, no path-scoped rule can be written. */
  workspaceCwd?: string | undefined;
  /** Injectable clock, for tests. */
  now?: (() => Date) | undefined;
  /** Lock tuning; the defaults are fine. */
  lock?: { timeoutMs?: number; staleMs?: number } | undefined;
}

/**
 * What the caller tells the person. `#160`'s `inputs.answer` result says which rules were
 * added and where, so `#161`'s button can promise it honestly — including promising nothing
 * when `refused` is set and the answer could only be honoured once.
 */
export interface RecordAlwaysResult {
  file: string;
  agentId: string;
  /** The rules this answer implies: appended now, or already there from a previous answer. */
  rules: PermissionRule[];
  /** The subset actually appended by this call. */
  added: PermissionRule[];
  /** The subset that was already recorded, so the file was not rewritten for them. */
  alreadyPresent: PermissionRule[];
  /** Set when nothing could be derived. The caller must fall back to allowing this one call. */
  refused?: { reason: PermissionDeriveRefusal; detail: string };
}

/**
 * Append the rules an "always" answer justifies, and say what was written.
 *
 * The derivation — what generalises and what this refuses to generalise — is
 * `derivePermissionRules` in `@orca/core`. Everything here is the file: read, append,
 * rewrite, under a lock, so that two runs answering "always" at the same moment both land
 * instead of the second silently overwriting the first.
 */
export async function recordAlwaysDecision(opts: RecordAlwaysOptions): Promise<RecordAlwaysResult> {
  const tc = opts.request.toolCall;
  const derived = derivePermissionRules(
    {
      kind: tc.kind,
      title: tc.title,
      paths: (tc.locations ?? []).map((l) => l.path),
      workspaceCwd: opts.workspaceCwd,
    },
    opts.decision,
  );
  if (!derived.ok)
    return {
      file: opts.file,
      agentId: opts.agentId,
      rules: [],
      added: [],
      alreadyPresent: [],
      refused: { reason: derived.reason, detail: derived.detail },
    };

  const addedAt = (opts.now?.() ?? new Date()).toISOString();
  const grantedFor = (tc.title ?? "").trim();
  return withPolicyLock(opts.file, opts.lock, async () => {
    const doc = await readPermissionPolicyFile(opts.file);
    const rules = [...(doc.agents[opts.agentId]?.rules ?? [])];
    const added: PermissionRule[] = [];
    const alreadyPresent: PermissionRule[] = [];
    for (const rule of derived.rules) {
      if (rules.some((r) => samePermissionRule(r, rule))) alreadyPresent.push(rule);
      else {
        rules.push({ ...rule, addedAt, ...(grantedFor === "" ? {} : { grantedFor }) });
        added.push(rule);
      }
    }
    if (added.length > 0)
      await writePolicyFile(opts.file, { ...doc, agents: { ...doc.agents, [opts.agentId]: { rules } } });
    return { file: opts.file, agentId: opts.agentId, rules: derived.rules, added, alreadyPresent };
  });
}

/**
 * Replace a sidecar wholesale, under the same lock `recordAlwaysDecision` takes.
 *
 * This is the operator's half of ADR 0009: `config.set` on the `permissions` document
 * (#266) edits or removes a grant a machine wrote. It goes through here rather than through
 * a second writer in the daemon for one reason worth being blunt about - a `link()` lock is
 * only a lock if *every* writer takes it. A daemon that opened the file itself would be a
 * second path with its own tmp name and its own idea of atomicity, and the case it would
 * lose is exactly the one #266 asks to be tested: a run answering "always" at the moment an
 * operator saves an edit.
 *
 * The document is validated with `WritablePermissionPolicyFileSchema`, which refuses a
 * `default`, and serialised with the same fixed key order a machine write uses, so an
 * operator's save and ORCA's own append produce the same shape of diff.
 *
 * It is a replace and not a merge. The caller read a revision, edited it and sends the whole
 * document back; deciding here which of two concurrent versions of a rule list was meant is
 * a guess, and the staleness check at the caller is where that is refused honestly.
 */
export async function replacePermissionPolicyFile(
  file: string,
  doc: unknown,
  opts?: { lock?: { timeoutMs?: number; staleMs?: number } | undefined },
): Promise<PermissionPolicyFile> {
  const parsed = parsePermissionPolicyDocument(doc);
  await withPolicyLock(file, opts?.lock, () => writePolicyFile(file, parsed));
  return parsed;
}

/**
 * Validate a sidecar document a client sent, refusing a `default`. Exported beside the
 * writer so a `validateOnly` call can ask the same question without taking the lock.
 */
export function parsePermissionPolicyDocument(doc: unknown): PermissionPolicyFile {
  const parsed = WritablePermissionPolicyFileSchema.safeParse(doc ?? {});
  if (!parsed.success)
    throw new OrcaError("CONFIG_INVALID", parsed.error.issues[0]?.message ?? "invalid permission document", {
      issues: parsed.error.issues,
    });
  const { default: _refused, ...rest } = parsed.data;
  return rest;
}

/* ----------------------------- file mechanics ----------------------------- */

/** Keys in a fixed order and `undefined` omitted, so a rewrite produces a minimal diff. */
function serialize(doc: PermissionPolicyFile): string {
  const rule = (r: RecordedPermissionRule): Record<string, unknown> => {
    const match: Record<string, unknown> = {};
    for (const key of ["kind", "titlePattern", "path", "pathPrefix", "scope"] as const)
      if (r.match[key] !== undefined) match[key] = r.match[key];
    const out: Record<string, unknown> = { match, decision: r.decision };
    if (r.addedAt !== undefined) out["addedAt"] = r.addedAt;
    if (r.grantedFor !== undefined) out["grantedFor"] = r.grantedFor;
    return out;
  };
  const agents: Record<string, unknown> = {};
  for (const id of Object.keys(doc.agents).sort()) agents[id] = { rules: (doc.agents[id]?.rules ?? []).map(rule) };
  return `${JSON.stringify({ version: doc.version, agents }, null, 2)}\n`;
}

async function writePolicyFile(file: string, doc: PermissionPolicyFile): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, serialize(doc), "utf8");
  await rename(tmp, file);
}

/**
 * Serialise read-modify-write across processes, with the same `link()`-to-create idiom the
 * store's `withFileLock` uses. It is not reused: `@orca/agents` sits to the right of
 * `@orca/store` in the layering, so it cannot import it.
 *
 * The wait (10s) is deliberately shorter than the staleness window (30s), so a lock is only
 * ever broken when its holder died holding it, never when it is merely slow.
 */
async function withPolicyLock<T>(
  file: string,
  opts: { timeoutMs?: number; staleMs?: number } | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = `${file}.lock`;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const staleMs = opts?.staleMs ?? 30_000;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  const deadline = Date.now() + timeoutMs;
  try {
    for (let backoff = 1; ; backoff = Math.min(backoff * 2, 32)) {
      try {
        await link(tmp, lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        await breakIfStale(lock, staleMs);
        if (Date.now() >= deadline)
          throw new OrcaError("STORE_LOCK_TIMEOUT", `${lock} is held by another writer`, { file });
        await delay(backoff + Math.random() * backoff);
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

async function breakIfStale(lock: string, staleMs: number): Promise<void> {
  try {
    const st = await stat(lock);
    if (Date.now() - st.mtimeMs > staleMs) await unlink(lock);
  } catch {
    // Gone already, or another waiter broke it first. Either way, retry the link.
  }
}
