/**
 * The #1165 evidence harness's own view of what ORCA and a Codex app-server process send each
 * other (`tapStdio`), and how each ask Codex sent is correlated with ORCA's policy decision and
 * the answer that went back (`correlate`). Methods, ids and outcomes only: no params, config or
 * values are kept.
 *
 * Missing evidence is never read as an outcome: a tap that was not attached, or did not see an
 * exchange, leaves the count `unverified`, not zero; an answer the harness did not see, or could
 * not read, leaves the ask `unverified`; only a known opposite answer fails.
 */
import { createHash } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import type { AgentProcessHandle } from "@orca/agents";

/** ORCA's policy decision for one call, as its `onPermission` callback reported it. */
export interface Decision {
  toolCallId?: string;
  title: string;
  decision: string;
}

/** The asks ORCA's driver answers through its policy, as Codex sends them. */
export const ASK_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

/** One ask Codex sent, read off the wire: identifiers only, never its params' values. */
export interface WireAsk {
  id: string | number;
  method: string;
  itemId: string | null;
  approvalId: string | null;
  approvalKind: string | null;
  /**
   * For an MCP ask, which names no item: the one MCP call item Codex had started and not
   * finished for the same server, tool and arguments (compared by digest), as read on the wire;
   * null when there was none or more than one.
   */
  matchedItem?: string | null;
  /** ORCA's answer as it went back: the decision or action only; null until one is seen. */
  answer: string | null;
}

/**
 * What passed between ORCA and one Codex process, read by the harness at the process's stdio.
 * `attached` is set only once the session took the tapped stdio; `seen` counts the messages
 * read each way, so an empty record from a tap that saw nothing is told apart from one that saw
 * an exchange with no asks.
 */
export interface Wire {
  attached: boolean;
  seen: { fromCodex: number; toCodex: number };
  asks: WireAsk[];
  threadRequests: { method: string; answered: "thread" | "error" | null }[];
  /**
   * Each command item Codex reported, with when (ms since the epoch, by the harness's clock) it
   * reported it started and finished, and the status it finished with; null while unfinished.
   */
  commands: { itemId: string; startedAt: number; completedAt: number | null; status: string | null }[];
  /** Each turn Codex reported finished: when, and the status it gave. */
  turns: { completedAt: number; status: string | null }[];
}

export const newWire = (): Wire => ({
  attached: false,
  seen: { fromCodex: 0, toCodex: 0 },
  asks: [],
  threadRequests: [],
  commands: [],
  turns: [],
});

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Calls `on` with each JSON-RPC message in a line stream; lines that are not JSON are skipped. */
export function eachMessage(stream: Readable, on: (m: Record<string, unknown>) => void) {
  let buffer = "";
  stream.on("data", (d: Buffer) => {
    buffer += d.toString();
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const m = JSON.parse(line) as unknown;
        if (m && typeof m === "object" && !Array.isArray(m)) on(m as Record<string, unknown>);
      } catch {
        // not a message
      }
    }
  });
}

/**
 * Reads one message each way into `wire`: `fromCodex` is what Codex wrote, the rest is what
 * ORCA wrote. Exported for the harness's own unit tests.
 */
export function wireReader(wire: Wire) {
  const threadIds = new Map<string | number, number>();
  /** MCP call items Codex started and has not finished: id -> server, tool, digest of its arguments. */
  const mcpItems = new Map<string, string>();
  const callKey = (server: unknown, tool: unknown, args: unknown) =>
    `${String(server)}\0${String(tool)}\0${sha256(JSON.stringify(args ?? null))}`;
  return {
    fromCodex(m: Record<string, unknown>) {
      wire.seen.fromCodex++;
      const id = m["id"] as string | number | undefined;
      const method = str(m["method"]);
      const params = (m["params"] ?? {}) as Record<string, unknown>;
      const item = params["item"] as
        | { type?: unknown; id?: unknown; status?: unknown; server?: unknown; tool?: unknown; arguments?: unknown }
        | undefined;
      if ((method === "item/started" || method === "item/completed") && item?.type === "commandExecution") {
        const itemId = str(item.id);
        if (itemId === null) return;
        if (method === "item/started")
          wire.commands.push({ itemId, startedAt: Date.now(), completedAt: null, status: null });
        else {
          const command = wire.commands.find((c) => c.itemId === itemId && c.completedAt === null);
          if (command) Object.assign(command, { completedAt: Date.now(), status: str(item.status) });
        }
      } else if (method === "turn/completed") {
        const turn = params["turn"] as { status?: unknown } | undefined;
        wire.turns.push({ completedAt: Date.now(), status: str(turn?.status) });
      } else if (
        (method === "item/started" || method === "item/completed") &&
        item?.type === "mcpToolCall" &&
        typeof item.id === "string"
      ) {
        if (method === "item/started") mcpItems.set(item.id, callKey(item.server, item.tool, item.arguments));
        else mcpItems.delete(item.id);
      } else if (method && id !== undefined && ASK_METHODS.has(method)) {
        const meta = (params["_meta"] ?? {}) as Record<string, unknown>;
        const ask: WireAsk = {
          id,
          method,
          itemId: str(params["itemId"]),
          approvalId: str(params["approvalId"]),
          approvalKind: str(meta["codex_approval_kind"]),
          answer: null,
        };
        if (method === "mcpServer/elicitation/request") {
          const key = callKey(params["serverName"], meta["tool_name"], meta["tool_params"]);
          const matches = [...mcpItems].filter(([, k]) => k === key).map(([itemId]) => itemId);
          ask.matchedItem = matches.length === 1 ? matches[0]! : null;
        }
        wire.asks.push(ask);
      } else if (!method && id !== undefined && threadIds.has(id)) {
        const request = wire.threadRequests[threadIds.get(id)!]!;
        const thread = (m["result"] as { thread?: { id?: unknown } } | undefined)?.thread;
        request.answered = typeof thread?.id === "string" ? "thread" : "error";
      }
    },
    toCodex(m: Record<string, unknown>) {
      wire.seen.toCodex++;
      const id = m["id"] as string | number | undefined;
      const method = str(m["method"]);
      if ((method === "thread/start" || method === "thread/resume") && id !== undefined) {
        threadIds.set(id, wire.threadRequests.length);
        wire.threadRequests.push({ method, answered: null });
      } else if (!method && id !== undefined) {
        const ask = wire.asks.find((a) => a.id === id);
        if (!ask) return;
        const result = m["result"] as { decision?: unknown; action?: unknown; permissions?: unknown } | undefined;
        // Only an explicit decision or action counts as an answer; anything else is unreadable.
        ask.answer =
          str(result?.decision) ??
          str(result?.action) ??
          (result?.permissions !== undefined ? "nothing granted" : m["error"] !== undefined ? "error" : "unreadable");
      }
    },
  };
}

