// @vitest-environment happy-dom
/**
 * The accessibility sweep (#167): the three surfaces that exist in v0.4.0 — Attention, Runs
 * and Agents — mounted through the chrome that mounts them, and read as a screen reader
 * would read them.
 *
 * It is one file rather than an assertion bolted onto each surface's own test on purpose.
 * Three of the claims in `docs/design/50-accessibility-and-keyboard.md` are claims about
 * the *app*, not about a component, and they are exactly the ones a per-surface test cannot
 * make:
 *
 * - **there is one polite announcer**, not one per surface — which can only be counted with
 *   more than one surface having been mounted;
 * - **the polite live regions are the two the spec names** and no third has appeared;
 * - **the accessible names carry status first** on every surface, which is what makes the
 *   greyscale claim ("the run tree still reads in a screenshot") true of the rest of the app
 *   as well as of the tree.
 *
 * What it deliberately does not do is duplicate `axe`. The Electron smoke test runs axe over
 * each surface, and axe finds the violations a rule can name; this file asserts the things
 * the design decided, which no generic rule knows — that a gate is assertive and a replayed
 * gate is not, that the output pane is a `log` that does not speak, that a row can be
 * selected while focus is somewhere else entirely.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AGENT_HEALTH_PRESENTATION } from "@orca/design";
import type { NotificationMessage } from "@orca/protocol";
import { ANNOUNCER_ATTRIBUTE } from "../src/a11y/announcer.js";
import { cardName } from "../src/attention/answer-card.js";
import { AGENTS } from "./fixtures-agents.js";
import { FIVE_GATES, INPUTS_AS_OF, PERMISSION_ASK } from "./fixtures-inputs.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import { installDesignSystem, resolved } from "./themes.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

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

/** The waits the Attention surface is given, so the sweep meets both tiers of card. */
function serveWaits(): void {
  const inputs = [PERMISSION_ASK, FIVE_GATES[0]!];
  fake.script({
    "inputs.list": () => ({ ok: true, result: { inputs, waiting: inputs.length, asOf: INPUTS_AS_OF } }),
  });
}

