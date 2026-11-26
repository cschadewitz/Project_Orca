/**
 * Codex app-server asks as permission requests ORCA's policy decides (#1159), and the one-time
 * answers that go back. Each ask is mapped into the request shape `resolvePermission` reads
 * today; the route-neutral call shape (#1155, after #1119) replaces this mapping, not the rules.
 *
 * Only one-time answers leave ORCA: `accept`, `decline` or `cancel`, and for a permissions ask
 * nothing (`permissions: {}`, `scope: "turn"`). Never `acceptForSession`, an
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

/**
 * An ask as ORCA's policy sees it, or why ORCA declines it without asking anybody. `effects` are
 * the calls it would make, each decided on its own by the policy: one refused declines the whole
 * ask, which Codex carries out as one. `review` is what a person is shown when the policy asks
 * them: every effect, so the answer covers all of them.
 */
export type CodexAskMapping =
  | { target: CodexAskTarget; effects: acp.RequestPermissionRequest[]; review: acp.RequestPermissionRequest }
  | { target: CodexAskTarget | undefined; refused: string };

/** What a mapping needs beyond the ask itself. */
export interface CodexAskContext {
  /** The changes of the file change item Codex started for the ask, in the same turn. */
  changes?: readonly FileUpdateChange[] | undefined;
}

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

const request = (sessionId: string, toolCall: acp.ToolCallUpdate): acp.RequestPermissionRequest => ({
  sessionId,
  options: CODEX_ASK_OPTIONS,
  toolCall: { status: "pending", ...toolCall },
});

/** One ask's effects, and the review a person sees: the one effect, or all of them as one call. */
function mapped(
  sessionId: string,
  target: CodexAskTarget,
  effects: acp.RequestPermissionRequest[],
  title: string,
  lines: (string | undefined)[],
): CodexAskMapping {
  if (effects.length === 1) {
    const only = effects[0]!;
    const content = text(lines);
    return {
      target,
      effects,
      review: content.length ? { ...only, toolCall: { ...only.toolCall, content } } : only,
    };
  }
  return {
    target,
    effects,
    review: request(sessionId, {
      toolCallId: target.itemId,
      title,
      kind: "other",
      locations: effects.flatMap((e) => e.toolCall.locations ?? []),
      rawInput: { effects: effects.map((e) => ({ kind: e.toolCall.kind, title: e.toolCall.title })) },
      content: text([...lines, ...effects.map((e) => `- ${e.toolCall.title ?? ""}`)]),
    }),
  };
}

function commandAsk(sessionId: string, p: Record<string, unknown>, target: CodexAskTarget): CodexAskMapping {
  const kind = p.kind ?? "command";
  if (kind !== "command" && kind !== "humanCommand" && kind !== "writeStdin")
    return { target, refused: "a command ask of a kind ORCA does not know" };
  // Input to a running terminal, which the ask does not show: no rule about the command decides it.
  if (kind === "writeStdin")
    return { target, refused: "a write to a running terminal, whose input the ask does not show" };
  for (const field of ["command", "cwd", "reason", "approvalId"])
    if (!optionalString(p[field])) return { target, refused: `a command ask whose ${field} is not a string` };
  const actions = actionsProblem(p.commandActions);
  if (actions) return { target, refused: `a command ask with ${actions}` };
  const net = p.networkApprovalContext;
  if (
    net !== undefined &&
    net !== null &&
    !(isObject(net) && typeof net.host === "string" && net.host && typeof net.protocol === "string")
  )
    return { target, refused: "a command ask whose network context ORCA does not know" };
  const command = str(p.command);
  const cwd = str(p.cwd);
  const network = isObject(net) ? { host: net.host as string, protocol: net.protocol as string } : undefined;
  if (!command && !network) return { target, refused: "a command ask that names no command" };
  const actionLines = ((p.commandActions as CommandAction[] | null | undefined) ?? []).map(actionLine);
  const toolCallId = str(p.approvalId) ?? target.itemId;
  const effects: acp.RequestPermissionRequest[] = [];
  if (command)
    effects.push(
      request(sessionId, {
        toolCallId,
        title: command,
        kind: "execute",
        // The command is the call's input, so every command rule decides it whatever its title.
        rawInput: { command, ...(cwd ? { cwd } : {}) },
      }),
    );
  // The network access is an effect of its own: a rule about the command does not decide it.
  if (network)
    effects.push(
      request(sessionId, {
        toolCallId: command ? `${toolCallId}:network` : toolCallId,
        title: `Network access to ${network.host} (${network.protocol})`,
        kind: "fetch",
        rawInput: { url: `${network.protocol}://${network.host}` },
      }),
    );
  return mapped(sessionId, target, effects, command ? `${command}, with network access to ${network?.host}` : "", [
    str(p.reason),
    cwd ? `in ${cwd}` : undefined,
    actionLines.length ? `Codex reads it as: ${actionLines.join("; ")}` : undefined,
  ]);
}