/** Taps a process handle's stdio so the harness reads what ORCA and Codex send each other, unchanged. */
export function tapStdio(handle: AgentProcessHandle, wire: Wire): void {
  const stdio = handle.stdio?.bind(handle);
  // No stdio to tap: `attached` stays false, and the record says the exchange was not observed.
  if (!stdio) return;
  handle.stdio = () => {
    const { stdin, stdout } = stdio();
    const toOrca = new PassThrough();
    const toCodex = new PassThrough();
    const read = wireReader(wire);
    eachMessage(stdout, (m) => read.fromCodex(m));
    eachMessage(toCodex, (m) => read.toCodex(m));
    stdout.pipe(toOrca);
    toCodex.pipe(stdin);
    wire.attached = true;
    return { stdin: toCodex, stdout: toOrca };
  };
}

/** The one answer that carries out each ORCA decision, and the one that contradicts it. */
const EXPECTED: Record<string, { carries: string; contradicts: string[] }> = {
  allow: { carries: "accept", contradicts: ["decline", "cancel"] },
  deny: { carries: "decline", contradicts: ["accept"] },
};

/**
 * Each ask the wires show, with ORCA's policy decision for it and the answer that went back.
 * `failures` are known contradictions (an answer opposite to ORCA's decision); `unverified` is
 * every gap: a process whose exchange the tap did not observe, an ask with no single decision,
 * an answer not seen or not readable, a decision with no ask on the wire.
 */
export function correlate(wires: readonly Wire[], decisions: readonly Decision[], processesStarted = wires.length) {
  const decided = decisions.filter((d) => !d.decision.startsWith("codex:"));
  const asks = wires.flatMap((w) => w.asks);
  const keyOf = (a: WireAsk) => a.approvalId ?? a.itemId ?? a.matchedItem ?? null;
  const failures: string[] = [];
  const unverified: string[] = [];
  const observed = wires.length === processesStarted && wires.every((w) => w.attached && w.seen.fromCodex > 0);
  if (!observed) unverified.push("the harness did not observe every Codex process's exchange");
  const rows = asks.map((a) => {
    const key = keyOf(a);
    const found = decided.filter((d) => key !== null && d.toolCallId === key).map((d) => d.decision);
    const orcaDecision = found.length === 1 ? found[0]! : "unverified";
    let verdict: "carried out" | "contradicted" | "unverified" = "unverified";
    const expected = EXPECTED[orcaDecision];
    if (found.length !== 1)
      unverified.push(`no single ORCA decision correlates with the ask ${String(a.id)} (${a.method})`);
    else if (!expected)
      unverified.push(`ORCA's decision ${orcaDecision} for the ask ${String(a.id)} is not an allow or deny`);
    else if (a.answer === expected.carries) verdict = "carried out";
    else if (a.answer !== null && expected.contradicts.includes(a.answer)) {
      verdict = "contradicted";
      failures.push(`ORCA decided ${orcaDecision} for ${a.method}, but ${a.answer} went back`);
    } else
      unverified.push(
        `the answer to the ask ${String(a.id)} was ${a.answer === null ? "not seen" : a.answer}, not ${expected.carries}`,
      );
    return { ask: a, orcaDecision, verdict };
  });
  for (const d of decided)
    if (!asks.some((a) => keyOf(a) === d.toolCallId))
      unverified.push(`ORCA decided ${d.decision} for ${d.toolCallId ?? "a call"} with no ask seen on the wire`);
  return {
    rows,
    failures,
    unverified,
    observed,
    /** The asks Codex sent, or `unverified` when the harness did not observe every process. */
    askCount: observed ? asks.length : ("unverified" as const),
    asks,
  };
}
