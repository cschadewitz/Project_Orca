/**
 * The two event payloads #220 changed, and the one promise that change had to keep:
 * a log written before it still reads.
 *
 * `packages/store/test/old-store-replay.test.ts` is the same promise tested end to
 * end, against a `.jsonl` file on disk. This file is the schema's own arithmetic -
 * where the cap falls, and what a bare string becomes.
 */
import { describe, expect, it } from "vitest";
import {
  OrcaEventSchema,
  reduceRun,
  toGateOption,
  toolBodyTruncated,
  toolCallBody,
  TOOL_BODY_MAX_CHARS,
  type OrcaEvent,
} from "@orca/core";

const parse = (type: string, payload: unknown, seq = 0): OrcaEvent =>
  OrcaEventSchema.parse({
    id: `evt_${seq}`,
    seq,
    runId: "run_1",
    at: "2026-01-01T00:00:00.000Z",
    type,
    payload,
  });

describe("tool call bodies", () => {
  it("stores a short body whole, and says it was not cut", () => {
    const body = toolCallBody({ path: "README.md" });
    expect(body).toEqual({ text: '{"path":"README.md"}', length: 20 });
    expect(toolBodyTruncated(body!)).toBe(false);
  });

  it("passes a string through rather than JSON-quoting it", () => {
    expect(toolCallBody("ok")).toEqual({ text: "ok", length: 2 });
  });

  it("keeps a body exactly at the cap whole", () => {
    const body = toolCallBody("x".repeat(TOOL_BODY_MAX_CHARS))!;
    expect(TOOL_BODY_MAX_CHARS).toBe(2000);
    expect(body.text).toHaveLength(2000);
    expect(body.length).toBe(2000);
    expect(toolBodyTruncated(body)).toBe(false);
  });

  it("cuts one character over the cap, and records the length it had", () => {
    const body = toolCallBody("x".repeat(TOOL_BODY_MAX_CHARS + 1))!;
    expect(body.text).toHaveLength(2000);
    expect(body.length).toBe(2001);
    expect(toolBodyTruncated(body)).toBe(true);
  });

  it("records the whole length of a file-sized body, not the capped one", () => {
    // The case the cap exists for: a `read` tool call over a large file.
    const body = toolCallBody("f".repeat(48_000))!;
    expect(body.text).toHaveLength(2000);
    expect(body.length).toBe(48_000);
    // A reader can say "this was 48,000 characters, you are seeing 2,000" from the record alone.
    expect(body.length - body.text.length).toBe(46_000);
  });

  it("has nothing to store for an absent, empty or uncodable body", () => {
    expect(toolCallBody(undefined)).toBeUndefined();
    expect(toolCallBody(null)).toBeUndefined();
    expect(toolCallBody("")).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolCallBody(cyclic)).toBeUndefined();
    expect(toolCallBody(() => 1)).toBeUndefined();
  });

  it("survives a round trip through the event schema", () => {
    const update = {
      kind: "tool_call",
      toolCallId: "tc_1",
      title: "Read README.md",
      args: toolCallBody({ path: "README.md" }),
      result: toolCallBody("r".repeat(5_000)),
    };
    const e = parse("agent.update", { stepRunId: "s_1", sessionId: "sess_1", update });
    expect(e.type).toBe("agent.update");
    const summary = (e as Extract<OrcaEvent, { type: "agent.update" }>).payload.update;
    expect(summary.args).toEqual({ text: '{"path":"README.md"}', length: 20 });
    expect(summary.result?.text).toHaveLength(2000);
    expect(summary.result?.length).toBe(5_000);
  });
});

