// @vitest-environment happy-dom
/**
 * The card's own behaviour and the surface's states, mounted without the chrome: the note,
 * a free-text ask, `J`/`K`, `G`, an answer in flight, and the four things the surface can
 * be looking at instead of a list.
 *
 * Mounted through a small host component rather than `renderChrome`, because the feed is
 * the chrome's (`App.tsx` holds it so the title bar can carry the count on every screen) —
 * so a test of the surface alone has to hold it too. That host is four lines and is the
 * whole of what this file knows about the wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NotificationMessage, OpenInputView } from "@orca/protocol";
import type { ConnectionState } from "@orca/design";
import { type JSX } from "react";
import { AttentionSurface } from "../src/attention/attention-surface.js";
import { useAttention } from "../src/attention/use-attention.js";
import { harness, installBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { FIVE_GATES, INPUTS_AS_OF, PERMISSION_ASK } from "./fixtures-inputs.js";
import { AS_OF } from "./fixtures.js";

const teardown: (() => void)[] = [];
let fake: FakeBridge;
let h: Harness;

function Host({
  connection,
  onOpenRun,
}: {
  connection: ConnectionState;
  onOpenRun?: (id: string) => void;
}): JSX.Element {
  const feed = useAttention();
  return <AttentionSurface connection={connection} feed={feed} {...(onOpenRun ? { onOpenRun } : {})} />;
}

/** Put the surface on screen against whatever the bridge is currently answering. */
function renderHost(options: { connection?: ConnectionState; onOpenRun?: (id: string) => void } = {}): void {
  const { Providers } = h;
  render(
    <Providers>
      <Host
        connection={options.connection ?? "live"}
        {...(options.onOpenRun ? { onOpenRun: options.onOpenRun } : {})}
      />
    </Providers>,
  );
}

/** `inputs.list` answering with exactly these, then the surface. */
function mount(
  inputs: readonly OpenInputView[],
  options: { connection?: ConnectionState; onOpenRun?: (id: string) => void } = {},
): void {
  fake.script({
    "inputs.list": (params) => {
      const matching = inputs.filter((i) => params.runId === undefined || i.runId === params.runId);
      return { ok: true, result: { inputs: [...matching], waiting: matching.length, asOf: INPUTS_AS_OF } };
    },
  });
  renderHost(options);
}

