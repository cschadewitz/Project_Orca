// @vitest-environment happy-dom
/**
 * The palette's write actions (#178): the rows every surface registers on the object in
 * focus, and the two things a write row does that a navigation row does not.
 *
 * What is asserted here is the issue's "done when" — that the actions for each object type
 * are listed, and that none of them is reachable by mouse only or by keyboard only. So the
 * answer rows are driven with the mouse and the confirmation with the keyboard, on purpose:
 * either one alone would leave half the claim untested.
 *
 * The other half of the issue is about what is *not* offered. A daemon that serves no run
 * control gets no rows at all, and a daemon that is not answering gets the rows with the
 * reason on them — absent versus disabled, which docs/design/40-connection-states.md draws
 * as the difference between a viewer and something broken.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AS_OF, HELLO, HELLO_READ_ONLY } from "./fixtures.js";
import { PLAN_ID } from "./fixtures-plan.js";
import { WORKFLOWS } from "./fixtures-workflows.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import type { ConnectionSnapshot } from "../../src/bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

beforeEach(() => {
  stubMatchMedia(1440);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

function mount(connection?: ConnectionSnapshot): void {
  fake = installBridge(connection === undefined ? {} : { connection });
  teardown.push(fake.install());
  h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
}

const palette = (): HTMLElement => screen.getByRole("dialog", { name: "Command palette" });
const query = (): HTMLInputElement => screen.getByRole("combobox", { name: "Command palette" });
const rows = (): HTMLElement[] => within(within(palette()).getByRole("listbox")).getAllByRole("option");
const labels = (): string[] => rows().map((row) => row.textContent ?? "");
const callsTo = (method: string): unknown[] => fake.calls.filter((call) => call.method === method).map((c) => c.params);

async function open(): Promise<void> {
  fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
  await screen.findByRole("dialog", { name: "Command palette" });
}

/** Type into the query and take the row the palette would run on `Enter`. */
function search(text: string): HTMLElement {
  fireEvent.change(query(), { target: { value: text } });
  return rows().find((row) => row.getAttribute("aria-selected") === "true")!;
}

describe("answering from the palette", () => {
  it("lists one row per option, in the order the card binds them", async () => {
    mount();
    await screen.findByRole("region", { name: /gate, Ship the rollout\?/ });
    await open();

    const answers = labels().filter((label) => label.startsWith("Answer Ship the rollout?"));
    /* `bindOptions`' order, which is the card's: everything that is not destructive in the
       order the gate offered them. The fixture's two options are both safe, so this is the
       gate's own order, and the consequence the wire carried is the row's detail. */
    expect(answers).toHaveLength(2);
    expect(answers[0]).toContain("Approve and ship");
    expect(answers[1]).toContain("Hold for now");
    expect(answers[1]).toContain("The rollout stays parked");
  });

  it("answers through the same path the card does, by option id", async () => {
    mount();
    await screen.findByRole("region", { name: /gate, Ship the rollout\?/ });
    await open();

    /* With the mouse: `mouseDown`, because the palette picks before the field is blurred.
       The whole label, because the card's own `2` is in this list too and it *selects* that
       option rather than answering with it — two different commands about one option. */
    fireEvent.mouseDown(rows().find((row) => row.textContent?.startsWith("Answer Ship the rollout?: Hold for now"))!);

    await waitFor(() => expect(callsTo("inputs.answer")).toHaveLength(1));
    // The id, never the label: a label may be reworded between the ask and the answer.
    expect(callsTo("inputs.answer")[0]).toMatchObject({ requestId: "hi-1", runId: "run-gate", optionId: "hold" });
  });
});

describe("cancel and resume", () => {
  it("arms the cancel row and sends nothing until a second Enter", async () => {
    mount();
    await screen.findByRole("region", { name: /gate, Ship the rollout\?/ });
    await open();

    // From the keyboard alone, which is the other half of "reachable by neither one only".
    const row = search("Cancel the run");
    expect(row.textContent).toContain("Cancel the run this is waiting on");
    fireEvent.keyDown(query(), { key: "Enter" });

    /* Armed: the palette is still open, the row now says what the next Enter will do, and
       nothing has been sent. */
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeNull();
    await within(palette()).findByRole("option", { name: /Cancel run-gate — confirm/ });
    expect(callsTo("runs.cancel")).toHaveLength(0);

    fireEvent.keyDown(query(), { key: "Enter" });
    await waitFor(() => expect(callsTo("runs.cancel")).toHaveLength(1));
    expect(callsTo("runs.cancel")[0]).toMatchObject({ runId: "run-gate" });
  });

  it("disarms the row when the selection moves off it", async () => {
    mount();
    await screen.findByRole("region", { name: /gate, Ship the rollout\?/ });
    await open();

    search("Cancel the run");
    fireEvent.keyDown(query(), { key: "Enter" });
    await within(palette()).findByRole("option", { name: /confirm/ });

    fireEvent.keyDown(query(), { key: "ArrowDown" });
    fireEvent.keyDown(query(), { key: "ArrowUp" });
    expect(within(palette()).queryByRole("option", { name: /confirm/ })).toBeNull();
    expect(callsTo("runs.cancel")).toHaveLength(0);
  });

  it("resumes at once: there is nothing to confirm about re-driving a parked run", async () => {
    mount();
    await screen.findByRole("region", { name: /gate, Ship the rollout\?/ });
    await open();

    search("Resume the run");
    fireEvent.keyDown(query(), { key: "Enter" });

    await waitFor(() => expect(callsTo("runs.resume")).toHaveLength(1));
    expect(callsTo("runs.resume")[0]).toMatchObject({ runId: "run-gate" });
  });
});

