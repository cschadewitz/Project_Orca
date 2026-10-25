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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DecisionView } from "@orca/protocol";
import { ANNOUNCER_ATTRIBUTE } from "../src/a11y/announcer.js";
import { DecisionMode } from "../src/plan/decision-mode.js";
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
  it("retains the choice and rationale after refusal for an identical explicit retry", async () => {
    const table = await openDecisions();
    fake.fail("decisions.decide", { code: "PLAN_INVALID", message: "decision refused" });
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    const form = screen.getByRole("form", { name: "Decide datastore" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "ops said so" } });
    fireEvent.submit(form);
    await waitFor(() => expect(announced()).toBe("That did not go through: decision refused"));
    const retained = screen.getByRole("form", { name: "Decide datastore" });
    expect(within(retained).getByRole<HTMLTextAreaElement>("textbox").value).toBe("ops said so");
    expect(within(retained).getByRole("button", { name: "Decide Redis" })).toBeTruthy();
    expect(callsTo("decisions.decide")).toHaveLength(1);

    fake.script({
      "decisions.decide": () => ({ ok: true, result: { decision: DECIDED, choice: "redis", asOf: AS_OF } }),
    });
    fireEvent.submit(retained);
    await waitFor(() => expect(screen.queryByRole("form", { name: "Decide datastore" })).toBeNull());
    expect(callsTo("decisions.decide")).toEqual([
      { planId: PLAN_ID, key: "datastore", option: "redis", rationale: "ops said so" },
      { planId: PLAN_ID, key: "datastore", option: "redis", rationale: "ops said so" },
    ]);
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
  });

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

  it("keeps the draft through connection loss and guards direct form submission", async () => {
    const table = await openDecisions();
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    const form = screen.getByRole("form", { name: "Decide datastore" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "keep these notes" } });
    const live = fake.connection;
    await act(async () => fake.connect({ ...live, state: "disconnected", since: AS_OF }));
    const submit = within(form).getByRole<HTMLButtonElement>("button", { name: "Decide Redis" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.title).toBe("no daemon is answering");
    fireEvent.submit(form);
    expect(callsTo("decisions.decide")).toHaveLength(0);
    expect(within(form).getByRole<HTMLTextAreaElement>("textbox").value).toBe("keep these notes");
    await act(async () => fake.connect(live));
    expect(submit.getAttribute("aria-disabled")).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(screen.queryByRole("form", { name: "Decide datastore" })).toBeNull());
    expect(callsTo("decisions.decide")).toEqual([
      { planId: PLAN_ID, key: "datastore", option: "redis", rationale: "keep these notes" },
    ]);
  });

  it("guards a form left open when the daemon withdraws the decision method", async () => {
    const table = await openDecisions();
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    const form = screen.getByRole("form", { name: "Decide datastore" });
    await act(async () =>
      fake.connect({
        ...fake.connection,
        methods: (fake.connection.methods ?? []).filter((method) => method !== "decisions.decide"),
      }),
    );
    expect(within(form).getByRole("button", { name: "Decide Redis" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.submit(form);
    expect(callsTo("decisions.decide")).toHaveLength(0);
  });

  it("retains a refused in-flight draft after losing the connection without retrying", async () => {
    const table = await openDecisions();
    fake.fail("decisions.decide", { code: "DISCONNECTED", message: "connection lost" });
    const release = fake.hold("decisions.decide");
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    const form = screen.getByRole("form", { name: "Decide datastore" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "keep these notes" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(callsTo("decisions.decide")).toHaveLength(1);
    await act(async () => {
      fake.connect({ ...fake.connection, state: "disconnected", since: AS_OF });
      release();
    });
    await waitFor(() => expect(announced()).toBe("That did not go through: connection lost"));
    expect(within(form).getByRole<HTMLTextAreaElement>("textbox").value).toBe("keep these notes");
    expect(within(form).getByRole("button", { name: "Decide Redis" }).getAttribute("aria-disabled")).toBe("true");
    expect(callsTo("decisions.decide")).toHaveLength(1);
  });

  it.each(["rationale", "choice", "cancel"] as const)(
    "does not clear a newer draft after a late success following %s changes",
    async (change) => {
      const table = await openDecisions();
      const release = fake.hold("decisions.decide");
      fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
      let form = screen.getByRole("form", { name: "Decide datastore" });
      fireEvent.change(within(form).getByRole("textbox"), { target: { value: "first notes" } });
      fireEvent.submit(form);
      if (change === "cancel") {
        fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("form", { name: "Decide datastore" })).toBeNull();
        fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
        form = screen.getByRole("form", { name: "Decide datastore" });
        expect(within(form).getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
      }
      if (change === "choice") {
        fireEvent.click(within(table).getByRole("button", { name: "Decide Signed cookie" }));
      }
      const notes = change === "cancel" ? "first notes" : "newer notes";
      fireEvent.change(within(form).getByRole("textbox"), { target: { value: notes } });
      await act(async () => release());
      expect(within(form).getByRole<HTMLTextAreaElement>("textbox").value).toBe(notes);
      const choice = change === "choice" ? "Signed cookie" : "Redis";
      expect(
        within(form)
          .getByRole("button", { name: `Decide ${choice}` })
          .getAttribute("aria-disabled"),
      ).toBeNull();
      expect(callsTo("decisions.decide")).toHaveLength(1);
      expect(announced()).not.toContain("is decided");
    },
  );

  it.each([true, false])("does not restore a cancelled draft after a late result (ok=%s)", async (ok) => {
    const table = await openDecisions();
    if (!ok) fake.fail("decisions.decide", { code: "PLAN_INVALID", message: "late refusal" });
    const release = fake.hold("decisions.decide");
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    const form = screen.getByRole("form", { name: "Decide datastore" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "cancelled notes" } });
    fireEvent.submit(form);
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await act(async () => release());
    expect(screen.queryByRole("form", { name: "Decide datastore" })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Decide Redis" }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
  });

  it.each(["plan", "key", "selection", "navigation", "status"] as const)(
    "does not let an old response clear or restore notes after a %s change",
    async (change) => {
      fake = installBridge();
      teardown.push(fake.install());
      const h = harness();
      teardown.push(h.dispose);
      const release = fake.hold("decisions.decide");
      const target = (planId: string, decision: DecisionView) => (
        <h.Providers>
          <DecisionMode
            planId={planId}
            state={{ phase: "ready", decisions: [decision] }}
            decisions={[decision]}
            selectedId={decision.id}
            onSelect={() => {}}
            live
            onRetry={() => {}}
          />
        </h.Providers>
      );
      const view = render(target(PLAN_ID, DATASTORE));
      fireEvent.click(screen.getByRole("button", { name: "Decide Redis" }));
      let form = screen.getByRole("form", { name: "Decide datastore" });
      fireEvent.change(within(form).getByRole("textbox"), { target: { value: "old target notes" } });
      fireEvent.submit(form);
      let planId = PLAN_ID;
      let decision = DATASTORE;
      if (change === "plan") planId = "another-plan";
      if (change === "key") decision = { ...DATASTORE, key: "renamed" };
      if (change === "selection") decision = { ...DATASTORE, id: "another-decision", key: "another" };
      if (change === "navigation")
        view.rerender(
          <h.Providers>
            <div>Another surface</div>
          </h.Providers>,
        );
      if (change === "status") view.rerender(target(PLAN_ID, DECIDED));
      view.rerender(target(planId, decision));
      expect(screen.queryByRole("form")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Decide Redis" }));
      form = screen.getByRole("form", { name: `Decide ${decision.key}` });
      expect(within(form).getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
      fireEvent.change(within(form).getByRole("textbox"), { target: { value: "new target notes" } });
      await act(async () => release());
      expect(within(form).getByRole<HTMLTextAreaElement>("textbox").value).toBe("new target notes");
      expect(callsTo("decisions.decide")).toHaveLength(1);
    },
  );

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

  it("hands a focused Reopen trigger to Keep and restores it on cancellation", async () => {
    await openDecisions([DECIDED]);
    const trigger = screen.getByRole("button", { name: "Reopen…" });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const keep = screen.getByRole("button", { name: "Keep the decision" });
    expect(document.activeElement).toBe(keep);
    await act(async () => fireEvent.click(keep));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reopen…" }));
    expect(callsTo("decisions.reopen")).toHaveLength(0);
  });

  it("asks once before reopening, names what it reopens, and never re-decides", async () => {
    await openDecisions([DECIDED]);
    fireEvent.click(screen.getByRole("button", { name: "Reopen…" }));
    const question = screen.getByRole("group", { name: "Reopen datastore" });
    expect(question.textContent).toContain("auth-store");
    expect(question.textContent).toBe(
      reopenQuestion(DECIDED) +
        "Keep the decision" +
        within(question).getByRole("button", { name: "Reopen datastore" }).textContent,
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