beforeEach(() => {
  stubMatchMedia(1440);
  fake = installBridge();
  teardown.push(fake.install());
  h = harness();
  teardown.push(h.dispose);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

describe("answering with a note", () => {
  it("opens the note field on ⇧Enter, says where the note goes, and sends it", async () => {
    mount([FIVE_GATES[0]!]);
    const gate = await screen.findByRole("region", { name: "Ship release 1?" });
    gate.focus();

    expect(within(gate).queryByLabelText("Note")).toBeNull();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter", shiftKey: true });

    const note = within(gate).getByLabelText("Note");
    // #238: `human.answered` has no field for it, so the card must not let a person think
    // the workflow will see it.
    expect(within(gate).getByText(/operator log, not in the run/)).toBeTruthy();
    expect(document.activeElement).toBe(note);

    fireEvent.change(note, { target: { value: "checked with the release manager" } });
    fireEvent.keyDown(note, { key: "Enter" });

    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({
      optionId: "approve",
      note: "checked with the release manager",
    });
  });

  it("submits a written note when ⇧Enter is pressed again rather than reopening the field", async () => {
    mount([FIVE_GATES[0]!]);
    const gate = await screen.findByRole("region", { name: "Ship release 1?" });
    gate.focus();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter", shiftKey: true });
    fireEvent.change(within(gate).getByLabelText("Note"), { target: { value: "on the record" } });

    gate.focus();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter", shiftKey: true });
    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({ note: "on the record" });
  });
});

describe("a question with no options", () => {
  it("takes free text, and will not send an empty answer", async () => {
    const question: OpenInputView = { ...FIVE_GATES[0]!, id: "q-1", question: "Which branch?", options: [] };
    mount([question]);
    const gate = await screen.findByRole("region", { name: "Which branch?" });

    const answer = within(gate).getByRole("button", { name: /^Answer/ });
    expect(answer.getAttribute("aria-disabled")).toBe("true");
    expect(answer.getAttribute("title")).toBe("type an answer first");

    fireEvent.change(within(gate).getByLabelText("Answer"), { target: { value: "release/4" } });
    fireEvent.click(within(gate).getByRole("button", { name: /^Answer/ }));

    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    // The free text *is* the answer, which is what the protocol says of an empty option list.
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({ optionId: "release/4" });
  });
});

describe("moving between cards", () => {
  it("moves with J and K and stops at both ends", async () => {
    mount([FIVE_GATES[0]!, FIVE_GATES[1]!, FIVE_GATES[2]!]);
    const first = await screen.findByRole("region", { name: "Ship release 1?" });
    first.focus();

    fireEvent.keyDown(document.activeElement!, { key: "j", code: "KeyJ" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Ship release 2?");
    fireEvent.keyDown(document.activeElement!, { key: "k", code: "KeyK" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Ship release 1?");
    // The top is the top: `K` on the first card is not a wrap to the last.
    fireEvent.keyDown(document.activeElement!, { key: "k", code: "KeyK" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Ship release 1?");
  });

  it("registers G and opens the run only when there is somewhere to open it", async () => {
    const opened: string[] = [];
    mount([FIVE_GATES[0]!], { onOpenRun: (id) => opened.push(id) });
    const gate = await screen.findByRole("region", { name: "Ship release 1?" });
    gate.focus();

    expect(h.keyboard.list().some((s) => s.scope === "card" && s.key === "G")).toBe(true);
    fireEvent.keyDown(gate, { key: "g", code: "KeyG" });
    expect(opened).toEqual(["run-1"]);
  });
});

describe("an answer in flight", () => {
  it("says so on the control and does not send a second one", async () => {
    mount([FIVE_GATES[0]!]);
    const gate = await screen.findByRole("region", { name: "Ship release 1?" });
    const release = fake.hold("inputs.answer");

    gate.focus();
    fireEvent.keyDown(gate, { key: "Enter", code: "Enter" });
    await screen.findByRole("button", { name: "Answering…" });

    fireEvent.keyDown(gate, { key: "Enter", code: "Enter" });
    const answer = within(gate).getByRole("button", { name: "Answering…" });
    expect(answer.getAttribute("title")).toBe("this answer is still with the daemon");

    release();
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "inputs.answer")).toHaveLength(1));
  });
});

describe("what the surface is looking at", () => {
  it("says it is loading, then says what it could not load, and can be asked again", async () => {
    const release = fake.hold("inputs.list");
    mount([]);
    expect(await screen.findByText("Loading what needs you")).toBeTruthy();
    release();

    cleanup();
    fake.fail("inputs.list", { code: "STORE_UNAVAILABLE", message: "no store here" });
    renderHost();
    expect(await screen.findByText("Could not load the attention list")).toBeTruthy();
    expect(screen.getByText(/STORE_UNAVAILABLE/)).toBeTruthy();

    fake.script({
      "inputs.list": () => ({ ok: true, result: { inputs: [FIVE_GATES[0]!], waiting: 1, asOf: INPUTS_AS_OF } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Ship release 1?" })).toBeTruthy();
  });

  it("calls a daemon that never answered disconnected rather than broken", async () => {
    fake.fail("inputs.list", { code: "AGENT_TRANSPORT", message: "connection refused" });
    renderHost({ connection: "disconnected" });
    expect(await screen.findByText("No daemon to ask")).toBeTruthy();
  });

  it("says the list is last-known when the connection is not live", async () => {
    mount([FIVE_GATES[0]!], { connection: "reconnecting" });
    expect(await screen.findByText(/last the daemon said/)).toBeTruthy();
  });

  it("still shows the gates when the run list will not answer", async () => {
    mount([FIVE_GATES[0]!]);
    fake.fail("runs.list", { code: "STORE_UNAVAILABLE", message: "no run list" });
    // The gates are the thing a person came for; the failures are the other half of the
    // screen and their absence is not a reason to withhold them.
    expect(await screen.findByRole("region", { name: "Ship release 1?" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Failed runs" })).toBeNull();
  });
});

describe("runs that fail while the surface is open", () => {
  const changed = (runId: string, status: string): NotificationMessage => ({
    kind: "notification",
    method: "run.changed",
    params: { subscriptionId: "sub-1", runId, seq: 9, at: AS_OF, status, event: `run.${status}` },
  });

  it("resolves a newly failed run to a row, and drops it when it is re-driven", async () => {
    mount([PERMISSION_ASK]);
    const list = await screen.findByRole("listbox", { name: "Failed runs" });
    expect(within(list).queryByText("Document the rollout")).toBeNull();

    // `run-gate` is a run the failures list has never seen; the notification carries no
    // name, so it takes one `runs.get` to become a row.
    fake.notify(changed("run-gate", "failed"));
    await waitFor(() => expect(fake.calls.some((c) => c.method === "runs.get")).toBe(true));
    expect(await within(list).findByText("Document the rollout")).toBeTruthy();

    fake.notify(changed("run-gate", "running"));
    await waitFor(() => expect(within(list).queryByText("Document the rollout")).toBeNull());
  });

  it("asks once for a run that changes twice before the answer lands", async () => {
    mount([PERMISSION_ASK]);
    await screen.findByRole("listbox", { name: "Failed runs" });
    const release = fake.hold("runs.get");

    fake.notify(changed("run-gate", "failed"));
    fake.notify(changed("run-gate", "failed"));
    release();

    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1));
  });
});

describe("resuming a run from the card", () => {
  it("re-drives it and says what it settled as", async () => {
    mount([FIVE_GATES[0]!]);
    await screen.findByRole("region", { name: "Ship release 1?" });
    fake.script({
      "runs.resume": ({ runId }) => ({
        ok: true,
        result: {
          run: {
            id: runId,
            name: "release 1",
            workflowId: "release",
            workflowVersion: "1",
            status: "succeeded" as const,
            createdAt: AS_OF,
          },
          asOf: AS_OF,
        },
      }),
    });

    const resume = h.keyboard.list().find((s) => s.label.startsWith("Resume the run"))!;
    expect(resume.key).toBeUndefined();
    resume.action();

    await waitFor(() => expect(fake.calls.some((c) => c.method === "runs.resume")).toBe(true));
    // `runs.resume` answers when the run parks again, so the sentence is a settled status.
    expect(await screen.findByText(/succeeded\./)).toBeTruthy();
  });
});
