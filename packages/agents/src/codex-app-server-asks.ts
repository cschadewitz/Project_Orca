/**
 * Codex app-server asks as permission requests ORCA's policy decides (#1159), and the one-time
 * answers that go back. Each ask is mapped into the request shape `resolvePermission` reads
 * today; the route-neutral call shape (#1155, after #1119) replaces this mapping, not the rules.
 *
 * Only one-time answers leave ORCA: `accept`, `decline` or `cancel`, and for a permissions ask
 * the requested profile for this turn (`scope: "turn"`) or nothing. Never `acceptForSession`, an
 * exec-policy or network-policy amendment, a session-scoped grant or `strictAutoReview`: Codex
 * would remember those, and later calls would skip ORCA's policy (a rule removed, expired or
 * narrowed would never be consulted again). ORCA's own "always" answers go to its sidecar.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { CommandAction } from "./codex-protocol/0.171.0/v2/CommandAction.js";
import type { FileUpdateChange } from "./codex-protocol/0.171.0/v2/FileUpdateChange.js";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optionalString = (v: unknown) => v === undefined || v === null || typeof v === "string";
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The asks ORCA answers through its policy. */
export const CODEX_POLICY_ASKS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
] as const;
export type CodexPolicyAsk = (typeof CODEX_POLICY_ASKS)[number];
export const isCodexPolicyAsk = (method: string): method is CodexPolicyAsk =>
  (CODEX_POLICY_ASKS as readonly string[]).includes(method);

/** ORCA's answer to one ask, before it is put in the ask's own response shape. */
export type CodexAskOutcome = "accept" | "decline" | "cancel";

/** The one-time choices an ask offers: ORCA's policy picks between them, and so does a person. */
export const CODEX_ASK_OPTIONS: acp.PermissionOption[] = [
  { optionId: "accept", name: "Allow once", kind: "allow_once" },
  { optionId: "decline", name: "Decline", kind: "reject_once" },
];

/** What the ask is about, for matching it to the live turn. */
export interface CodexAskTarget {
  threadId: string;
  turnId: string;
  itemId: string;
}

/** An ask as ORCA's policy sees it, or why ORCA declines it without asking anybody. */
export type CodexAskMapping =
  | { target: CodexAskTarget; request: acp.RequestPermissionRequest }
  | { target: CodexAskTarget | undefined; refused: string };

const text = (lines: (string | undefined)[]): acp.ToolCallContent[] => {
  const body = lines.filter((l): l is string => !!l).join("\n");
  return body ? [{ type: "content", content: { type: "text", text: body } }] : [];
};

/** Codex's parsed actions for a command, as a person reads them. */
function actionLine(a: CommandAction): string {
  switch (a.type) {
    case "read":
      return `read ${a.path}`;
    case "listFiles":
      return `list files${a.path ? ` in ${a.path}` : ""}`;
    case "search":
      return `search${a.query ? ` for ${a.query}` : ""}${a.path ? ` in ${a.path}` : ""}`;
    default:
      return `run ${a.command}`;
  }
}

const actionsProblem = (v: unknown) =>
  v === undefined ||
  v === null ||
  (Array.isArray(v) &&
    v.every(
      (a) =>
        isObject(a) &&
        typeof a.command === "string" &&
        (a.type === "unknown" ||
          (a.type === "read" && typeof a.path === "string" && typeof a.name === "string") ||
          ((a.type === "listFiles" || a.type === "search") && optionalString(a.path) && optionalString(a.query))),
    ))
    ? undefined
    : "parsed command actions ORCA does not know";

const targetOf = (p: Record<string, unknown>): CodexAskTarget | undefined =>
  typeof p.threadId === "string" && typeof p.turnId === "string" && typeof p.itemId === "string"
    ? { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId }
    : undefined;

