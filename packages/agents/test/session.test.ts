/**
 * `summarizeUpdate` is where an ACP update becomes a line of the event log, so it
 * is also where a tool call's args and result are capped. Capping here and not on
 * read is what makes replay deterministic: the bound that applied is the one the
 * writer was built with, and it is recorded rather than re-derived.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { summarizeUpdate } from "@orca/agents";
import { toolBodyTruncated, TOOL_BODY_MAX_CHARS } from "@orca/core";

const toolCall = (over: Partial<acp.ToolCall> = {}): acp.SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: "tc_1",
  title: "Read src/index.ts",
  kind: "read",
  status: "completed",
  ...over,
});

describe("summarizeUpdate", () => {
  it("keeps the tool call's args and result", () => {
    const s = summarizeUpdate(toolCall({ rawInput: { path: "src/index.ts" }, rawOutput: { lines: 12 } }));
    expect(s.args).toEqual({ text: '{"path":"src/index.ts"}', length: 23 });
    expect(s.result).toEqual({ text: '{"lines":12}', length: 12 });
  });

  it("caps a file-sized result at write time and records the length it had", () => {
    const file = "l".repeat(48_000);
    const s = summarizeUpdate(toolCall({ rawInput: { path: "big.txt" }, rawOutput: file }));
    expect(s.result?.text).toHaveLength(TOOL_BODY_MAX_CHARS);
    expect(s.result?.length).toBe(48_000);
    expect(toolBodyTruncated(s.result!)).toBe(true);
    // The file is not in the event log; the fact that it was 48,000 characters is.
    expect(JSON.stringify(s).length).toBeLessThan(3_000);
  });

  it("falls back to the content an agent renders when it sends no rawOutput", () => {
    const s = summarizeUpdate(
      toolCall({ content: [{ type: "content", content: { type: "text", text: "12 lines" } }] }),
    );
    expect(s.result?.text).toContain("12 lines");
  });

  it("leaves a tool call with neither nothing to expand", () => {
    const s = summarizeUpdate(toolCall());
    expect(s.toolCallId).toBe("tc_1");
    expect(s.args).toBeUndefined();
    expect(s.result).toBeUndefined();
  });

  it("carries a body onto a tool_call_update too, since that is where a result arrives", () => {
    const s = summarizeUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_1",
      status: "completed",
      rawOutput: { ok: true },
    });
    expect(s.kind).toBe("tool_call_update");
    expect(s.result).toEqual({ text: '{"ok":true}', length: 11 });
  });

  it("puts no body on an update that is not a tool call", () => {
    const s = summarizeUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
    expect(s).toEqual({ kind: "agent_message_chunk", text: "hello" });
  });
});