describe("gate options", () => {
  it("reads a bare string as an option that is its own id and its own label", () => {
    expect(toGateOption("ship")).toEqual({ id: "ship", label: "ship" });
  });

  it("leaves an option that is already one alone", () => {
    const option = { id: "hold", label: "Hold the rollout", consequence: "Nothing ships today.", destructive: false };
    expect(toGateOption(option)).toEqual(option);
  });

  it("carries a consequence clause and the destructive flag through the event schema", () => {
    const e = parse("human.requested", {
      stepRunId: "s_1",
      requestId: "hi_1",
      kind: "decision",
      question: "Ship the rollout?",
      options: [
        { id: "ship", label: "Ship it", consequence: "Goes to every user in production." },
        { id: "revert", label: "Revert", consequence: "Drops the release branch.", destructive: true },
      ],
      context: {},
    });
    const options = (e as Extract<OrcaEvent, { type: "human.requested" }>).payload.options;
    expect(options[0]?.consequence).toBe("Goes to every user in production.");
    expect(options[1]?.destructive).toBe(true);
    // Nothing in wave zero produces these, but both have to be expressible: #161 needs them.
    expect(options[0]?.destructive).toBeUndefined();
  });

  it("refuses an option with no id, because the answer would have nothing to be", () => {
    expect(() =>
      parse("human.requested", {
        stepRunId: "s_1",
        requestId: "hi_1",
        kind: "decision",
        question: "?",
        options: [{ id: "", label: "Ship it" }],
        context: {},
      }),
    ).toThrow();
  });
});

describe("an event log written before v0.4.0", () => {
  /** Exactly the lines a pre-#220 ORCA wrote: bare string options, a summary with no bodies. */
  const OLD_LOG = [
    ["run.created", { workflowId: "gated", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }],
    ["run.started", {}],
    ["step.scheduled", { stepRunId: "s_gate", nodeId: "gate", nodeType: "gate", attempt: 1 }],
    ["step.started", { stepRunId: "s_gate", inputArtifactIds: [] }],
    [
      "agent.update",
      {
        stepRunId: "s_gate",
        sessionId: "sess_1",
        update: { kind: "tool_call", toolCallId: "tc_1", title: "Read README.md", status: "completed" },
      },
    ],
    [
      "human.requested",
      {
        stepRunId: "s_gate",
        requestId: "hi_1",
        kind: "decision",
        question: "Ship it?",
        options: ["ship", "hold"],
        context: {},
      },
    ],
    ["step.waiting", { stepRunId: "s_gate", on: "human-input", detail: "hi_1" }],
    ["run.paused", { reason: "human input" }],
    ["human.answered", { stepRunId: "s_gate", requestId: "hi_1", answer: "ship" }],
  ] as const;

  const replay = () => reduceRun(OLD_LOG.map(([type, payload], i) => parse(type, payload, i)));

  it("replays a bare-string option as an option that is its own id and label", () => {
    const request = replay().humanInputs.hi_1;
    expect(request?.options).toEqual([
      { id: "ship", label: "ship" },
      { id: "hold", label: "hold" },
    ]);
  });

  it("keeps the answer already recorded against it matching an option's id", () => {
    const request = replay().humanInputs.hi_1!;
    expect(request.answer).toBe("ship");
    // The whole point of keying the answer on the id: an answer written years ago still resolves.
    expect(request.options.map((o) => o.id)).toContain(request.answer);
  });

  it("replays a tool call that has no body as a tool call with nothing to expand", () => {
    const e = parse("agent.update", OLD_LOG[4][1], 4) as Extract<OrcaEvent, { type: "agent.update" }>;
    expect(e.payload.update.title).toBe("Read README.md");
    expect(e.payload.update.args).toBeUndefined();
    expect(e.payload.update.result).toBeUndefined();
  });

  it("replays the run itself unchanged", () => {
    const state = replay();
    expect(state.run.status).toBe("paused");
    expect(state.steps.s_gate?.waitingOn).toBe("human-input");
    expect(state.lastSeq).toBe(8);
  });
});

describe("agent.permission's rule record (#702)", () => {
  it("keeps the basis and rule provenance, and drops a sidecar revision a writer sends", () => {
    const e = parse("agent.permission", {
      stepRunId: "s",
      sessionId: "x",
      title: "Write a.ts",
      decision: "deny",
      rule: { basis: "rule", layer: "sidecar", index: 2, file: 0, revision: "ab".repeat(32) },
    });
    if (e.type !== "agent.permission") throw new Error("wrong type");
    expect(e.payload.rule).toEqual({ basis: "rule", layer: "sidecar", index: 2, file: 0 });
    expect(JSON.stringify(e)).not.toContain("abab");
  });
});