function commandAsk(sessionId: string, p: Record<string, unknown>, target: CodexAskTarget): CodexAskMapping {
  const kind = p.kind ?? "command";
  if (kind !== "command" && kind !== "humanCommand" && kind !== "writeStdin")
    return { target, refused: "a command ask of a kind ORCA does not know" };
  for (const field of ["command", "cwd", "reason", "approvalId"])
    if (!optionalString(p[field])) return { target, refused: `a command ask whose ${field} is not a string` };
  const actions = actionsProblem(p.commandActions);
  if (actions) return { target, refused: `a command ask with ${actions}` };
  const net = p.networkApprovalContext;
  if (
    net !== undefined &&
    net !== null &&
    !(isObject(net) && typeof net.host === "string" && typeof net.protocol === "string")
  )
    return { target, refused: "a command ask whose network context ORCA does not know" };
  const command = str(p.command);
  const cwd = str(p.cwd);
  const network = isObject(net) ? { host: net.host as string, protocol: net.protocol as string } : undefined;
  const actionLines = ((p.commandActions as CommandAction[] | null | undefined) ?? []).map(actionLine);
  const toolCallId = str(p.approvalId) ?? target.itemId;
  // A network ask for a command: the host is what is being asked about.
  if (network && !command)
    return {
      target,
      request: {
        sessionId,
        options: CODEX_ASK_OPTIONS,
        toolCall: {
          toolCallId,
          title: `Network access to ${network.host} (${network.protocol})`,
          kind: "fetch",
          status: "pending",
          rawInput: { url: `${network.protocol}://${network.host}`, ...(cwd ? { cwd } : {}) },
          content: text([str(p.reason), cwd ? `in ${cwd}` : undefined]),
        },
      },
    };
  const stdin = kind === "writeStdin";
  return {
    target,
    request: {
      sessionId,
      options: CODEX_ASK_OPTIONS,
      toolCall: {
        toolCallId,
        title: stdin ? `Write to the terminal of ${command ?? "a running command"}` : (command ?? "Run a command"),
        kind: "execute",
        status: "pending",
        // The command is the call's input, so every command rule decides it whatever its title.
        rawInput: { command: command ?? "", ...(cwd ? { cwd } : {}), ...(stdin ? { stdin: true } : {}) },
        content: text([
          str(p.reason),
          cwd ? `in ${cwd}` : undefined,
          actionLines.length ? `Codex reads it as: ${actionLines.join("; ")}` : undefined,
          network ? `with network access to ${network.host} (${network.protocol})` : undefined,
        ]),
      },
    },
  };
}

function fileChangeAsk(
  sessionId: string,
  p: Record<string, unknown>,
  target: CodexAskTarget,
  changes: readonly FileUpdateChange[] | undefined,
): CodexAskMapping {
  if (!optionalString(p.reason) || !optionalString(p.grantRoot))
    return { target, refused: "a file change ask whose reason or root is not a string" };
  // A write root for the rest of the session is a standing grant: ORCA answers each change.
  if (str(p.grantRoot)) return { target, refused: "a file change ask for a write root for the rest of the session" };
  // The ask itself names no file: the change it is about is the item Codex started for it.
  if (!changes || changes.length === 0) return { target, refused: "a file change ask for no change ORCA was shown" };
  const paths = changes.flatMap((c) => [
    c.path,
    ...(c.kind.type === "update" && c.kind.move_path ? [c.kind.move_path] : []),
  ]);
  const kind: acp.ToolKind = changes.some((c) => c.kind.type === "update" && c.kind.move_path)
    ? "move"
    : changes.every((c) => c.kind.type === "delete")
      ? "delete"
      : "edit";
  const verb = (c: FileUpdateChange) =>
    c.kind.type === "add"
      ? `add ${c.path}`
      : c.kind.type === "delete"
        ? `delete ${c.path}`
        : c.kind.move_path
          ? `move ${c.path} to ${c.kind.move_path}`
          : `edit ${c.path}`;
  return {
    target,
    request: {
      sessionId,
      options: CODEX_ASK_OPTIONS,
      toolCall: {
        toolCallId: target.itemId,
        title: changes.length === 1 ? verb(changes[0]!) : `Change ${changes.length} files`,
        kind,
        status: "pending",
        locations: paths.map((path) => ({ path })),
        rawInput: { changes: changes.map((c) => ({ path: c.path, kind: c.kind })) },
        content: text([str(p.reason), changes.length > 1 ? changes.map(verb).join("\n") : undefined]),
      },
    },
  };
}

const pathList = (v: unknown): string[] | undefined =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;

