// @vitest-environment happy-dom
/** #398: composing a draft with the pending correction is explicit, previewed whole, and never a second queue. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RevisionInputCard, type RevisionInputCardProps } from "../src/attention/revision-input-card.js";
import {
  addToDraft,
  composeModes,
  composeRevisionText,
  recordRevisionVersion,
  REVISION_HISTORY_LIMIT,
} from "../src/attention/revision-input-model.js";
import { installBridge } from "./harness.js";

let dispose: () => void;
beforeEach(() => {
  const fake = installBridge();
  dispose = fake.install();
});
afterEach(() => {
  cleanup();
  dispose();
});

const boundary: RevisionInputCardProps["boundary"] = {
  target: { runId: "run", stepRunId: "step", requestId: "input", destinationId: "dest", expectedRevision: "v0" },
  destinationDescription: "Build agent, next attempt",
  capability: {
    actionId: "changes",
    destinationNodeId: "build",
    composition: "replace-revision-slot",
    payload: { kind: "text", maxBytes: 1000 },
  },
};
const slot = { runId: "run", revisionId: "revision", destinationId: "dest", attemptId: "attempt" };
type Pending = NonNullable<RevisionInputCardProps["pending"]>;
const pendingText = (text: string, expectedRevision = "v1", revisionId = "revision"): Pending => ({
  target: { ...slot, revisionId },
  expectedRevision,
  state: "pending",
  payload: { kind: "text", text },
  replacementAllowed: true,
});
function props(pending: Pending | null = pendingText("Keep the retry budget at two.")): RevisionInputCardProps {
  return {
    boundary,
    connectionScope: "workspace:epoch1",
    supported: true,
    ...(pending ? { pending } : {}),
    onRefresh: vi.fn(),
    onReceipt: vi.fn(),
    announce: vi.fn(),
    onSubmit: vi.fn(),
    onReplace: vi.fn<RevisionInputCardProps["onReplace"]>(async (command) => ({
      state: "resolved",
      operationId: "op",
      replayed: false,
      result: {
        revisionId: "revision-2",
        target: boundary.target,
        attemptId: "attempt",
        currentRevisionId: "revision-2",
        expectedRevision: "v2",
        state: command.payload.kind === "text" ? "pending" : "pending",
      },
    })),
  };
}
const draft = () => screen.getByLabelText<HTMLTextAreaElement>("Correction");
const type = (value: string) => fireEvent.change(draft(), { target: { value } });
const preview = () => screen.getByRole("region", { name: "What the agent will receive" });

describe("composition model", () => {
  it("appends after the pending text with one blank line, and replaces with the draft alone", () => {
    const pending = { kind: "text" as const, text: "First note.\n\n" };
    expect(composeRevisionText(pending, "Second note.", "append")).toBe("First note.\n\nSecond note.");
    expect(composeRevisionText(pending, "Second note.", "replace")).toBe("Second note.");
    expect(composeRevisionText(undefined, "Only note.", "append")).toBe("Only note.");
  });
  it("offers append only between two texts; values are replaced, never merged", () => {
    expect(composeModes("text", { kind: "text", text: "a" })).toEqual(["append", "replace"]);
    expect(composeModes("values", { kind: "values", values: { a: 1 } })).toEqual(["replace"]);
    expect(composeModes("text", undefined)).toEqual(["replace"]);
  });
  it("adds history text after the draft rather than over it", () => {
    expect(addToDraft("", "old")).toBe("old");
    expect(addToDraft("mine\n", "old")).toBe("mine\n\nold");
  });
  it("records each version once, newest first, bounded", () => {
    let history = recordRevisionVersion([], pendingText("one", "v1"));
    expect(recordRevisionVersion(history, pendingText("one", "v1"))).toBe(history);
    history = recordRevisionVersion(history, pendingText("two", "v2"));
    expect(history.map((entry) => entry.payload)).toEqual([
      { kind: "text", text: "two" },
      { kind: "text", text: "one" },
    ]);
    expect(recordRevisionVersion(history, { ...pendingText("x", "v3"), payload: undefined })).toBe(history);
    for (let i = 0; i < 20; i += 1) history = recordRevisionVersion(history, pendingText(`n${i}`, `w${i}`));
    expect(history).toHaveLength(REVISION_HISTORY_LIMIT);
  });
});

describe("composing in the card", () => {
  it("appends only when chosen, and shows exactly what the next agent receives before anything is sent", async () => {
    const p = props();
    render(<RevisionInputCard {...p} />);
    // v1 behaviour stays the default: the draft replaces, and the preview says what that removes.
    expect(screen.getByRole("button", { name: "Replace pending" }).getAttribute("aria-pressed")).toBe("true");
    type("Also cover the empty input.");
    fireEvent.click(screen.getByRole("button", { name: "Add after pending" }));
    expect(p.announce).toHaveBeenCalledWith("Your draft will be added after the pending correction.");
    const shown = within(preview()).getByText(/Keep the retry budget at two\.\s+Also cover the empty input\./, {
      selector: "pre",
    });
    expect(shown.textContent).toBe("Keep the retry budget at two.\n\nAlso cover the empty input.");
    // The diff says which lines are new, in words as well as the gutter.
    const changes = within(preview()).getByRole("group", { name: "Changes from the pending correction" });
    expect(changes.textContent).toContain("Added: Also cover the empty input.");
    expect(changes.textContent).not.toContain("Removed:");
    expect(p.onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add to pending correction" }));
    await waitFor(() => expect(p.onReplace).toHaveBeenCalledOnce());
    expect(p.onReplace).toHaveBeenCalledWith(
      {
        target: slot,
        expectedRevision: "v1",
        payload: { kind: "text", text: "Keep the retry budget at two.\n\nAlso cover the empty input." },
      },
      expect.any(String),
    );
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it("replacement is an explicit choice, and its preview shows the pending text being removed", async () => {
    const p = props();
    render(<RevisionInputCard {...p} />);
    type("Use three retries.");
    fireEvent.click(screen.getByRole("button", { name: "Add after pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace pending" }));
    expect(p.announce).toHaveBeenCalledWith("Your draft will replace the pending correction.");
    const changes = within(preview()).getByRole("group", { name: "Changes from the pending correction" });
    expect(changes.textContent).toContain("Removed: Keep the retry budget at two.");
    fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
    await waitFor(() => expect(p.onReplace).toHaveBeenCalledOnce());
    expect(vi.mocked(p.onReplace).mock.calls[0]![0].payload).toEqual({ kind: "text", text: "Use three retries." });
  });

  it("a new composition gets a new intent key; the same one retried keeps its key", async () => {
    const p = props();
    p.onReplace = vi.fn().mockRejectedValue(new Error("lost"));
    render(<RevisionInputCard {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Add after pending" }));
    type("Note.");
    fireEvent.click(screen.getByRole("button", { name: "Add to pending correction" }));
    await screen.findByText(/retry identity are preserved/);
    fireEvent.click(screen.getByRole("button", { name: "Add to pending correction" }));
    await waitFor(() => expect(p.onReplace).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Replace pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
    await waitFor(() => expect(p.onReplace).toHaveBeenCalledTimes(3));
    const keys = vi.mocked(p.onReplace).mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("edits a copy of the current correction as a replacement, without touching the pending one", () => {
    const p = props();
    render(<RevisionInputCard {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Add after pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit a copy of the current correction" }));
    expect(draft().value).toBe("Keep the retry budget at two.");
    expect(screen.getByRole("button", { name: "Replace pending" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(preview()).getByText("Keep the retry budget at two.", { selector: "pre" })).toBeTruthy();
    expect(p.onReplace).not.toHaveBeenCalled();
  });

  it("keeps the draft when another editor's version lands, previews against the newer text, and blocks until reviewed", () => {
    const p = props();
    const view = render(<RevisionInputCard {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Add after pending" }));
    type("My addition.");
    view.rerender(<RevisionInputCard {...p} pending={pendingText("Another client's note.", "v2", "revision-2")} />);
    expect(draft().value).toBe("My addition.");
    expect(within(preview()).getByText(/Another client's note\.\s+My addition\./, { selector: "pre" })).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Add to pending correction" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit);
    expect(p.onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use reviewed correction version" }));
    expect(screen.getByRole("button", { name: "Add to pending correction" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("lists earlier versions read here and copies one into the draft without resubmitting it", () => {
    const p = props();
    const view = render(<RevisionInputCard {...p} />);
    view.rerender(<RevisionInputCard {...p} pending={pendingText("Newer note.", "v2", "revision-2")} />);
    const earlier = screen.getByRole("region", { name: "Earlier corrections" });
    expect(within(earlier).getByText("Keep the retry budget at two.")).toBeTruthy();
    expect(within(earlier).queryByText("Newer note.")).toBeNull();
    type("Draft first.");
    fireEvent.click(within(earlier).getByRole("button", { name: "Add to draft" }));
    expect(draft().value).toBe("Draft first.\n\nKeep the retry budget at two.");
    expect(p.announce).toHaveBeenCalledWith("Earlier correction added to the draft. Nothing is sent until you submit.");
    expect(p.onReplace).not.toHaveBeenCalled();
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it("drops earlier versions when the protected read stops supplying content or the scope changes", () => {
    const p = props();
    const view = render(<RevisionInputCard {...p} />);
    view.rerender(<RevisionInputCard {...p} pending={pendingText("Newer note.", "v2", "revision-2")} />);
    expect(screen.getByRole("region", { name: "Earlier corrections" })).toBeTruthy();
    view.rerender(
      <RevisionInputCard {...p} pending={{ ...pendingText("", "v2", "revision-2"), payload: undefined }} />,
    );
    expect(screen.queryByRole("region", { name: "Earlier corrections" })).toBeNull();
    expect(screen.queryByText("Keep the retry budget at two.")).toBeNull();
    view.rerender(<RevisionInputCard {...p} pending={pendingText("Third.", "v3", "revision-3")} />);
    view.rerender(<RevisionInputCard {...p} pending={pendingText("Fourth.", "v4", "revision-4")} />);
    expect(screen.getByRole("region", { name: "Earlier corrections" })).toBeTruthy();
    view.rerender(
      <RevisionInputCard
        {...p}
        connectionScope="workspace:epoch2"
        pending={pendingText("Fourth.", "v4", "revision-4")}
      />,
    );
    expect(screen.queryByRole("region", { name: "Earlier corrections" })).toBeNull();
  });

  it("delivered corrections cannot be composed onto", () => {
    const p = props({
      ...pendingText("Already sent."),
      state: "delivered",
      replacementAllowed: false,
      unavailableReason: "delivered",
    });
    render(<RevisionInputCard {...p} />);
    type("More.");
    expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("values are replaced whole: no append mode, and invalid JSON blocks submission with its reason", () => {
    const p = props({
      target: slot,
      expectedRevision: "v1",
      state: "pending",
      payload: { kind: "values", values: { maxAttempts: 2 } },
      replacementAllowed: true,
    });
    p.boundary = {
      ...boundary,
      capability: {
        ...boundary.capability,
        payload: { kind: "values", maxBytes: 1000, inputSchema: { type: "object", properties: {} } as never },
      },
    };
    render(<RevisionInputCard {...p} />);
    expect(screen.queryByRole("button", { name: "Add after pending" })).toBeNull();
    type("{");
    const submit = screen.getByRole("button", { name: "Replace pending correction" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.getAttribute("title")).toBe("Enter a JSON object for the correction values.");
    type('{"maxAttempts": 3}');
    expect(within(preview()).getByText(/"maxAttempts": 3/, { selector: "pre.orca-well" })).toBeTruthy();
  });

  it("without a pending correction, the first request is unchanged", () => {
    const p = props(null);
    render(<RevisionInputCard {...p} />);
    type("First.");
    expect(screen.queryByRole("region", { name: "What the agent will receive" })).toBeNull();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeTruthy();
  });
});
