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
 * call (so a removed or expired rule is not consulted), immediately before the I/O:
 *
 * - **allow** — the call proceeds.
 * - **deny** — refused; nothing is read or written.
 * - **ask** — the call proceeds only on a **one-use permit**: a person's (or upstream
 *   client's) one-time allow, for this exact path and access, in this turn. A permit is
 *   minted when an agent's own ask touching the path is answered with an allow, so an agent
 *   that asks first is not asked twice; otherwise ORCA asks on the agent's behalf. A permit
 *   is spent by the first call that uses it and dies with the turn, so a duplicate or late
 *   call cannot reuse it, and a cancelled turn refuses before any I/O.
 *
 * What this covers and what it does not: it is the client-owned ACP file path only. An
 * agent's native tools (its own shell, its own file access, an MCP server it connects to by
 * itself) never pass through ORCA and are not covered; keeping an agent to this path is an
 * operating-system boundary's job (ADR 0009). Paths are compared as written, workspace-
 * relative where they can be, like every rule; a symlink inside the roots that leads
 * elsewhere is the roots check's and the protected-path check's concern, not this one's.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { permissionPathForms } from "@orca/core";
import type { PermissionPolicy } from "@orca/core";
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

/** Which file access an answered ask's kind stands for, if any. */
function accessFor(kind: string | null | undefined): FsAccess | undefined {
  if (kind === "read" || kind === "search") return "read";
  if (kind === "edit") return "write";
  return undefined;
}

interface Permit {
  turnId: string;
  access: FsAccess;
  forms: readonly string[];
}

export class OwnedFsGate {
  private permits: Permit[] = [];

  constructor(private readonly cwd: string) {}

  /**
   * Record a one-time allow given to an agent's own ask: one permit per location it named,
   * for the access its kind stands for. Anything but a one-time allow mints nothing.
   */
  mint(turnId: string, toolCall: acp.ToolCallUpdate, chosen: acp.PermissionOptionKind | undefined): void {
    if (chosen !== "allow_once") return;
    const access = accessFor(toolCall.kind);
    if (!access) return;
    for (const location of toolCall.locations ?? [])
      this.permits.push({ turnId, access, forms: permissionPathForms(location.path, this.cwd) });
  }

  /** Spend the permit for this exact access and path in this turn. True when there was one. */
  spend(turnId: string, path: string, access: FsAccess): boolean {
    const forms = permissionPathForms(path, this.cwd);
    const i = this.permits.findIndex(
      (p) => p.turnId === turnId && p.access === access && p.forms.some((f) => forms.includes(f)),
    );
    if (i < 0) return false;
    this.permits.splice(i, 1);
    return true;
  }

  /** Every permit of a turn that has ended. */
  endTurn(turnId: string): void {
    this.permits = this.permits.filter((p) => p.turnId !== turnId);
  }

  /** How many permits are outstanding; for tests. */
  get outstanding(): number {
    return this.permits.length;
  }

  /** The policy's answer for one `fs/*` call, before any permit. */
  decide(policy: PermissionPolicy, path: string, access: FsAccess, ctx: PermissionEvalContext) {
    return decidePermission(policy, { sessionId: "", toolCall: fsToolCall(path, access), options: [] }, ctx);
  }
}
