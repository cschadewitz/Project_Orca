// @vitest-environment happy-dom
/** Real correction card: explicit action, pending preview, retry identity, stale edits and connection changes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RevisionInputCard, type RevisionInputCardProps } from "../src/attention/revision-input-card.js";
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
function props(): RevisionInputCardProps {
  return {
    boundary,
    connectionScope: "workspace:epoch1",
    supported: true,
    onRefresh: vi.fn(),
    onReceipt: vi.fn(),
    announce: vi.fn(),
    onSubmit: vi.fn<RevisionInputCardProps["onSubmit"]>(async () => ({
      state: "resolved",
      operationId: "op",
      replayed: false,
      result: {
        revisionId: "revision",
        target: boundary.target,
        attemptId: "attempt",
        currentRevisionId: "revision",
        expectedRevision: "v1",
        state: "pending",
      },
    })),
    onReplace: vi.fn(),
  };
}
it("previews the destination and submits only the explicit action", async () => {
  const p = props();
  render(<RevisionInputCard {...p} />);
  expect(screen.getByText(/Destination: Build agent/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText<HTMLTextAreaElement>("Correction"), {
    target: { value: "Fix the validation" },
  });
  expect(p.onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(p.onSubmit).toHaveBeenCalledOnce());
  expect(p.onSubmit).toHaveBeenCalledWith(
    { target: boundary.target, actionId: "changes", payload: { kind: "text", text: "Fix the validation" } },
    expect.any(String),
  );
  await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe(""));
});
it("retains the draft and same intent key on recoverable response loss", async () => {
  const p = props();
  p.onSubmit = vi.fn().mockRejectedValue(new Error("lost response"));
  render(<RevisionInputCard {...p} />);
  fireEvent.change(screen.getByLabelText<HTMLTextAreaElement>("Correction"), { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await screen.findByText(/draft and retry identity are preserved/);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(p.onSubmit).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(p.onSubmit).mock.calls;
  expect(calls[0]![1]).toBe(calls[1]![1]);
});
it("shows pending text before replacement and preserves stale drafts until explicit review", async () => {
  const p = props();
  p.pending = {
    target: { runId: "run", revisionId: "revision", destinationId: "dest", attemptId: "attempt" },
    expectedRevision: "v1",
    state: "pending",
    payload: { kind: "text", text: "Current correction" },
    replacementAllowed: true,
  };
  p.onReplace = vi.fn().mockRejectedValue({ code: "REVISION_STALE" });
  const view = render(<RevisionInputCard {...p} />);
  expect(screen.getByText("Current correction", { selector: "pre" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText<HTMLTextAreaElement>("Correction"), { target: { value: "New correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
  await screen.findByText(/Your draft is preserved/);
  expect(p.onSubmit).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("New correction");
  view.rerender(
    <RevisionInputCard
      {...p}
      pending={{ ...p.pending, expectedRevision: "v2", payload: { kind: "text", text: "Another client's correction" } }}
    />,
  );
  expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Use reviewed correction version" }));
  expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBeNull();
});
it.each(["delivered", "rejected", "superseded", "pending"] as const)(
  "shows %s history without inventing a run status",
  (state) => {
    const p = props();
    p.pending = {
      target: { runId: "run", revisionId: "revision", destinationId: "dest", attemptId: "attempt" },
      expectedRevision: "v1",
      state,
      replacementAllowed: false,
      unavailableReason:
        state === "pending"
          ? "delivery-uncertain"
          : state === "delivered"
            ? "delivered"
            : state === "rejected"
              ? "cancelled"
              : "target-changed",
    };
    render(<RevisionInputCard {...p} />);
    expect(screen.getByText(state[0]!.toUpperCase() + state.slice(1))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  },
);
it("connection changes never move an existing draft or accept late completion", async () => {
  const p = props();
  let finish!: (value: Awaited<ReturnType<typeof p.onSubmit>>) => void;
  p.onSubmit = vi.fn<RevisionInputCardProps["onSubmit"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<RevisionInputCard {...p} />);
  fireEvent.change(screen.getByLabelText<HTMLTextAreaElement>("Correction"), {
    target: { value: "Old workspace draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  view.rerender(<RevisionInputCard {...p} connectionScope="another-workspace:epoch2" />);
  finish({ state: "in-progress", operationId: "op", recovery: "inspect-or-retry" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Request changes" }).getAttribute("aria-disabled")).toBe("true"),
  );
  expect(p.onReceipt).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("Old workspace draft");
});