const announcers = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[${ANNOUNCER_ATTRIBUTE}]`)];
/** Every element that declares a live behaviour, whatever it declares. */
const liveRegions = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[aria-live]")];
const politeRegions = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[aria-live="polite"]')];

/** Go to a surface the way a person does: the sidebar button. */
async function goTo(surface: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: surface }));
}

describe("the one polite announcer", () => {
  it("is mounted once by the chrome, on every surface, and starts silent", async () => {
    serveWaits();
    renderChrome(h);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    const [announcer, ...extra] = announcers();
    expect(extra).toEqual([]);
    expect(announcer).toBeDefined();
    expect(announcer!.getAttribute("role")).toBe("status");
    expect(announcer!.getAttribute("aria-live")).toBe("polite");
    // The whole sentence is read each time, not the words that changed in it.
    expect(announcer!.getAttribute("aria-atomic")).toBe("true");
    // Nothing has happened, so it says nothing: an announcer that greets you is noise.
    expect(announcer!.textContent).toBe("");

    /* The claim a per-surface test cannot make. Two surfaces have now been mounted and
       unmounted under one chrome; if the announcer belonged to a surface there would be
       two of them here, announcing the same failure twice. */
    await goTo("Runs");
    await screen.findByRole("tree", { name: "Run tree" });
    expect(announcers()).toHaveLength(1);
    await goTo("Agents");
    await screen.findAllByRole("region", { name: /^Host / });
    expect(announcers()).toHaveLength(1);
    // And it is the same element throughout, not a fresh one per surface.
    expect(announcers()[0]).toBe(announcer);
  });

  it("is invisible and still in the accessibility tree, on the component layer's own class", async () => {
    /* The two halves of #262's utility, asserted together because either one alone is a
       bug: an announcer that can be seen is a paragraph of chrome nobody asked for, and an
       announcer hidden the other ways — `display: none`, `visibility: hidden`, a zero box —
       is a region some screen reader has quietly switched off.

       The clip is `.orca-visually-hidden` in `packages/design/css/components.css` rather
       than three literals in `app.css`, so this reads the real stylesheet to check it. */
    installDesignSystem();
    document.body.classList.add("orca");
    serveWaits();
    renderChrome(h);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    const announcer = announcers()[0]!;

    expect(announcer.classList.contains("orca-visually-hidden")).toBe(true);
    expect(resolved(announcer, "clip-path")).toBe("inset(50%)");
    expect(resolved(announcer, "position")).toBe("absolute");

    // Hidden, but never the two ways that would also hide it from a reader.
    expect(resolved(announcer, "display")).not.toBe("none");
    expect(resolved(announcer, "visibility")).not.toBe("hidden");
    // And nothing has taken it out of the tree by hand either: it is a named live region.
    expect(announcer.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getAllByRole("status")).toContain(announcer);

    document.body.classList.remove("orca");
  });

  it("announces a step transition and a run's terminal state, and never the output", async () => {
    serveWaits();
    renderChrome(h);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    const announcer = announcers()[0]!;

    // The frame that introduces the step is what names it; the failure is what is said.
    await act(async () => {
      fake.notify(stepChanged({ status: "running", nodeId: "build", attempt: 2, event: "step.scheduled" }));
    });
    expect(announcer.textContent).toBe("build step started, 2 attempts");

    await act(async () => {
      fake.notify(stepChanged({ status: "failed" }));
    });
    expect(announcer.textContent).toBe("build step failed, 2 attempts");

    await act(async () => {
      fake.notify(runChanged("failed"));
    });
    expect(announcer.textContent).toBe("Run run-parent failed");

    /* Rule 11, from the other end: the agent's own output arrives on `agent.update`, and
       the announcer is not listening to it — forty lines a second is the thing this region
       exists *instead of*. The region still says the last transition. */
    await act(async () => {
      fake.notify({
        kind: "notification",
        method: "agent.update",
        params: {
          subscriptionId: "sub-1",
          runId: "run-parent",
          seq: 40,
          at: "2026-03-01T09:00:40.000Z",
          stepRunId: "s-build-2",
          fromSeq: 39,
          sessionId: "sess-1",
          updates: [{ kind: "agent_message_chunk", text: "compiling…" }],
        },
      });
    });
    expect(announcer.textContent).toBe("Run run-parent failed");
  });

  it("says nothing on the frames that are not worth a sentence, and does not blank itself", async () => {
    serveWaits();
    renderChrome(h);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    const announcer = announcers()[0]!;

    await act(async () => {
      fake.notify(stepChanged({ status: "failed", nodeId: "build", event: "step.scheduled" }));
    });
    expect(announcer.textContent).toBe("build step failed");

    /* The quiet half of the fold, asserted at the region rather than at the function
       (`announcements.test.ts` has the wording). Two frames that say nothing: a step that
       succeeded — success is quiet, rule 6 — and a run that is merely running, whose
       transitions are its steps and are heard through them.

       What is being checked is not only that they add nothing, but that they do not
       *clear* what is there. A live region that reset to "" on every uninteresting frame
       would be a region that mutated twice per announcement, and a screen reader part-way
       through the sentence would hear it cut off. */
    for (const frame of [stepChanged({ status: "succeeded" }), runChanged("running")]) {
      await act(async () => {
        fake.notify(frame);
      });
      expect(announcer.textContent).toBe("build step failed");
    }
  });

  it("is the only polite region besides the connection state the spec asks for", async () => {
    serveWaits();
    renderChrome(h);
    await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });

    /* The spec names exactly two polite regions — this one, and "the connection state is a
       polite live region; it announces on change, not on tick". A third appearing here is a
       surface having quietly grown one of its own, which is the failure this counts. */
    const polite = politeRegions();
    expect(polite).toHaveLength(2);
    expect(polite).toContain(announcers()[0]);
    expect(polite.some((el) => el.classList.contains("orca-conn"))).toBe(true);

    // And every declared live region is one of the three behaviours the spec allows.
    for (const region of liveRegions()) {
      expect(["polite", "assertive", "off"]).toContain(region.getAttribute("aria-live"));
    }
  });
});

describe("Attention: the interruption the design intends", () => {
  it("announces an open card assertively and names it with its tier first", async () => {
    serveWaits();
    renderChrome(h);

    const gate = await screen.findByRole("region", { name: cardName("gate", "Ship release 1?") });
    const ask = screen.getByRole("region", { name: cardName("permission", "Run a shell command?") });

    /* Rule 11's second half: a gate and a permission ask are the one interruption the
       design intends, so the card they arrive in is an alert. The name is the tier's word
       and then the question — status first, as the run rows read (#167). */
    for (const card of [gate, ask]) {
      const alert = card.closest('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.getAttribute("aria-live")).toBe("assertive");
    }
    expect(gate.getAttribute("aria-label")).toBe("gate, Ship release 1?");
    expect(ask.getAttribute("aria-label")).toBe("permission, Run a shell command?");

    // One tab stop per card, which is what `J`/`K` move between.
    expect(gate.getAttribute("tabindex")).toBe("0");
  });

  it("keeps the failed runs a selectable list, below the cards and out of the count", async () => {
    serveWaits();
    renderChrome(h);
    const failures = await screen.findByRole("listbox", { name: "Failed runs" });

    const options = within(failures).queryAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    // Selection is an attribute on every row, not a class on one of them.
    for (const option of options) expect(option.hasAttribute("aria-selected")).toBe(true);
    // A failure is something to go and read, so it is not an alert and never announces.
    expect(failures.closest("[aria-live]")).toBeNull();
  });
});

describe("Runs: the tree, and the output that does not speak", () => {
  it("is a tree of treeitems carrying level, expansion and selection", async () => {
    renderChrome(h);
    await goTo("Runs");
    const tree = await screen.findByRole("tree", { name: "Run tree" });

    const roots = within(tree).queryAllByRole("treeitem");
    expect(roots.length).toBeGreaterThan(0);
    for (const row of roots) {
      // Every root is at depth one, and every row says whether it is the selected one.
      expect(row.getAttribute("aria-level")).toBe("1");
      expect(row.hasAttribute("aria-selected")).toBe(true);
    }

    // Open the last root — `run-parent`, the fixture with steps, attempts and a fan-out.
    fireEvent.keyDown(tree, { key: "End", code: "End" });
    await act(async () => {
      fireEvent.keyDown(tree, { key: "ArrowRight", code: "ArrowRight" });
    });
    await waitFor(() => expect(within(tree).queryAllByRole("treeitem").length).toBeGreaterThan(roots.length));

    const rows = within(tree).queryAllByRole("treeitem");
    const parent = rows.find((row) => row.id === "tree-row-run-parent")!;
    const step = rows.find((row) => row.id === "tree-row-run-parent/s-build-2")!;

    // Depth is announced as well as drawn: the step is a level below the run holding it.
    expect(parent.getAttribute("aria-level")).toBe("1");
    expect(step.getAttribute("aria-level")).toBe("2");
    expect(parent.getAttribute("aria-expanded")).toBe("true");

    // A row that has children and is closed says so, which is the third of the three states.
    const collapsed = rows.find((row) => row.getAttribute("aria-expanded") === "false");
    expect(collapsed).toBeDefined();

    /* And a leaf carries no `aria-expanded` at all rather than `false`: "not expanded" and
       "nothing to expand" are different facts and a screen reader says so. The whole
       subtree has to be open to reach one — every row at the first level down is a run, a
       step group or a fan-out, and all three have something under them. */
    await act(async () => {
      fireEvent.keyDown(tree, { key: "ArrowRight", code: "ArrowRight", shiftKey: true });
    });
    await waitFor(() =>
      expect(
        within(tree)
          .queryAllByRole("treeitem")
          .some((row) => !row.hasAttribute("aria-expanded")),
      ).toBe(true),
    );
    const deep = within(tree).queryAllByRole("treeitem");
    // The fan-out's skipped branch: a fact about a fan-out, never an object with children.
    const note = deep.find((row) => row.id.endsWith("!auth-perf"))!;
    expect(note).toBeDefined();
    expect(note.hasAttribute("aria-expanded")).toBe(false);
    expect(note.getAttribute("aria-level")).toBe("3");
  });

  it("keeps a row selected while focus is somewhere else entirely", async () => {
    renderChrome(h);
    await goTo("Runs");
    const tree = await screen.findByRole("tree", { name: "Run tree" });

    fireEvent.keyDown(tree, { key: "End", code: "End" });
    await waitFor(() => expect(tree.getAttribute("aria-activedescendant")).toBeTruthy());
    const selectedId = tree.getAttribute("aria-activedescendant");
    const selected = document.getElementById(selectedId!)!;
    expect(selected.getAttribute("aria-selected")).toBe("true");

    /* The spec's rule, asserted from the renderer's side: "a row can be selected without
       being focused (the list has selection, the palette has focus)". Selection is
       `aria-activedescendant` on a single tab stop, so a row is never focusable itself and
       taking focus out of the list entirely must not clear it. Whether the *ring* is drawn
       after a click is `:focus-visible`'s, and that — along with selection being a ground
       and a rail rather than a second ring — is a claim about pixels that happy-dom cannot
       compute. It is read off the stylesheets in `focus-and-selection.test.ts`. */
    expect(selected.hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).not.toBe(selected);

    const filter = screen.getByRole("searchbox", { name: "Filter runs" });
    filter.focus();
    expect(document.activeElement).toBe(filter);
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(tree.getAttribute("aria-activedescendant")).toBe(selectedId);
  });

  it("gives the output pane a log role, the step's name, and no voice", async () => {
    /* Arrived at by URL rather than by four keystrokes: the route table is how every other
       arrival at a step works (#165), and it is the shortest honest way to a mounted
       output pane inside the real chrome. */
    fake.script({});
    cleanup();
    while (teardown.length) teardown.pop()?.();
    fake = installBridge({ deepLink: "orca://run/run-parent/step/build.2" });
    teardown.push(fake.install());
    h = harness();
    teardown.push(h.dispose);
    renderChrome(h);

    const pane = await screen.findByRole("log", { name: /^Output of build/ });
    // The name says which step's output this is, so the region list a reader navigates by
    // is not five panes all called "Output".
    expect(pane.getAttribute("aria-label")).toBe("Output of build, attempt 2");
    /* `role="log"` implies `aria-live="polite"`. The explicit `off` is what keeps the role
       — a region a person can navigate to and read on demand — without the flood the role
       would otherwise turn on (rule 11). Deleting it is the regression this line exists
       to catch. */
    expect(pane.getAttribute("aria-live")).toBe("off");
    // The lines inside it are a list, and the list is not a live region either.
    expect(within(pane).getByRole("listbox", { name: /^Output of build/ })).toBeTruthy();
  });
});

describe("Agents: health in the name, before the id", () => {
  it("names every card with its state first and groups the hosts as regions", async () => {
    renderChrome(h);
    await goTo("Agents");
    await screen.findAllByRole("region", { name: /^Host / });

    /* The same ordering the run rows take: "degraded, gemini" rather than "gemini,
       degraded". It is what makes a greyscale screenshot readable *and* what a screen
       reader says first, which are the same claim from two directions (rules 3 and 4). */
    for (const agent of AGENTS) {
      const { word } = AGENT_HEALTH_PRESENTATION[agent.state];
      const card = screen.getByRole("article", { name: `${word}, ${agent.id}` });
      expect(card.getAttribute("aria-label")!.startsWith(word)).toBe(true);
    }

    // The claims are their own named region, not a fourth column on a card.
    expect(screen.getByRole("region", { name: "Claimed work" })).toBeTruthy();
    // Nothing on this surface announces: an agent going quiet is not an interruption.
    expect(document.querySelectorAll(".orca-agents [aria-live]")).toHaveLength(0);
  });

  it("names both of the surface's writes by the object they act on (#176)", async () => {
    renderChrome(h);
    await goTo("Agents");
    await screen.findAllByRole("region", { name: /^Host / });

    /* Four cards on screen means four **Permissions** buttons, and a name that was the word
       alone would be four identical controls. Each one names its agent, which is also what
       makes the button and the palette's keyless row read as the same command. */
    for (const agent of AGENTS) {
      expect(screen.getByRole("button", { name: `Permissions for ${agent.id}` })).toBeTruthy();
    }

    /* The same for **Release**: the one that will fire names its work item, and the one the
       daemon would refuse is disabled with the reason reachable *on* the control rather than
       only on hover — `Button` uses `aria-disabled` and keeps the element focusable for
       exactly this (docs/design/40-connection-states.md). */
    expect(screen.getByRole("button", { name: "Release wi-3" })).toBeTruthy();
    const refused = screen.getByRole("button", { name: "Release" });
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.hasAttribute("disabled")).toBe(false);
    expect(refused.getAttribute("title")).toContain("The run could still resume");
  });

  it("announces a release into the one region, and grows no region of its own", async () => {
    renderChrome(h);
    await goTo("Agents");
    const announcer = announcers()[0]!;

    fireEvent.click(await screen.findByRole("button", { name: "Release wi-3" }));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Release wi-3" })).getByRole("menuitem", {
        name: /^Release wi-3/,
      }),
    );

    /* A write this app made is not something the daemon pushes, so it goes through
       `useAnnounce()` into the *same* region every notification does — and the surface grows
       no second one for it (AGENTS.md, "`renderer/src/a11y/` is not a surface"). */
    await waitFor(() => expect(announcer.textContent).toContain("wi-3 is released"));
    expect(document.querySelectorAll(".orca-agents [aria-live]")).toHaveLength(0);
    expect(announcers()).toHaveLength(1);
  });

  it("labels every control in the policy panel, and adds no live region there either", async () => {
    renderChrome(h);
    await goTo("Agents");
    fireEvent.click(await screen.findByRole("button", { name: "Permissions for claude" }));

    const panel = await screen.findByRole("complementary", { name: "Permissions for claude" });
    // Two named sections, so the read-only half and the editable half are distinguishable
    // by name rather than by position on the screen.
    expect(within(panel).getByRole("region", { name: "Configured rules" })).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "Written grants" })).toBeTruthy();

    // Every control the panel draws has a name: a form over a file must be readable aloud.
    for (const control of within(panel).getAllByRole("button")) {
      expect((control.getAttribute("aria-label") ?? control.textContent ?? "").trim()).not.toBe("");
    }
    for (const box of within(panel).getAllByRole("textbox")) {
      expect(box.getAttribute("id")).toBeTruthy();
      expect(panel.querySelector(`label[for="${box.getAttribute("id")}"]`)).toBeTruthy();
    }
    expect(panel.querySelectorAll("[aria-live]")).toHaveLength(0);
  });
});

describe("Workflow: a graph read as a list, with the status first", () => {
  /**
   * The fourth surface (#177). It is the one that is not a list of rows — a canvas — which
   * is exactly why it is in this sweep: the claims below are the app's rather than a
   * component's, and a canvas is where they are easiest to lose.
   *
   * axe itself is not run here. The Electron smoke test runs it over each *audited* surface
   * in both themes (`test/smoke/app-shell.spec.ts`), and Config is still in that file's
   * unbuilt list because it *is* unbuilt until a workflow is named — a viewer reached by
   * link does not change what `⌘5` lands on.
   */
  async function openWorkflow(url: string): Promise<HTMLElement> {
    cleanup();
    while (teardown.length) teardown.pop()?.();
    fake = installBridge({ deepLink: url });
    teardown.push(fake.install());
    h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    return screen.findByRole("listbox", { name: /graph$/ });
  }

  it("is one tab stop with aria-activedescendant, never a node per tab", async () => {
    const canvas = await openWorkflow("orca://workflow/ai-sdlc");
    expect(canvas.getAttribute("tabindex")).toBe("0");
    const options = within(canvas).getAllByRole("option");
    expect(options).toHaveLength(16);
    // Selection is an attribute on the container, not focus on sixteen elements (rule 10).
    expect(options.some((option) => option.hasAttribute("tabindex"))).toBe(false);
    for (const option of options) expect(option.hasAttribute("aria-selected")).toBe(true);
  });

  it("puts the status word first in an overlaid node's name, and says which were not taken", async () => {
    const canvas = await openWorkflow("orca://workflow/sdlc?run=run-parent");
    await waitFor(() =>
      expect(
        within(canvas)
          .getAllByRole("option")
          .some((o) => (o.getAttribute("aria-label") ?? "").startsWith("succeeded")),
      ).toBe(true),
    );
    const names = within(canvas)
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label") ?? "");
    // "succeeded, agent, Build: plan and implement, attempt 2" — the word before anything
    // else, which is the same claim the run rows make (rules 3 and 4).
    expect(names.some((name) => name.startsWith("succeeded") && name.includes("attempt 2"))).toBe(true);
    expect(names.some((name) => name.startsWith("running") && name.includes("current node"))).toBe(true);
    // Untaken is in the name, not only in the opacity: opacity is not a channel a reader has.
    expect(names.some((name) => name.endsWith("not taken"))).toBe(true);
  });

  it("keeps every option inside a listbox, and every listbox holding options", async () => {
    /* The claim a role attribute cannot make on its own. An `option` is defined by the
       `listbox` that owns it, and this canvas positions its boxes through three nested
       divs — the panned scene, the edge plane, the absolutely-placed box — any of which
       would break that ownership by being an unnamed generic in between. They are all
       `role="presentation"`.

       The second half is the group boxes: an expanded container's nodes are drawn *outside*
       the viewport, so they are options of a listbox of their own or of nothing at all. */
    const canvas = await openWorkflow("orca://workflow/sdlc");
    const fanout = within(canvas)
      .getAllByRole("option")
      .find((option) => (option.getAttribute("aria-label") ?? "").includes("Fan out"))!;
    fireEvent.click(fanout);
    act(() => canvas.focus());
    fireEvent.keyDown(canvas, { key: "Enter", code: "Enter" });
    // Two branches, so two group boxes: the `parallel`'s `auth-ui` and its `auth-docs`.
    expect(await screen.findAllByRole("region", { name: /^Inside Fan out/ })).toHaveLength(2);

    const listboxes = screen.getAllByRole("listbox");
    // More than the viewport: each expanded branch is one, named for itself.
    expect(listboxes.length).toBeGreaterThan(1);
    for (const listbox of listboxes) {
      expect(listbox.getAttribute("aria-label")).toBeTruthy();
      expect(within(listbox).getAllByRole("option").length).toBeGreaterThan(0);
    }
    for (const option of screen.getAllByRole("option")) {
      expect(option.closest('[role="listbox"]'), option.id).not.toBeNull();
    }
  });

  it("adds no live region of its own, and keeps the chrome's one announcer", async () => {
    await openWorkflow("orca://workflow/sdlc?run=run-parent");
    expect(announcers()).toHaveLength(1);
    // A graph that redrew on every push would be the streaming-output mistake in another
    // place (rule 11): nothing on this surface speaks.
    expect(document.querySelectorAll(".orca-wf [aria-live]")).toHaveLength(0);
    expect(politeRegions().length).toBeLessThanOrEqual(2);
  });
});

describe("Config: a form of named fields, and one region that speaks", () => {
  it("names every field and its error without adding a live region of its own", async () => {
    renderChrome(h);
    await goTo("Config");
    await screen.findByRole("region", { name: "Agents" });

    /* Every control is reachable by its label, which is what `ConfigField` wiring the ids
       is for: a form whose inputs are labelled by position is a form a screen reader reads
       as a list of empty boxes. */
    expect(screen.getByLabelText(/^Command/)).toBeTruthy();
    expect(screen.getByLabelText(/^Store dir/)).toBeTruthy();
    // Both documents are named regions, told apart by the file they are.
    expect(screen.getByRole("textbox", { name: "orca.permissions.json" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Permissions" })).toBeTruthy();

    /* Nothing on this surface speaks at all. A field's error is described, not announced —
       it is on the control the person is editing, and rule 11 keeps interruption for the
       things a person is not already looking at. The one sentence that is announced is the
       result of a Validate or a Save, and it goes to the app's one announcer (#175). */
    expect(
      document.querySelectorAll(".orca-config [role=alert], .orca-config [role=status], .orca-config [aria-live]"),
    ).toHaveLength(0);
    expect(announcers()).toHaveLength(1);
  });

  it("says a save happened in the app's one region, from the surface that did it", async () => {
    renderChrome(h);
    await goTo("Config");
    const command = await screen.findByLabelText(/^Command/);
    const announcer = announcers()[0]!;

    fireEvent.change(command, { target: { value: "claude-code-next" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    // The same element the run transitions come out of: one region, two kinds of sentence.
    await waitFor(() => expect(announcer.textContent).toBe("Config saved"));
    expect(announcers()).toHaveLength(1);
  });
});

describe("Plan: two lists, one tab stop each, and nothing that speaks", () => {
  /**
   * The fifth surface (#170). It is the first with *two* lists on one screen — the
   * schedule table and the plan journal — which is why it is in this sweep: "one scope
   * holds one `VirtualList`" is an app-level claim, and so is the one announcer.
   */
  async function goToPlan(): Promise<HTMLElement> {
    renderChrome(h);
    await goTo("Plan");
    return screen.findByRole("listbox", { name: "Schedule" });
  }

  it("is one tab stop with aria-activedescendant, and selection survives focus leaving", async () => {
    const table = await goToPlan();
    expect(table.getAttribute("tabindex")).toBe("0");

    const options = within(table).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    // Selection is an attribute on the container, never focus on nine rows (rule 10).
    expect(options.some((option) => option.hasAttribute("tabindex"))).toBe(false);
    for (const option of options) expect(option.hasAttribute("aria-selected")).toBe(true);

    fireEvent.keyDown(table, { key: "End", code: "End" });
    await waitFor(() => expect(table.getAttribute("aria-activedescendant")).toBeTruthy());
    const selected = table.getAttribute("aria-activedescendant");

    const filter = screen.getByRole("searchbox", { name: "Filter work items" });
    filter.focus();
    expect(document.activeElement).toBe(filter);
    expect(table.getAttribute("aria-activedescendant")).toBe(selected);
  });

  it("names every classification in words, so a greyscale row still reads", async () => {
    const table = await goToPlan();
    const text = within(table)
      .getAllByRole("option")
      .map((row) => row.textContent ?? "");
    // The badge's word, not only its tint and not only its glyph (rules 3 and 4).
    expect(text.some((row) => row.includes("ready"))).toBe(true);
    expect(text.some((row) => row.includes("waiting on deps"))).toBe(true);
    expect(text.some((row) => row.includes("held"))).toBe(true);
    // And the two settled ones, in the run statuses' words.
    expect(text.some((row) => row.includes("succeeded"))).toBe(true);
    expect(text.some((row) => row.includes("failed"))).toBe(true);
  });

  it("gives the journal its own list and its own scope, and adds no live region", async () => {
    await goToPlan();
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    const journal = await screen.findByRole("listbox", { name: "Plan journal" });

    expect(journal.getAttribute("tabindex")).toBe("0");
    // The scope is marked on the substrate's root, which is what resolution walks out to.
    expect(journal.closest("[data-kbd-scope]")?.getAttribute("data-kbd-scope")).toBe("plan-journal");
    // The chrome's one announcer, still one; nothing on Plan speaks — a schedule that
    // repainted out loud would be the streaming-output mistake in another place (rule 11).
    expect(announcers()).toHaveLength(1);
    expect(document.querySelectorAll(".orca-plan [aria-live]")).toHaveLength(0);
    expect(politeRegions().length).toBeLessThanOrEqual(2);
  });

  /**
   * The whole sweep for this surface, not just `aria-live`: `role="status"` and
   * `role="alert"` are live regions too — the role implies the behaviour — and a surface
   * that repainted inside one would announce every frame without ever writing
   * `aria-live` (rule 11).
   *
   * **One exception, and it is the app's rather than Plan's: the stale banner.** It is the
   * same element on every surface that has one — `.orca-banner.orca-banner--stale` with
   * `role="status"`, saying that what is on screen is the last the daemon said — on Runs
   * (`runs-surface.tsx`), Attention (`attention-surface.tsx`), Config
   * (`config-surface.tsx`), Plan (`plan-surface.tsx`) and in the chrome itself
   * (`App.tsx`'s deep-link landing, `chrome/connection-banner.tsx`). It is *not* moved
   * above the surfaces here: each one puts it inside its own scroll and stale region, at
   * the top of the pane it makes a claim about, and a single banner in the chrome would
   * have to say "something on this screen is stale" without saying which pane — which is
   * a worse sentence and a bigger change than this review. So it is excluded by pattern,
   * and the assertion below is that Plan mounts *nothing else* that speaks.
   *
   * `toHaveLength(0)` rather than a cap: a surface either mounts a region or it does not.
   */
  it("mounts no live region of its own, in either mode — only the app's stale banner", async () => {
    const speaking = (): Element[] =>
      [...document.querySelectorAll(".orca-plan [role=status], .orca-plan [role=alert], .orca-plan [aria-live]")].filter(
        // The app's shared banner, used identically on every surface that has one.
        (element) => element.closest(".orca-banner--stale") === null,
      );

    await goToPlan();
    expect(speaking()).toHaveLength(0);

    // With a row selected, which is what puts the inspector in the dock.
    const table = await screen.findByRole("listbox", { name: "Schedule" });
    fireEvent.keyDown(table, { key: "Home", code: "Home" });
    await waitFor(() => expect(table.getAttribute("aria-activedescendant")).toBeTruthy());
    expect(speaking()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    await screen.findByRole("listbox", { name: "Plan journal" });
    expect(speaking()).toHaveLength(0);
    expect(announcers()).toHaveLength(1);
  });

  /**
   * The journal's rows are selectable. They were not: `selectedIndex` was `undefined` with
   * a no-op `onSelect`, so `J`, `K` and the arrows scrolled the list and
   * `aria-activedescendant` was never set — which is the whole of how a screen reader is
   * told where it is in a listbox, and is the same claim this file makes about every other
   * list in the app (rule 10).
   */
  it("moves the journal's selection with the keys, and says where it is", async () => {
    await goToPlan();
    fireEvent.click(screen.getByRole("button", { name: "Journal" }));
    const journal = await screen.findByRole("listbox", { name: "Plan journal" });
    await waitFor(() => expect(within(journal).getAllByRole("option").length).toBeGreaterThan(1));

    expect(journal.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(journal, { key: "j", code: "KeyJ" });
    await waitFor(() => expect(journal.getAttribute("aria-activedescendant")).toBeTruthy());
    const first = journal.getAttribute("aria-activedescendant");
    // The selected row is the one named, and it is marked as selected rather than focused.
    const selected = within(journal)
      .getAllByRole("option")
      .find((option) => option.id === first)!;
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.hasAttribute("tabindex")).toBe(false);

    fireEvent.keyDown(journal, { key: "j", code: "KeyJ" });
    await waitFor(() => expect(journal.getAttribute("aria-activedescendant")).not.toBe(first));
  });
});

/* ---------- the frames the announcer is fed ---------- */

const ENVELOPE = { subscriptionId: "sub-1", runId: "run-parent", seq: 7, at: "2026-03-01T09:00:07.000Z" } as const;

const stepChanged = (params: Record<string, unknown>): NotificationMessage => ({
  kind: "notification",
  method: "step.changed",
  params: { ...ENVELOPE, stepRunId: "s-build-2", event: "step.changed", ...params },
});

const runChanged = (status: string): NotificationMessage => ({
  kind: "notification",
  method: "run.changed",
  params: { ...ENVELOPE, status, event: `run.${status}` },
});
