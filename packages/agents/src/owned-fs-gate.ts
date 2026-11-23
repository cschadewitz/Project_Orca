/**
 * The policy fence on ORCA's own file executor (#703).
 *
 * An ACP agent that is given `fs.readTextFile`/`fs.writeTextFile` asks *ORCA* to read and
 * write its files: ORCA's process does the I/O. Before this, those handlers checked the
 * session roots and ORCA's protected paths and nothing else, so an agent that simply never
 * sent `session/request_permission` wrote whatever it liked inside its roots, whatever the
 * policy said. The decision to ask was the agent's.
 *
 * Now every `fs/*` call is decided by the same evaluated policy as an ask, read fresh for the
 * call, immediately before the I/O (`authorizeFs` in `acp-session.ts`):
 *
 * - **allow** — the call proceeds.
 * - **deny** — refused; nothing is read or written.
 * - **ask** — ORCA asks a person on the agent's behalf, with one-time options only, and the
 *   call proceeds only on that answer's `allow_once`, which covers this one operation. The
 *   policy is read again after the answer and the turn must still be live.
 *
 * An answer the agent's own earlier ask received is not reused for a later `fs/*` call: one
 * answer covers one operation, and a permit minted from an ask's caller-supplied locations
 * waits for physical target verification (#703 review). So an agent that asks before writing
 * is asked about the write too.
 *
 * What this covers and what it does not: it is the client-owned ACP file path only. An
 * agent's native tools (its own shell, its own file access, an MCP server it connects to by
 * itself) never pass through ORCA and are not covered; keeping an agent to this path is an
 * operating-system boundary's job (ADR 0009). On a local host the target is resolved
 * physically (`resolveOwnedFsTarget`): a link inside the roots that leads outside them is
 * refused, the policy decides both the path as written and the file it reaches (the stricter
 * answer stands), and the I/O goes to the resolved file (`owned-fs-io.ts`). Only an ordinary
 * file is read or written. An existing file is bound to the identity the decision saw (checked
 * before a safe open and again on the descriptor). A new file is bound on Linux (made through
 * the checked, open directory) and refused elsewhere, where no directory-bound creation is
 * available (#1034). A path whose identity cannot be established is refused. This is still
 * not an operating-system boundary. Remote (SSH) hosts are explicitly outside it: their paths
 * are compared as written with no identity binding (#1032).
 *
 * The durable record is separate (`recordFsOperation`, `agent.fs.authorized` and
 * `agent.fs.completed`): each authorized operation is recorded, durably (the store's exact-event
 * barrier, or the operation is refused), before its I/O can start, and its outcome after,
 * through a recorder bound to the step, session and turn it was authorized in. The record
 * names the file by a bounded, root-relative reference only. After the record the policy is
 * read again and must still allow the operation, the turn must be live and the target
 * unchanged; otherwise the outcome is `not-dispatched`. A write that failed once it may have
 * changed the file is `effect-unknown`, never `failed`. An authorization with no outcome is
 * execution-unknown (`ownedFsExecutions`), never replayed. The `fs:` decisions logged through
 * `onPermission` remain the decision log, written alongside and not awaited.
 */
import { isAbsolute, join, relative } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionDecision, PermissionExplanation, PermissionPolicy } from "@orca/core";
import { explainPermission, physicalPathOf, type PermissionEvalContext } from "./permissions.js";

export type FsAccess = "read" | "write";

/** The tool call an `fs/*` request is decided as. */
export function fsToolCall(path: string, access: FsAccess, toolCallId = `orca-fs-${access}`): acp.ToolCallUpdate {
  return {
    toolCallId,
    title: `${access === "read" ? "Read" : "Write"} ${path}`,
    kind: access === "read" ? "read" : "edit",
    locations: [{ path }],
  };
}

/** The policy's answer for one `fs/*` call, protected paths first. */
export function decideFsCall(
  policy: PermissionPolicy,
  path: string,
  access: FsAccess,
  ctx: PermissionEvalContext,
): PermissionDecision {
  return explainFsCall(policy, path, access, ctx).decision;
}

/** `decideFsCall` with what decided it, for the `fs:` record (#702). */
export function explainFsCall(
  policy: PermissionPolicy,
  path: string,
  access: FsAccess,
  ctx: PermissionEvalContext,
): PermissionExplanation {
  return explainPermission(policy, { sessionId: "", toolCall: fsToolCall(path, access), options: [] }, ctx);
}

/**
 * Where a local `fs/*` request really lands (#703). `io` is the file the request reaches,
 * links followed, and is what the I/O is done on. `asWritten` is that same file named under
 * the session root it is in, as that root is written, so the policy reads it like any other
 * path in the workspace (a workspace reached through a linked directory, such as macOS's
 * `/tmp`, still matches its own rules).
 *
 * `outside` when the file is not inside any session root once resolved, which is a link
 * leading out of them; `unresolvable` when the path or a root cannot be resolved for any reason
 * but absence. Both are refused: neither can be shown to be inside the roots.
 */
export type OwnedFsTarget =
  { ok: true; io: string; asWritten: string } | { ok: false; reason: "outside" | "unresolvable" };

export function resolveOwnedFsTarget(path: string, roots: readonly string[]): OwnedFsTarget {
  const io = physicalPathOf(path);
  if (io === undefined) return { ok: false, reason: "unresolvable" };
  for (const root of roots) {
    const physicalRoot = physicalPathOf(root);
    if (physicalRoot === undefined) return { ok: false, reason: "unresolvable" };
    const rel = relative(physicalRoot, io);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { ok: true, io, asWritten: join(root, rel) };
  }
  return { ok: false, reason: "outside" };
}

/** The stricter of two answers: deny over ask over allow. On a tie, the first. */
export function stricterExplanation(a: PermissionExplanation, b: PermissionExplanation): PermissionExplanation {
  const rank = (d: PermissionDecision) => (d === "deny" ? 2 : d === "ask" ? 1 : 0);
  return rank(b.decision) > rank(a.decision) ? b : a;
}
