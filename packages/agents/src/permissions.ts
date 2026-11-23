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
 * A policy has two halves and a floor. The configured half is `agents[].permissions` in
 * `orca.config.yaml`: hand-curated, and no place for a machine to append. The written half
 * is `orca.permissions.json` beside it — the workspace sidecar, added to whenever someone
 * answers a prompt with "always", and layered *under* the configured rules so configuration
 * always outranks it. The file is plain JSON with provenance on every rule because a
 * standing permission grant ought to be something a teammate can read in a diff. The floor
 * is `DEFAULT_PERMISSION_POLICY`, appended last by `loadEffectivePermissionPolicy`, so that
 * a `deny` from either half outranks it (#140).
 *
 * The sidecar is read *per ask*, not per session (#271): `openAcpSession` calls
 * `loadEffectivePermissionPolicy` from its `session/request_permission` handler, so a rule
 * recorded while a run is in flight — somebody answering "always" in the app — decides the
 * very next tool call rather than only the next session. The file is two levels of nesting
 * deep and an ask is already a round trip to an agent, so re-reading it costs nothing worth
 * caching against.
 *
 * Ahead of every layer sit ORCA's own files (`ProtectedPaths`, C4-01). With no `workspace:`
 * configured the run's workspace *is* the config directory, so the config, the sidecar, the
 * store and `auth/` are all "inside the workspace" — and an agent allowed to edit the sidecar
 * could allow itself everything. No rule reaches them: configured, written or default.
 *
 * The schemas, the layering and the derivation are in `@orca/core`
 * (`model/agent.ts`), which is node-free; the reading, writing, locking and the physical
 * path checks are here.
 */
import { realpathSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { revisionOf, withPolicyLock } from "./permission-file.js";
import type * as acp from "@agentclientprotocol/sdk";
import {
  derivePermissionRules,
  effectivePermissionPolicy,
  isWildcardPermissionRule,
  OrcaError,
  PERMISSION_POLICY_FILENAME,
  PermissionPolicyFileSchema,
  permissionPathForms,
  permissionRuleExpired,
  samePermissionRule,
  workspaceRelativePath,
  WritablePermissionPolicyFileSchema,
} from "@orca/core";
import type {
  ConfiguredPermissionPolicy,
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
  /** The exact invocation's lifetime; late answers cannot authorize a subsequent turn. */
  signal?: AbortSignal;
}

/**
 * What a rule's paths are relative to. Rules ORCA writes are workspace-relative so that the
 * same grant still fires in the next run's git worktree, which sits at a different absolute
 * path; without a workspace only absolute rules can match.
 */
export interface PermissionEvalContext {
  /** Absolute path of the run's workspace (`Run.workspace.cwd`). */
  workspaceCwd?: string | undefined;
  /** ORCA's own files: a call that would touch one is denied ahead of every rule (C4-01). */
  protectedPaths?: ProtectedPaths | undefined;
}

export function decidePermission(
  policy: PermissionPolicy,
  request: acp.RequestPermissionRequest,
  ctx?: PermissionEvalContext,
): PermissionDecision {
  return protectedLocation(request, ctx) === undefined ? decideByRules(policy, request, ctx) : "deny";
}

/** The policy's answer, first match wins, with nothing ahead of it. */
function decideByRules(
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
  if (ctx.signal?.aborted) return { response: { outcome: { outcome: "cancelled" } }, decision: "ask:expired" };
  // `decidePermission`'s own check, kept apart here so the decision can say why it denied.
  const guarded = protectedLocation(ctx.request, ctx.scope) !== undefined;
  const decision = guarded ? "deny" : decideByRules(policy, ctx.request, ctx.scope);
  const options = ctx.request.options;
  const select = (o: acp.PermissionOption | undefined, label: string) =>
    o
      ? { response: { outcome: { outcome: "selected" as const, optionId: o.optionId } }, decision: label }
      : { response: { outcome: { outcome: "cancelled" as const } }, decision: "cancelled" };
  switch (decision) {
    case "allow": {
      // Only a one-time option (#702). `allow_always` would have the *agent* remember the
      // grant and stop asking, so a rule that later expires, is removed or is narrowed would
      // never be consulted again for that tool: ORCA's own rule is the standing grant, and
      // the agent is told yes for this one call. An ask that offers no one-time allow is
      // refused and says why, rather than widened.
      const once = pick(options, ["allow_once"]);
      return once
        ? select(once, "allow")
        : { response: { outcome: { outcome: "cancelled" } }, decision: "allow:no-one-time-option" };
    }
    case "deny":
      return select(pick(options, ["reject_once", "reject_always"]), guarded ? "deny:protected" : "deny");
    case "ask": {
      // Nothing to ask through: the run has no human-input channel at all. Say so in the
      // decision rather than logging a bare "cancelled", because "the policy wanted a person
      // and there was none" is the one a person reading the log has to act on (#140).
      if (!ctx.ask) return { response: { outcome: { outcome: "cancelled" } }, decision: "ask:no-answerer" };
      const chosen = await permissionWhileLive(() => ctx.ask!(ctx.request), ctx.signal);
      if (ctx.signal?.aborted) return { response: { outcome: { outcome: "cancelled" } }, decision: "ask:expired" };
      const o = chosen ? options.find((x) => x.optionId === chosen) : undefined;
      return o
        ? { response: { outcome: { outcome: "selected", optionId: o.optionId } }, decision: `ask:${o.kind}` }
        : { response: { outcome: { outcome: "cancelled" } }, decision: "ask:cancelled" };
    }
  }
}

/** Release a dead callback even if its host never settles; detach the abort listener on both paths. */
function permissionWhileLive(
  ask: () => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!signal) return ask();
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => (signal.aborted ? undefined : ask()))
      .then(
        (answer) => {
          signal.removeEventListener("abort", abort);
          resolve(signal.aborted ? undefined : answer);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error("permission callback failed", { cause: error }));
        },
      );
  });
}