describe("starting a run", () => {
  it("lists the daemon's workflows, starts the chosen one and opens the run", async () => {
    mount();
    await screen.findByRole("button", { name: "Attention" });
    await open();

    search("Start a run");
    // The vars are not asked for and the row says so rather than leaving it to be found out.
    expect(rows().find((row) => row.textContent?.startsWith("Start a run"))?.textContent).toContain(
      "Starts with the workflow's default vars",
    );
    fireEvent.keyDown(query(), { key: "Enter" });

    /* The list is replaced by the app's one popover primitive, not by a second list: a
       `menu` with one item per registered workflow, each carrying the id, the version and
       the node count that `workflows.list` answers with. */
    const menu = await screen.findByRole("menu", { name: "Which workflow?" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(WORKFLOWS.length);
    expect(items[0]!.textContent).toContain(WORKFLOWS[0]!.name);
    expect(items[0]!.textContent).toContain(`v${WORKFLOWS[0]!.version}`);
    expect(items[0]!.textContent).toContain(`${WORKFLOWS[0]!.nodeCount} nodes`);

    fireEvent.click(items[0]!);
    await waitFor(() => expect(callsTo("runs.start")).toHaveLength(1));
    // No vars: the run takes the workflow's own (the form for them is specified nowhere).
    expect(callsTo("runs.start")[0]).toEqual({ workflowId: WORKFLOWS[0]!.id, idempotencyKey: expect.any(String) });

    /* And the app went to the run, through the route table — which is visible as the Runs
       surface reading the run that has just been started. */
    await waitFor(() =>
      expect(
        callsTo("runs.get").some((p) => (p as { runId: string }).runId === `run-started-${WORKFLOWS[0]!.id}`),
      ).toBe(true),
    );
  });

  it("keeps the palette to one menu while the picker is open, and adds no live region", async () => {
    mount();
    await screen.findByRole("button", { name: "Attention" });
    const regions = document.querySelectorAll("[aria-live]").length;
    await open();
    search("Start a run");
    fireEvent.keyDown(query(), { key: "Enter" });
    await screen.findByRole("menu", { name: "Which workflow?" });

    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(regions);
  });
});

describe("the plan's writes", () => {
  /** Go to Plan and select one work item by its title. */
  async function selectItem(title: string): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    const table = await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.click(within(table).getByRole("row", { name: new RegExp(title) }));
    await screen.findByLabelText(/^Work item /);
  }

  it("offers the blocking decision's options, and decides by option key", async () => {
    mount();
    await selectItem("Choose and wire the session store");
    await open();

    search("Decide datastore");
    fireEvent.keyDown(query(), { key: "Enter" });

    const menu = await screen.findByRole("menu", { name: "Which option for datastore?" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Signed cookie/ }));

    await waitFor(() => expect(callsTo("decisions.decide")).toHaveLength(1));
    expect(callsTo("decisions.decide")[0]).toEqual({ planId: PLAN_ID, key: "datastore", option: "cookie" });
  });

  it("waives an unmet dependency, once it has been confirmed", async () => {
    mount();
    await selectItem("Wire the login button");
    await open();

    const row = search("Waive dependency on auth-api");
    expect(row).toBeTruthy();
    fireEvent.keyDown(query(), { key: "Enter" });
    await within(palette()).findByRole("option", { name: /Waive auth-api — confirm/ });
    expect(callsTo("dependencies.waive")).toHaveLength(0);

    fireEvent.keyDown(query(), { key: "Enter" });
    await waitFor(() => expect(callsTo("dependencies.waive")).toHaveLength(1));
    expect(callsTo("dependencies.waive")[0]).toEqual({ planId: PLAN_ID, dependencyId: "dep-ui-api" });
  });

  it("moves an open risk along its lifecycle, never to the status it already holds", async () => {
    mount();
    await selectItem("Add the SSO callback");
    await open();

    search("Update risk vendor-slip");
    fireEvent.keyDown(query(), { key: "Enter" });

    const menu = await screen.findByRole("menu", { name: "Which status for vendor-slip?" });
    const statuses = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(statuses).not.toContain("open");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "mitigating" }));

    await waitFor(() => expect(callsTo("risks.update")).toHaveLength(1));
    expect(callsTo("risks.update")[0]).toEqual({ planId: PLAN_ID, key: "vendor-slip", status: "mitigating" });
  });

  it("offers the claim's release where the Agents surface would, and on the same condition", async () => {
    mount();
    /* The item's claim carries a `runId` and nothing else, so whether the daemon would
       refuse the release comes from `claims.list` — the same `owner.releasable` the Agents
       surface greys its button on (#176). */
    fake.script({
      "claims.list": (params) =>
        params.workItemId === "wi-metrics"
          ? {
              ok: true,
              result: {
                claims: [
                  {
                    workItemId: "wi-metrics",
                    branch: "auth-metrics",
                    claimedAt: AS_OF,
                    owner: { runId: "run-metrics", status: "stale", missing: true, releasable: true },
                  },
                ],
                asOf: AS_OF,
              },
            }
          : { ok: true, result: { claims: [], asOf: AS_OF } },
    });
    await selectItem("Instrument the login funnel");
    await open();

    search("Release claim on wi-metrics");
    fireEvent.keyDown(query(), { key: "Enter" });
    await within(palette()).findByRole("option", { name: /Release wi-metrics — confirm/ });
    fireEvent.keyDown(query(), { key: "Enter" });

    await waitFor(() => expect(callsTo("claims.release")).toHaveLength(1));
    expect(callsTo("claims.release")[0]).toEqual({ workItemId: "wi-metrics" });
  });

  it("re-reads the plan when the daemon says it changed, and polls for nothing", async () => {
    mount();
    await selectItem("Wire the login button");
    const before = callsTo("items.list").length;

    /* A write journals, the daemon pushes `plan.changed` with the areas that moved, and
       `usePlan` re-reads those. Nothing here starts a timer, which is why this is a push
       and an assertion rather than a wait. */
    await act(async () => {
      fake.notify({
        kind: "notification",
        method: "plan.changed",
        params: {
          subscriptionId: "sub-1",
          planId: PLAN_ID,
          kinds: ["dependencies"],
          seq: 999,
          at: AS_OF,
        },
      });
    });

    await waitFor(() => expect(callsTo("items.list").length).toBeGreaterThan(before));
  });
});