function permissionsAsk(sessionId: string, p: Record<string, unknown>, target: CodexAskTarget): CodexAskMapping {
  if (!optionalString(p.reason) || !optionalString(p.cwd))
    return { target, refused: "a permissions ask whose reason or directory is not a string" };
  const profile = p.permissions;
  if (!isObject(profile)) return { target, refused: "a permissions ask without the permissions it asks for" };
  const network = profile.network;
  const fs = profile.fileSystem;
  if (network !== undefined && network !== null && !(isObject(network) && optionalBoolean(network.enabled)))
    return { target, refused: "a permissions ask whose network permission ORCA does not know" };
  let read: string[] = [];
  let write: string[] = [];
  if (fs !== undefined && fs !== null) {
    if (!isObject(fs)) return { target, refused: "a permissions ask whose file permissions ORCA does not know" };
    // Entries are a richer form ORCA does not decide yet: a grant it cannot show is not made.
    if (fs.entries !== undefined && !(Array.isArray(fs.entries) && fs.entries.length === 0))
      return { target, refused: "a permissions ask with file system entries ORCA cannot show" };
    const r = pathList(fs.read);
    const w = pathList(fs.write);
    if (!r || !w) return { target, refused: "a permissions ask whose paths are not strings" };
    read = r;
    write = w;
  }
  const wantsNetwork = isObject(network) && network.enabled === true;
  if (!wantsNetwork && read.length === 0 && write.length === 0)
    return { target, refused: "a permissions ask for nothing ORCA can show" };
  const parts = [
    wantsNetwork ? "network access" : undefined,
    write.length ? `write access to ${write.join(", ")}` : undefined,
    read.length ? `read access to ${read.join(", ")}` : undefined,
  ].filter((x): x is string => !!x);
  return {
    target,
    request: {
      sessionId,
      options: CODEX_ASK_OPTIONS,
      toolCall: {
        toolCallId: target.itemId,
        title: `Codex asks for ${parts.join(" and ")} for this turn`,
        // Not a kind any allow rule is written for: a rule naming no kind, or a person, decides it.
        kind: "other",
        status: "pending",
        locations: [...write, ...read].map((path) => ({ path })),
        rawInput: { permissions: { network: wantsNetwork, read, write }, ...(str(p.cwd) ? { cwd: p.cwd } : {}) },
        content: text([str(p.reason), str(p.cwd) ? `in ${p.cwd as string}` : undefined]),
      },
    },
  };
}

const optionalBoolean = (v: unknown) => v === undefined || v === null || typeof v === "boolean";

/**
 * Codex's ask as a permission request for ORCA's policy, or why ORCA declines it unasked. A
 * file change ask names no file: `changes` is the file change item Codex started for it.
 */
export function codexAskRequest(
  sessionId: string,
  method: CodexPolicyAsk,
  params: unknown,
  changes?: readonly FileUpdateChange[],
): CodexAskMapping {
  if (!isObject(params)) return { target: undefined, refused: "an ask whose params are not an object" };
  const target = targetOf(params);
  if (!target) return { target: undefined, refused: "an ask without its thread, turn and item" };
  switch (method) {
    case "item/commandExecution/requestApproval":
      return commandAsk(sessionId, params, target);
    case "item/fileChange/requestApproval":
      return fileChangeAsk(sessionId, params, target, changes);
    case "item/permissions/requestApproval":
      return permissionsAsk(sessionId, params, target);
  }
}

/**
 * The response to `method` for `outcome`. Only ever a one-time decision: a permissions ask is
 * granted what it asked for, for this turn, or nothing.
 */
export function codexAskResponse(method: CodexPolicyAsk, outcome: CodexAskOutcome, params?: unknown): unknown {
  if (method !== "item/permissions/requestApproval") return { decision: outcome };
  if (outcome !== "accept") return { permissions: {}, scope: "turn" };
  const profile = isObject(params) && isObject(params.permissions) ? params.permissions : {};
  const granted: Record<string, unknown> = {};
  if (isObject(profile.network) && profile.network.enabled === true) granted.network = { enabled: true };
  if (isObject(profile.fileSystem)) {
    const fs = profile.fileSystem;
    granted.fileSystem = { read: pathList(fs.read) ?? [], write: pathList(fs.write) ?? [] };
  }
  return { permissions: granted, scope: "turn" };
}