/* -------------------------------------------------------------------------- *
 * Protected paths
 * -------------------------------------------------------------------------- */

/**
 * ORCA's own files, which no permission rule can open to an agent (C4-01).
 *
 * With no `workspace:` configured, a run's workspace is the config directory, and that holds
 * what decides what an agent may do and who may answer it: the config, the permission
 * sidecar, the store with its key, and `auth/` with an owner token. The default policy allows
 * edits inside the workspace and the sidecar is re-read on every ask, so an agent that could
 * write `{"match":{},"decision":"allow"}` into the sidecar would have every later `execute`
 * approved without anybody being asked.
 *
 * So these are checked before the rules, and nothing overrides them — a configured rule, a
 * sidecar rule, the defaults or `default: allow`. Changing them is a person's job, in the
 * config or on the Config surface, never an agent's through a tool call. The ACP session
 * checks its `fs/*` handlers against the same list. An agent's own native tools can still
 * reach these files without asking ORCA at all; the answer to that is keeping the config
 * directory out of every agent root (`workspace:`, `isolateRoots`), and for a hard boundary
 * an operating-system one (ADR 0009).
 */
export interface ProtectedPaths {
  /** An agent may read these, but never edit, write, move or delete them. */
  readonly readOnly: readonly string[];
  /** An agent may not touch these at all, reads included: credentials and key material. */
  readonly noAccess: readonly string[];
  /**
   * Directories inside a read-only path that are the agent's after all, and so the policy's
   * to decide — the store's `work/` and `program/`, where ORCA's own workflows have agents
   * write their deliverables when the store sits in the workspace. Each is placed by its
   * parent, so a link standing in its place does not carry the rest of the store with it.
   */
  readonly agentAreas?: readonly string[] | undefined;
}

/**
 * The protected path `path` falls under for this kind of access, or undefined when it is free.
 * `remove` — a delete or a move — also refuses a directory that holds one, since taking the
 * directory away takes the protected path with it.
 *
 * Both sides are compared as the file system resolves them — symlinks followed, and `..` taken
 * from where a link leads rather than from where it was written, the way the agent's own open
 * would — and segment by segment. So a link to `auth/` is `auth/`,
 * `sub/../orca.permissions.json` is the sidecar, and `.orca-notes` is not `.orca`. A relative
 * path is taken against the workspace, as a rule's is; the ACP session always passes one.
 */