describe("what a daemon's answer takes away", () => {
  it("lists no write at all where the daemon serves none", async () => {
    mount({ state: "live", since: AS_OF, capabilities: HELLO_READ_ONLY.capabilities });
    fake.script({ hello: () => ({ ok: true, result: HELLO_READ_ONLY }) });
    await screen.findByRole("button", { name: "Attention" });
    await open();

    /* Absent, not disabled: a screen with no cancel row reads as a viewer, a screen with a
       dead one reads as broken (docs/design/40-connection-states.md). The read-only daemon
       leaves the control methods out of `hello.methods` and the capability out of `hello`
       together, which is why one check answers for all of them. */
    expect(labels().some((label) => label.startsWith("Start a run"))).toBe(false);
    expect(labels().some((label) => label.includes("Cancel"))).toBe(false);
    expect(labels().some((label) => label.startsWith("Answer Ship the rollout?"))).toBe(false);
  });

  it("keeps the rows but says why, where the daemon is simply not answering", async () => {
    mount();
    await screen.findByRole("button", { name: "Attention" });
    fake.connect({ state: "disconnected", since: AS_OF, capabilities: [] });
    /* The palette reads the registry when it opens, so the state has to have landed first —
       which is what the banner says. */
    await screen.findByText(/No daemon/i);
    await open();

    const row = rows().find((option) => option.textContent?.startsWith("Start a run"))!;
    expect(row).toBeTruthy();
    expect(row.getAttribute("aria-disabled")).toBe("true");
    // `useWritability()`'s sentence, verbatim and on the row — never a bare greyed line.
    expect(row.querySelector(".orca-palette__why")?.textContent).toBe("no daemon is answering");
  });

  /**
   * The row asks for the *method* it calls, never for the capability above it. `runs.control`
   * is one word over four dispatch tables (docs/design/40-connection-states.md), so these two
   * daemons — both live, both plausible — are the ones the capability alone gets wrong in
   * each direction.
   */
  it("drops the rows whose method this daemon does not answer, and keeps the rest", async () => {
    const plan = ["dependencies.waive", "decisions.decide", "decisions.reopen", "risks.update", "claims.release"];
    /* A daemon driving runs over a store with no plan in it: `runs.control` and every run
       method, and not one of the plan writes. */
    mount({
      state: "live",
      since: AS_OF,
      capabilities: HELLO.capabilities,
      methods: (HELLO.methods ?? []).filter((method) => !plan.includes(method)),
    });

    await screen.findByRole("region", { name: /gate, Ship the rollout\?/ });
    await open();
    expect(labels().some((label) => label.includes("Cancel the run this is waiting on"))).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());

    /* `wi-store` is blocked by the decision `datastore`, which is both a decision to make
       and a dependency to waive — one item that would carry two of the dropped rows. */
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    const table = await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.click(within(table).getByRole("row", { name: /Choose and wire the session store/ }));
    await screen.findByLabelText(/^Work item /);
    await open();

    expect(labels().some((label) => label.startsWith("Waive dependency"))).toBe(false);
    expect(labels().some((label) => label.startsWith("Decide "))).toBe(false);
    // And the palette is the live one, with the writes this daemon *does* serve in it.
    expect(labels().some((label) => label.startsWith("Start a run"))).toBe(true);
  });

  it("keeps a row whose method is served by a daemon that claims no capability", async () => {
    /* The mirror: no `runs.control` in `hello.capabilities` — an older or narrower daemon —
       but `claims.release` in `hello.methods`, which is `Object.keys` of what it will
       actually answer. The method list is the honest one, so the row is there. */
    mount({
      state: "live",
      since: AS_OF,
      capabilities: ["runs.read", "plan.read"],
      methods: [...(HELLO.methods ?? []).filter((m) => m !== "runs.cancel"), "claims.release"],
    });
    fake.script({
      "claims.list": (params) =>
        params.workItemId === "wi-metrics"
          ? {
              ok: true,
              result: {
                claims: [
                  {
                    workItemId: "wi-metrics",
                    branch: "auth-metrics",
                    claimedAt: AS_OF,
                    owner: { runId: "run-metrics", status: "stale", missing: true, releasable: true },
                  },
                ],
                asOf: AS_OF,
              },
            }
          : { ok: true, result: { claims: [], asOf: AS_OF } },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    const table = await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.click(within(table).getByRole("row", { name: /Instrument the login funnel/ }));
    await screen.findByLabelText(/^Work item /);
    await open();

    const release = rows().find((option) => option.textContent?.includes("Release claim on wi-metrics"));
    expect(release).toBeTruthy();
    // A daemon without the capability still cannot be written to *now*, and the row says
    // so in `useWritability()`'s words rather than disappearing.
    expect(release!.querySelector(".orca-palette__why")?.textContent).toBe("this daemon offers no run control");
  });
});

describe("a row that cannot be run is still a row the keyboard reaches", () => {
  it("selects the disabled row, names it in aria-activedescendant, and runs nothing", async () => {
    mount();
    await screen.findByRole("button", { name: "Attention" });
    fake.connect({ state: "disconnected", since: AS_OF, capabilities: [] });
    await screen.findByText(/No daemon/i);
    await open();

    /* The reason lives on the row (`.orca-palette__why`), so a roving order that stepped
       over the row would put the reason out of reach of the keyboard — which is exactly
       what `Button` refuses to do with `disabledReason`
       (docs/design/40-connection-states.md). */
    const row = search("Start a run");
    expect(row.textContent).toContain("Start a run");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(query().getAttribute("aria-activedescendant")).toBe(row.id);

    fireEvent.keyDown(query(), { key: "Enter" });
    expect(callsTo("workflows.list")).toHaveLength(0);
    expect(callsTo("runs.start")).toHaveLength(0);
    // Nothing happened, including closing: `Enter` on a disabled row is a press that means
    // nothing, not a dismissal.
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeNull();

    // And it is reached by the arrows too, not only by a query that leaves it first.
    fireEvent.keyDown(query(), { key: "ArrowDown" });
    fireEvent.keyDown(query(), { key: "ArrowUp" });
    expect(query().getAttribute("aria-activedescendant")).toBe(row.id);
  });
});

describe("a cancelled picker", () => {
  it("puts focus back in the query field", async () => {
    mount();
    await screen.findByRole("button", { name: "Attention" });
    await open();

    search("Start a run");
    fireEvent.keyDown(query(), { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Which workflow?" });
    // The field is still on screen underneath the picker: it is the one thing in this
    // dialog focus can come back to.
    expect(query()).toBeTruthy();

    /* `Esc` through the layer stack, which is how every menu closes. The trigger it would
       hand focus back to goes away with the picker, so the palette has to catch it. */
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(menu.isConnected).toBe(false));

    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(query()));
  });
});
