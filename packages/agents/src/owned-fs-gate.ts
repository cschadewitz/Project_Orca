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
 * operating-system boundary's job (ADR 0009). Paths are compared as written, workspace-
 * relative where they can be, like every rule; a symlink inside the roots that leads
 * elsewhere is the roots check's and the protected-path check's concern, not this one's.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionDecision, PermissionPolicy } from "@orca/core";
import { decidePermission, type PermissionEvalContext } from "./permissions.js";

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
  return decidePermission(policy, { sessionId: "", toolCall: fsToolCall(path, access), options: [] }, ctx);
}