export function protectedPathFor(
  path: string,
  access: "read" | "write" | "remove",
  protectedPaths: ProtectedPaths | undefined,
  workspaceCwd?: string,
): string | undefined {
  if (!protectedPaths) return undefined;
  if (!isAbsolute(path) && !workspaceCwd) return undefined;
  // Joined as text, not with `join`: that would fold `sub/..` lexically before the links in it are followed.
  const target = pathSegments(physicalPath(isAbsolute(path) ? path : `${workspaceCwd}${sep}${path}`));
  const hit = (roots: readonly string[]) =>
    roots.find((root) => {
      const guard = pathSegments(physicalPath(root));
      return within(target, guard) || (access === "remove" && within(guard, target));
    });
  const unreadable = hit(protectedPaths.noAccess);
  if (unreadable !== undefined || access === "read") return unreadable;
  const areas = (protectedPaths.agentAreas ?? []).map((area) =>
    pathSegments(join(physicalPath(dirname(area)), basename(area))),
  );
  return protectedPaths.readOnly.find((root) => {
    const guard = pathSegments(physicalPath(root));
    if (!within(target, guard) && !(access === "remove" && within(guard, target))) return false;
    // An area exempts its enclosing store, never an explicit authority path inside it.
    // Config/sidecar paths may themselves live (or resolve through a link) under work/.
    return !areas.some((area) => guard.length < area.length && within(area, guard) && within(target, area));
  });
}

/** Whether `inner` is `outer` or below it, segment by segment. */
function within(inner: readonly string[], outer: readonly string[]): boolean {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i]);
}

/**
 * The first location of a tool call that touches a protected path in a way its kind could.
 * `read` and `search` only look; every other kind — `execute` and `other` included — may
 * change what it touches, so it is held to the stricter list.
 */
function protectedLocation(
  request: acp.RequestPermissionRequest,
  ctx: PermissionEvalContext | undefined,
): string | undefined {
  if (!ctx?.protectedPaths) return undefined;
  const kind = request.toolCall.kind ?? "other";
  const access =
    kind === "read" || kind === "search" ? "read" : kind === "delete" || kind === "move" ? "remove" : "write";
  return (request.toolCall.locations ?? [])
    .map((l) => l.path)
    .find((p) => protectedPathFor(p, access, ctx.protectedPaths, ctx.workspaceCwd) !== undefined);
}

/**
 * `path` as the file system resolves it. The part that does not exist yet — a file about to be
 * created — is appended to the deepest ancestor that does, which is what an open of it reaches.
 */
