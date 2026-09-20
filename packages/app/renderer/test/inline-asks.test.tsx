// @vitest-environment happy-dom
/**
 * The card's second mounting: a step parked on a gate draws the same card the Attention
 * list does, inline in the run it came from (#161, #158).
 *
 * What the integration commit had to make true is that it is *the same* card over *the same*
 * feed — not a second read of `inputs.list` and not a second opinion about the one count. So
 * the assertions here are about identity as much as appearance: one read, the card's own
 * controls, and the answer going out as `inputs.answer` for that ask's id.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type JSX } from "react";
import { InlineAsksProvider, StepAsks } from "../src/attention/inline-asks.js";
import { useAttention } from "../src/attention/use-attention.js";
import { harness, installBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { INPUTS_AS_OF, PERMISSION_ASK } from "./fixtures-inputs.js";

const teardown: (() => void)[] = [];
let fake: FakeBridge;
let h: Harness;

function Host({ stepRunId }: { stepRunId: string }): JSX.Element {
  const feed = useAttention();
  return (
    <InlineAsksProvider feed={feed}>
      <StepAsks runId={PERMISSION_ASK.runId} stepRunId={stepRunId} />
    </InlineAsksProvider>
  );
}

function mount(stepRunId: string): void {
  fake.script({
    "inputs.list": () => ({ ok: true, result: { inputs: [PERMISSION_ASK], waiting: 1, asOf: INPUTS_AS_OF } }),
  });
  const { Providers } = h;
  render(
    <Providers>
      <Host stepRunId={stepRunId} />
    </Providers>,
  );
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

describe("a card inline in the run it came from", () => {
  it("draws the ask on the step that is parked on it, and answers it by id", async () => {
    mount(PERMISSION_ASK.stepRunId);

    const card = await screen.findByRole("region", { name: "Run a shell command?" });
    // The permission card's own three properties, unchanged by the mounting: the subject
    // verbatim, who is blocked, and the options.
    expect(card.textContent).toContain("rm -rf build/");
    expect(card.textContent).toContain("claude");

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === "inputs.answer")).toBe(true));
    expect(fake.calls.find((c) => c.method === "inputs.answer")?.params).toMatchObject({
      requestId: PERMISSION_ASK.id,
      optionId: "allow",
    });
  });

  it("draws nothing on a step nothing is waiting on, and reads the list once either way", async () => {
    mount("s-some-other-step");

    await waitFor(() => expect(fake.calls.filter((c) => c.method === "inputs.list").length).toBe(1));
    expect(screen.queryByRole("region", { name: "Run a shell command?" })).toBeNull();
  });
});
