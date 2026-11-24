// @vitest-environment happy-dom
/**
 * The judge's note from producer to card (#701 review): the real read and MCP lanes overturn a favourable verdict
 * (`changed-since`), `askJudgeNote` makes the ask's `context.judge` from it exactly as the engine does, and the
 * permission card shows it without repeating the stale "your rule covers this" or naming the rule.
 *
 * The app imports only `@orca/protocol` and `@orca/design` (ADR 0008). This test reaches the agents' and core's
 * sources by path on purpose, as a contract check across the wire, the way other renderer tests reach protocol sources: nothing
 * under `renderer/src` does.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { JudgeAskNoteSchema } from "@orca/protocol";
import { askJudgeNote, judgedLane, judgedMcpLane } from "../../../agents/src/judged-lane.js";
import {
  explainPermission,
  loadEffectivePermissionPolicy,
  type PermissionEvalContext,
} from "../../../agents/src/permissions.js";
import type { JudgePermission } from "../../../agents/src/review-judge/plain-rule.js";
import { AgentSpecSchema } from "../../../core/src/model/agent.js";
import { PermissionCard } from "../src/attention/permission-card.js";
import { PERMISSION_ASK } from "./fixtures-inputs.js";
import { harness, type Harness } from "./harness.js";

type PermissionPolicy = Awaited<ReturnType<typeof loadEffectivePermissionPolicy>>;
type PermissionRequest = Parameters<typeof explainPermission>[1];

let ws: string;
let ctx: PermissionEvalContext;
let h: Harness | undefined;
beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), "orca-judge-note-")));
  await mkdir(join(ws, "src"));
  await writeFile(join(ws, "src", "a.ts"), "export {};\n");
  ctx = { workspaceCwd: ws, protectedPaths: { readOnly: [], noAccess: [] } };
});
afterEach(async () => {
  cleanup();
  h?.dispose();
  h = undefined;
  await rm(ws, { recursive: true, force: true });
});

async function policyOf(rules: unknown[]): Promise<PermissionPolicy> {
  return loadEffectivePermissionPolicy(
    AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask", rules } }),
    [],
  );
}

/** A judge that says the first rule covers the call. */
const covering = vi.fn<JudgePermission>(async (input) => ({
  outcome: "allow",
  verdict: "covered",
  ruleId: input.rules[0]!.ruleId,
  ruleRevision: input.rules[0]!.ruleRevision,
  reasonCode: "matches-criterion",
  verdicts: [],
  judgeConfigRef: "judge-ref",
}));

/** The ask's context as the engine builds it, rendered on the card. */
function showAsk(judged: Parameters<typeof askJudgeNote>[0]) {
  const context = { toolCall: { toolCallId: "t" }, judge: askJudgeNote(judged) };
  h = harness();
  const H = h;
  render(
    <H.Providers>
      <PermissionCard input={{ ...PERMISSION_ASK, context }} placement="inbox" onAnswer={vi.fn()} />
    </H.Providers>,
  );
  return context.judge;
}

function expectChangedSinceCard() {
  const note = screen.getByRole("note", { name: "Plain-language rule judge" });
  expect(note.textContent).toContain("The judge's answer no longer applies");
  expect(note.textContent).not.toContain("Your rule covers this");
  expect(note.textContent).not.toContain("Rule ");
}

it("read lane: a covered verdict overturned by an edited rule reaches the card as changed-since", async () => {
  const policy = await policyOf([
    { match: { kind: "read", scope: "workspace" }, judge: { criterion: "Reading source." } },
  ]);
  const edited = await policyOf([
    { match: { kind: "read", scope: "workspace" }, judge: { criterion: "Reading tests only." } },
  ]);
  const file = join(ws, "src", "a.ts");
  const request: PermissionRequest = {
    sessionId: "s",
    toolCall: { toolCallId: "t", kind: "read", title: `read ${file}`, locations: [{ path: file }] },
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
  };
  const lane = judgedLane({ judge: covering, reload: async () => edited, localHost: true });
  const explained = await lane(policy, request, ctx, new AbortController().signal);
  expect(explained.decision).toBe("ask");
  // The lane keeps the judge's own reason and rule for the record; the note does not.
  expect(explained.judged).toMatchObject({ verdict: "changed-since", reasonCode: "matches-criterion" });
  const note = showAsk(explained.judged!);
  expect(note).toEqual({ verdict: "changed-since" });
  expect(JudgeAskNoteSchema.parse(note)).toEqual(note);
  expectChangedSinceCard();
});

it("MCP lane: a covered verdict overturned by a new restriction reaches the card as changed-since", async () => {
  const rule = { match: {}, mcp: { server: "notes", tool: "search" }, judge: { criterion: "Searching notes." } };
  const policy = await policyOf([rule]);
  const restricted = await policyOf([rule, { match: { titlePattern: "^notes: search$" }, decision: "ask" }]);
  const request: PermissionRequest = {
    sessionId: "s",
    toolCall: { toolCallId: "", title: "notes: search", kind: "other", locations: [], rawInput: {} },
    options: [],
  };
  const lane = judgedMcpLane({
    judge: covering,
    reload: async () => restricted,
    explain: (p) => explainPermission(p, request, ctx),
    redact: (text) => text,
  });
  const out = await lane(
    policy,
    { server: "notes", tool: "search", arguments: {}, request, ctx },
    new AbortController().signal,
  );
  expect(out).toMatchObject({ allowed: false, judged: { kind: "mcp", verdict: "changed-since" } });
  const note = showAsk(out.judged!);
  expect(note).toEqual({ verdict: "changed-since", kind: "mcp" });
  expect(JudgeAskNoteSchema.parse(note)).toEqual(note);
  expectChangedSinceCard();
});