/**
 * One change of a patch as the calls it makes, each with its own semantics: an edit or a
 * deletion; a move is the move itself (its rule, and the removal of both entries) and the write
 * of its destination (edit rules and write protection), each of which must hold.
 */
function changeEffects(sessionId: string, target: CodexAskTarget, c: FileUpdateChange, i: number) {
  const id = `${target.itemId}:${i}`;
  if (c.kind.type === "delete")
    return [
      request(sessionId, { toolCallId: id, title: `Delete ${c.path}`, kind: "delete", locations: [{ path: c.path }] }),
    ];
  if (c.kind.type === "update" && c.kind.move_path)
    return [
      request(sessionId, {
        toolCallId: id,
        title: `Move ${c.path} to ${c.kind.move_path}`,
        kind: "move",
        locations: [{ path: c.path }, { path: c.kind.move_path }],
      }),
      request(sessionId, {
        toolCallId: `${id}:destination`,
        title: `Write ${c.kind.move_path}`,
        kind: "edit",
        locations: [{ path: c.kind.move_path }],
      }),
    ];
  return [
    request(sessionId, {
      toolCallId: id,
      title: `${c.kind.type === "add" ? "Add" : "Edit"} ${c.path}`,
      kind: "edit",
      locations: [{ path: c.path }],
    }),
  ];
}

const changeShape = (c: unknown) =>
  isObject(c) &&
  typeof c.path === "string" &&
  c.path !== "" &&
  isObject(c.kind) &&
  (c.kind.type === "add" || c.kind.type === "delete" || (c.kind.type === "update" && optionalString(c.kind.move_path)));

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
  if (!changes.every(changeShape)) return { target, refused: "a file change ORCA cannot show" };
  const effects = changes.flatMap((c, i) => changeEffects(sessionId, target, c, i));
  return mapped(sessionId, target, effects, `Change ${changes.length} files`, [str(p.reason)]);
}

/**
 * A permissions ask grants network access, or access to whole directories, for the rest of the
 * turn. ORCA's policy decides one call at a time: an allow for one call does not authorize every
 * call such a grant covers, and checking a few paths does not show every descendant is allowed.
 * So it is declined until ORCA has policy for grants with an extent (#1159 review); the calls
 * Codex then makes one by one are each asked about as usual.
 */
function permissionsAsk(target: CodexAskTarget): CodexAskMapping {
  return { target, refused: "a grant for the rest of the turn, which ORCA's one-call policy cannot decide" };
}

/**
 * Codex's ask as the calls ORCA's policy decides, or why ORCA declines it unasked. A file change
 * ask names no file: `ctx.changes` is the file change item Codex started for it.
 */
export function codexAskRequest(
  sessionId: string,
  method: CodexPolicyAsk,
  params: unknown,
  ctx: CodexAskContext = {},
): CodexAskMapping {
  if (!isObject(params)) return { target: undefined, refused: "an ask whose params are not an object" };
  const target = targetOf(params);
  if (!target) return { target: undefined, refused: "an ask without its thread, turn and item" };
  switch (method) {
    case "item/commandExecution/requestApproval":
      return commandAsk(sessionId, params, target);
    case "item/fileChange/requestApproval":
      return fileChangeAsk(sessionId, params, target, ctx.changes);
    case "item/permissions/requestApproval":
      return permissionsAsk(target);
  }
}

/**
 * The response to `method` for `outcome`: only ever a one-time decision. A permissions ask is
 * never granted (see `permissionsAsk`): it gets nothing, for this turn.
 */
export function codexAskResponse(method: CodexPolicyAsk, outcome: CodexAskOutcome): unknown {
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  return { decision: outcome };
}