function physicalPath(path: string): string {
  const missing: string[] = [];
  for (let head = path; ;) {
    try {
      return join(realpathSync.native(head), ...missing);
    } catch {
      const parent = dirname(head);
      if (parent === head) return join(head, ...missing);
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/** Windows and macOS file systems ignore case by default, so a comparison has to as well. */
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

function pathSegments(path: string): string[] {
  return (FOLD_CASE ? path.toLowerCase() : path).split(sep === "\\" ? /[\\/]+/ : /\/+/).filter((s) => s !== "");
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

/**
 * The rules a sidecar contributes for one agent, in file order, without their provenance —
 * less any wildcard `allow` (`isWildcardPermissionRule` in `@orca/core`), which is reported
 * to `onIgnored` and never evaluated. ORCA only ever writes scoped grants, and a wildcard in
 * this file is how an agent that reached it would allow itself everything (C4-01); a person
 * who means one writes it in the config. A rule whose `expiresAt` has passed at `now` is
 * left out too (#702).
 */
export function permissionOverlayFor(
  doc: PermissionPolicyFile,
  agentId: string,
  onIgnored?: (rule: PermissionRule) => void,
  now: number = Date.now(),
): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const r of doc.agents[agentId]?.rules ?? []) {
    // A rule whose lifetime has run out decides nothing (#702). It is not reported as
    // ignored: it was a scoped grant that ended, not a wildcard somebody slipped in.
    if (permissionRuleExpired(r, now)) continue;
    const rule: PermissionRule = { match: { ...r.match }, decision: r.decision };
    if (isWildcardPermissionRule(rule)) onIgnored?.(rule);
    else rules.push(rule);
  }
  return rules;
}

/**
 * The policy to evaluate for an agent: its configured rules first, then each sidecar in the
 * order given, then `DEFAULT_PERMISSION_POLICY`'s rules last — if they apply. Today `files`
 * is one entry, the workspace sidecar. A user-scoped file layers *under* it by being passed
 * after it; nothing else about this has to change.
 *
 * The ordering and the "if they apply" are both `effectivePermissionPolicy`'s in `@orca/core`,
 * not this function's, which only adds the file reading. This is the one production path to
 * an evaluated policy: `acp-session.ts` calls it per ask (#271), with no files when nothing
 * wired a sidecar, so "no sidecar" is the same code reaching the same answer rather than a
 * second evaluation that has to be kept in step with this one.
 *
 * A file that is missing contributes nothing, so a workspace where nobody has ever answered
 * "always" evaluates exactly as it did before this existed.
 *
 * `onUnreadable` decides what a *corrupt* sidecar means to the caller, and the two answers
 * are both right in their place. Omit it and the `CONFIG_INVALID` propagates, which is what
 * a caller reading the file to show or edit it wants. Pass one — `openAcpSession` does — and
 * the file is skipped and reported instead: a live agent asking for permission must not be
 * taken down by a sidecar somebody hand-edited badly.
 *
 * Skipping alone is not the conservative direction, though this comment used to say it was.
 * A sidecar holds `deny` and `ask` rules too — `reject_always` writes one — and the layers
 * after it were written on the assumption that it was read first: drop it and a recorded
 * `deny` on an in-workspace edit falls through to the default `allow` (ADR 0009). So once a
 * file cannot be read, every `allow` decided *after* it — a later sidecar's, a default rule's,
 * the fallthrough's — becomes `ask`. The configured rules ahead of it decide exactly as
 * before, and what the unreadable file might have said is put to a person rather than
 * assumed, so what is lost is grants and never a restriction.
 *
 * `onIgnored` hears each wildcard `allow` that `permissionOverlayFor` dropped from a sidecar
 * that could be read.
 */
export async function loadEffectivePermissionPolicy(
  agent: { id: string; permissions: ConfiguredPermissionPolicy },
  files: readonly string[],
  onUnreadable?: (file: string, error: unknown) => void,
  onIgnored?: (file: string, rule: PermissionRule) => void,
  /** The clock rule lifetimes are judged against (#702); injectable for tests. */
  now: () => number = Date.now,
): Promise<PermissionPolicy> {
  const overlays: PermissionRule[][] = [];
  /** How many rules come before the first sidecar that could not be read. */
  let readable: number | undefined;
  for (const file of files) {
    try {
      const doc = await readPermissionPolicyFile(file);
      overlays.push(
        permissionOverlayFor(doc, agent.id, onIgnored ? (rule) => onIgnored(file, rule) : undefined, now()),
      );
    } catch (e) {
      if (!onUnreadable) throw e;
      onUnreadable(file, e);
      readable ??= overlays.reduce((n, overlay) => n + overlay.length, agent.permissions.rules.length);
    }
  }
  const policy = effectivePermissionPolicy(agent.permissions, ...overlays);
  if (readable === undefined) return policy;
  const capFrom = readable;
  const cap = (decision: PermissionDecision): PermissionDecision => (decision === "allow" ? "ask" : decision);
  return {
    default: cap(policy.default),
    rules: policy.rules.map((rule, i) => (i < capFrom ? rule : { ...rule, decision: cap(rule.decision) })),
  };
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
  /**
   * When the written rule stops deciding (#702), as an ISO-8601 instant. Absent: it stands
   * until somebody removes it, which is what "always" meant before rules had lifetimes.
   */
  expiresAt?: string | undefined;
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
  /**
   * The subset this call wrote: appended, or an equivalent rule already in the file whose
   * lifetime this answer extended (an expired one, or one ending sooner than this answer's).
   */
  added: PermissionRule[];
  /** The subset already recorded for at least as long, so the file was not rewritten for them. */
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

  const at = opts.now?.() ?? new Date();
  const addedAt = at.toISOString();
  const expiresAt = opts.expiresAt;
  if (expiresAt !== undefined && !(Date.parse(expiresAt) > at.getTime()))
    throw new OrcaError("CONFIG_INVALID", `a standing rule cannot expire at ${expiresAt}: that is not after now`);
  const grantedFor = (tc.title ?? "").trim();
  /** How long a rule lasts, for "does this answer outlast the one on file". */
  const until = (rule: RecordedPermissionRule): number =>
    rule.expiresAt === undefined ? Infinity : Date.parse(rule.expiresAt);
  const wanted = expiresAt === undefined ? Infinity : Date.parse(expiresAt);
  return withPolicyLock(opts.file, opts.lock, async () => {
    const doc = await readPermissionPolicyFile(opts.file);
    const rules = [...(doc.agents[opts.agentId]?.rules ?? [])];
    const added: PermissionRule[] = [];
    const alreadyPresent: PermissionRule[] = [];
    const recorded = (rule: PermissionRule): RecordedPermissionRule => ({
      ...rule,
      addedAt,
      ...(grantedFor === "" ? {} : { grantedFor }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    for (const rule of derived.rules) {
      const same = rules.flatMap((r, index) => (samePermissionRule(r, rule) ? [index] : []));
      if (same.some((index) => until(rules[index]!) >= wanted)) alreadyPresent.push(rule);
      else if (same.length > 0) {
        // The grant is on file but ends sooner (or has ended): this answer extends it in place
        // rather than appending a twin, so the file keeps one line per grant.
        rules[same[0]!] = recorded(rule);
        added.push(rule);
      } else {
        rules.push(recorded(rule));
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
 * a guess, and refusing it as stale is the honest answer.
 *
 * Which is why `expectedRevision` is checked **here**, inside the lock, and not by the
 * caller. A daemon that compared revisions and then called this had a window between the two
 * exactly wide enough for a run answering "always" to append a grant, and the replace then
 * dropped it - the one case #266 names and the one this lock exists to prevent. It is the
 * sha256 hex of the file's current bytes, `""` for a file that is not there; omit it and the
 * replace is unconditional, which is what a caller with no revision to quote should do
 * deliberately rather than by default.
 */
export async function replacePermissionPolicyFile(
  file: string,
  doc: unknown,
  opts?: {
    lock?: { timeoutMs?: number; staleMs?: number } | undefined;
    /** sha256 hex of the bytes the caller's edit was based on; `""` for "there was no file". */
    expectedRevision?: string | undefined;
    /** Current caller authority, checked under the lock and immediately before replacement. */
    authorize?: (() => Promise<void>) | undefined;
  },
): Promise<PermissionPolicyFile> {
  const parsed = parsePermissionPolicyDocument(doc);
  const expected = opts?.expectedRevision;
  await withPolicyLock(file, opts?.lock, async () => {
    await opts?.authorize?.();
    if (expected !== undefined) {
      const actual = await revisionOf(file);
      if (actual !== expected)
        throw new OrcaError(
          "CONFIG_STALE",
          `${file} has changed since you read it: write again against the current revision`,
          { file, expectedRevision: expected, actualRevision: actual },
        );
    }
    await refuseUnsupportedPolicyReplacement(file);
    await writePolicyFile(file, parsed, opts?.authorize);
  });
  return parsed;
}

/**
 * Input validation alone does not protect a newer document: a legacy client can send a
 * valid v1 replacement for bytes it cannot interpret. Refuse explicit incompatible
 * versions under the shared lock, even for an unconditional replacement. Keep the
 * existing operator repair path for malformed/empty legacy documents.
 *
 * This protects only binaries containing this guard. Earlier replacements never read
 * the current version; adding this check cannot make those binaries safe to downgrade.
 */
async function refuseUnsupportedPolicyReplacement(file: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "version" in raw && raw.version !== 1)
    throw new OrcaError("CONFIG_INVALID", `${file}: refusing to replace an unsupported permission document version`);
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
    if (r.expiresAt !== undefined) out["expiresAt"] = r.expiresAt;
    return out;
  };
  const agents: Record<string, unknown> = {};
  for (const id of Object.keys(doc.agents).sort()) agents[id] = { rules: (doc.agents[id]?.rules ?? []).map(rule) };
  return `${JSON.stringify({ version: doc.version, agents }, null, 2)}\n`;
}

async function writePolicyFile(
  file: string,
  doc: PermissionPolicyFile,
  authorize?: () => Promise<void>,
): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, serialize(doc), "utf8");
    await authorize?.();
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
