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
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DecisionView } from "@orca/protocol";
import { ANNOUNCER_ATTRIBUTE } from "../src/a11y/announcer.js";
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

describe("the palette after a push", () => {
  it("offers the options and recommendation the decision has now, not the ones it had", async () => {
    await openDecisions();
    // A push that changes the options and the recommendation without changing the status.
    const moved: DecisionView = {
      ...DATASTORE,
      options: [...DATASTORE.options, { key: "db", name: "The database", scores: {}, pros: [], cons: [], risks: [] }],
      result: { ...DATASTORE.result!, recommended: "redis" },
    };
    fake.script({ "decisions.list": () => ({ ok: true, result: { decisions: [moved], asOf: AS_OF } }) });
    await act(async () => {
      fake.notify({
        kind: "notification",
        method: "plan.changed",
        params: { subscriptionId: "sub-1", planId: PLAN_ID, kinds: ["decisions"], seq: 50, at: AS_OF },
      });
    });
    await waitFor(() => expect(screen.getByText(/The matrix recommends Redis/)).toBeTruthy());

    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const query = within(palette).getByRole("combobox", { name: "Command palette" });
    fireEvent.change(query, { target: { value: "Decide datastore" } });
    fireEvent.keyDown(query, { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Which option for datastore?" });
    expect(within(menu).getByRole("menuitem", { name: /The database/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Redis/ }).textContent).toContain("the matrix's recommendation");
    expect(within(menu).getByRole("menuitem", { name: /Signed cookie/ }).textContent).not.toContain("recommendation");
  });
});

const announced = (): string => document.querySelector(`[${ANNOUNCER_ATTRIBUTE}]`)?.textContent ?? "";

describe("what is said when the record is thin", () => {
  it("says what was not recorded, and that a reopen with nothing behind it reopens nothing", async () => {
    // Decided by a daemon that recorded no actor, no time and no rationale, gating nothing.
    const { decidedBy: _by, decidedAt: _at, rationale: _why, ...bare } = DECIDED;
    await openDecisions([{ ...bare, blocks: [] }]);
    const decided = screen.getByLabelText("Decided");
    expect(decided.textContent).toContain("Redis, by an unrecorded actor");
    expect(decided.textContent).toContain("No rationale was recorded.");
    expect(decided.querySelector("time")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reopen…" }));
    expect(screen.getByRole("group", { name: "Reopen datastore" }).textContent).toContain(
      "No dependency is waiting on it.",
    );
    fake.script({
      "decisions.reopen": () => ({
        ok: true,
        result: { decision: { ...bare, status: "open" }, reopenedDependencyIds: [], asOf: AS_OF },
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen datastore" }));
    await waitFor(() => expect(announced()).toBe("datastore is open again; nothing reopened with it."));
  });

  it("counts the one dependency a reopen reopened", async () => {
    await openDecisions([DECIDED]);
    fireEvent.click(screen.getByRole("button", { name: "Reopen…" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen datastore" }));
    await waitFor(() => expect(announced()).toBe("datastore is open again; 1 dependency reopened with it."));
  });

  it("says a reopen that did not go through did not, in the daemon's words", async () => {
    await openDecisions([DECIDED]);
    fake.fail("decisions.reopen", { code: "PLAN_INVALID", message: "datastore is already open" });
    fireEvent.click(screen.getByRole("button", { name: "Reopen…" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen datastore" }));
    await waitFor(() => expect(announced()).toBe("That did not go through: datastore is already open"));
    // The question is put away either way; it is asked once.
    expect(screen.queryByRole("group", { name: "Reopen datastore" })).toBeNull();
  });

  it("says when the matrix has no ranking, in the row and in the detail", async () => {
    const { result: _result, resultIsPreview: _preview, ...unranked } = DATASTORE;
    await openDecisions([unranked]);
    expect(
      screen.getByText("The matrix has no ranking: an option is missing a score, or there is nothing to rank."),
    ).toBeTruthy();
    const row = within(screen.getByRole("grid", { name: "Decisions" })).getAllByRole("row")[0]!;
    expect(row.textContent).not.toContain("recommends");
  });

  it("narrows the list with the rail, and says so when nothing is left", async () => {
    await openDecisions();
    expect(screen.getByText("1 decision")).toBeTruthy();
    // Only the held item is left, and the one decision gates an item that is not.
    fireEvent.click(screen.getByRole("button", { name: /^held/ }));
    // The noun agrees with the total, and the count is one unit (RULES.md rule 15).
    await screen.findByText("0 of 1 decision");
    expect(screen.getByText("No decisions here")).toBeTruthy();
    expect(screen.queryByRole("grid", { name: "Decisions" })).toBeNull();
  });
});

describe("the mode's states", () => {
  it("says it is loading until the decisions answer", async () => {
    fake = installBridge();
    teardown.push(fake.install());
    const release = fake.hold("decisions.list");
    const h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.click(screen.getByRole("button", { name: "Decisions" }));
    await screen.findByText("Loading the decisions");
    expect(screen.queryByRole("grid", { name: "Decisions" })).toBeNull();
    release();
    await screen.findByRole("grid", { name: "Decisions" });
  });

  it("names the error and offers a retry while live, and calls it disconnected when nothing answers", async () => {
    await openDecisions();
    fake.fail("decisions.list", { code: "STORE_READ", message: "the plan store is unreadable" });
    await act(async () => {
      fake.notify({
        kind: "notification",
        method: "plan.changed",
        params: { subscriptionId: "sub-1", planId: PLAN_ID, kinds: ["decisions"], seq: 50, at: AS_OF },
      });
    });
    await screen.findByText("Could not load the decisions");
    expect(screen.getByText("STORE_READ: the plan store is unreadable")).toBeTruthy();
    expect(screen.queryByRole("grid", { name: "Decisions" })).toBeNull();

    const before = callsTo("decisions.list").length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo("decisions.list").length).toBe(before + 1));
    await screen.findByText("Could not load the decisions");

    // The same daemon gone quiet, so its capabilities stay: none would read as "no plan".
    fake.connect({ ...fake.connection, state: "disconnected", since: AS_OF });
    await screen.findByText("No daemon to read the decisions from");
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
