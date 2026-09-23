// @vitest-environment happy-dom
/**
 * The decision mode of Plan (#173): the weighted matrix, the recommended column, deciding
 * from the table and from the palette, and reopening.
 *
 * The issue's "done when" is that deciding from the app produces the same journal entry as
 * the CLI and that reopening never silently re-decides. The journal entry is the daemon's
 * (`plan-control.ts` turns the request into the same `evaluateDecision` call `orca plan
 * decide` makes), so what is asserted here is the request: `{ planId, key, option,
 * rationale }`, nothing added, nothing left empty — and that a reopen sends a reopen and
 * nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DecisionView } from "@orca/protocol";
import { decideParams, reopenQuestion } from "../src/plan/decision-model.js";
import { AS_OF } from "./fixtures.js";
import { DECISIONS, PLAN_ID } from "./fixtures-plan.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
const teardown: (() => void)[] = [];

beforeEach(() => {
  stubMatchMedia(1440);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

const DATASTORE = DECISIONS[0]!;

// A decided decision's result is the stored one, so it carries no preview flag at all.
const { resultIsPreview: _preview, ...STORED } = DATASTORE;
const DECIDED: DecisionView = {
  ...STORED,
  status: "decided",
  chosen: "redis",
  decidedBy: "human",
  decidedAt: AS_OF,
  rationale: "ops said so",
};

async function openDecisions(decisions?: readonly DecisionView[]): Promise<HTMLElement> {
  fake = installBridge();
  teardown.push(fake.install());
  if (decisions) {
    fake.script({ "decisions.list": () => ({ ok: true, result: { decisions: [...decisions], asOf: AS_OF } }) });
  }
  const h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
  fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
  await screen.findByRole("grid", { name: "Schedule" });
  fireEvent.click(screen.getByRole("button", { name: "Decisions" }));
  const list = await screen.findByRole("grid", { name: "Decisions" });
  fireEvent.click(within(list).getAllByRole("row")[0]!);
  return screen.findByRole("table", { name: /Decision matrix for/ });
}

const callsTo = (method: string): unknown[] => fake.calls.filter((call) => call.method === method).map((c) => c.params);

describe("the matrix", () => {
  it("draws criteria with weights, options with scores, totals, and outlines the recommendation", async () => {
    const table = await openDecisions();
    const text = table.textContent ?? "";
    expect(text).toContain("Latency");
    expect(text).toContain("w2");
    expect(text).toContain("lower is better");
    expect(text).toContain("9/10");
    // The weighted totals are the matrix's, not the app's.
    expect(text).toContain("8.67");
    expect(text).toContain("6.67");

    // The recommended column, header to total, is the accent one; the other is not.
    const cookie = within(table).getByRole("button", { name: "Decide Signed cookie" });
    expect(cookie.closest("th")!.classList.contains("orca-matrix__win")).toBe(true);
    const redis = within(table).getByRole("button", { name: "Decide Redis" });
    expect(redis.closest("th")!.classList.contains("orca-matrix__win")).toBe(false);
    expect(table.querySelectorAll("td.orca-matrix__win")).toHaveLength(DATASTORE.criteria.length + 1);

    // Nothing has evaluated it: the recommendation says it is a preview.
    expect(screen.getByText(/The matrix recommends Signed cookie/)).toBeTruthy();
    expect(screen.getByText(/Preview/)).toBeTruthy();
  });

  it("says close beside the recommendation when the matrix does", async () => {
    await openDecisions([{ ...DATASTORE, result: { ...DATASTORE.result!, confidence: "close", margin: 0.05 } }]);
    const line = screen.getByText(/The matrix recommends/).parentElement!;
    expect(within(line).getByText("close")).toBeTruthy();
  });

  it("shows the due-by and the decision it supersedes, and follows the link", async () => {
    const older: DecisionView = { ...DECIDED, id: "dec-old", key: "session-store", title: "An older call" };
    await openDecisions([{ ...DATASTORE, dueBy: "2026-04-01", supersedes: "session-store" }, older]);
    const detail = screen.getByLabelText("Decision datastore");
    expect(detail.textContent).toContain("due by 2026-04-01");
    fireEvent.click(within(detail).getByRole("button", { name: "supersedes session-store" }));
    expect(await screen.findByLabelText("Decision session-store")).toBeTruthy();
  });
});

describe("deciding", () => {
  it("sends the CLI's request from the table, with the rationale a person typed", async () => {
    const table = await openDecisions();
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    // A person decides; pressing a column only asks why.
    expect(callsTo("decisions.decide")).toHaveLength(0);

    const form = screen.getByRole("form", { name: "Decide datastore" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "ops said so" } });
    fireEvent.click(within(form).getByRole("button", { name: "Decide Redis" }));

    await waitFor(() => expect(callsTo("decisions.decide")).toHaveLength(1));
    expect(callsTo("decisions.decide")[0]).toEqual({
      planId: PLAN_ID,
      key: "datastore",
      option: "redis",
      rationale: "ops said so",
    });
  });

  it("leaves an empty rationale out rather than sending it blank", () => {
    expect(decideParams(PLAN_ID, "datastore", "cookie", "  ")).toEqual({
      planId: PLAN_ID,
      key: "datastore",
      option: "cookie",
    });
  });

  it("decides from the palette, with the recommendation marked and not chosen for anyone", async () => {
    await openDecisions();
    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const query = within(palette).getByRole("combobox", { name: "Command palette" });
    fireEvent.change(query, { target: { value: "Decide datastore" } });
    fireEvent.keyDown(query, { key: "Enter" });

    const menu = await screen.findByRole("menu", { name: "Which option for datastore?" });
    expect(within(menu).getByRole("menuitem", { name: /Signed cookie/ }).textContent).toContain(
      "the matrix's recommendation",
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Redis/ }));
    await waitFor(() => expect(callsTo("decisions.decide")).toHaveLength(1));
    expect(callsTo("decisions.decide")[0]).toEqual({ planId: PLAN_ID, key: "datastore", option: "redis" });
  });
});

describe("a decided decision", () => {
  it("says who decided, when and why, and offers no column to decide by", async () => {
    const table = await openDecisions([DECIDED]);
    const decided = screen.getByLabelText("Decided");
    expect(decided.textContent).toContain("Redis, by human");
    expect(decided.textContent).toContain("ops said so");
    expect(within(table).queryByRole("button", { name: /^Decide / })).toBeNull();
    expect(table.textContent).toContain("Redis — chosen");
  });

  it("asks once before reopening, names what it reopens, and never re-decides", async () => {
    await openDecisions([DECIDED]);
    fireEvent.click(screen.getByRole("button", { name: "Reopen…" }));
    const question = screen.getByRole("group", { name: "Reopen datastore" });
    expect(question.textContent).toContain("auth-store");
    expect(question.textContent).toBe(
      reopenQuestion(DECIDED) +
        within(question).getByRole("button", { name: "Reopen datastore" }).textContent +
        "Keep the decision",
    );

    // Backing out sends nothing.
    fireEvent.click(within(question).getByRole("button", { name: "Keep the decision" }));
    expect(callsTo("decisions.reopen")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Reopen…" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen datastore" }));
    await waitFor(() => expect(callsTo("decisions.reopen")).toHaveLength(1));
    expect(callsTo("decisions.reopen")[0]).toEqual({ planId: PLAN_ID, key: "datastore" });
    expect(callsTo("decisions.decide")).toHaveLength(0);
  });
});
