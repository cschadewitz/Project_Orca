// @vitest-environment happy-dom
/**
 * The two writes the Agents surface gained in #176: releasing a dead run's claim, and
 * opening an agent's permission policy.
 *
 * It is a file of its own rather than more cases in `agents-surface.test.tsx`, which is the
 * read half and is long already — the split is the same one `attention-surface.test.tsx` and
 * `attention-cards.test.tsx` make.
 *
 * The claims fixture is what makes this testable without scripting anything: `wi-2` is held
 * by a run that is still running (`releasable: false`, which the daemon would refuse) and
 * `wi-3` by a run whose log is gone (`releasable: true`). One of each, so the control's two
 * states are both real rather than both arranged.
 *
 * **Release asks in place.** Pressing it arms the row — Keep and ✕ Confirm release, the
 * danger tone, the consequence on a second line — and only Confirm sends anything. happy-dom
 * does not move focus on a click the way a browser does, so a "click" here is `focus()` and
 * then `click`, which is what a person's press does in the app.
 *
 * **A released row leaves.** The default fake answers `claims.list` from a fixture that never
 * changes, so every row in "releasing a claim" outlives its own release. The real daemon takes
 * the claim out of the store, and `holding` below is a daemon that does — which is what makes
 * where focus goes after a row leaves the list something a test can see.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { THEMES } from "@orca/design";
import type { ClaimView } from "@orca/protocol";
import { AgentsSurface } from "../src/agents/agents-surface.js";
import { ConfigProvider } from "../src/config/config-context.js";
import { phraseText, releaseConsequence, releaseRefusal } from "../src/agents/agent-groups.js";
import { useEscapeClosesTopLayer } from "../src/layers-context.js";
import { commandEntries } from "../src/palette/entries.js";
import { AGENTS_LIST } from "./fixtures-agents.js";
import { AS_OF, CLAIMS, HELLO_READ_ONLY } from "./fixtures.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { expectedToken, installDesignSystem, installSurfaceStyles, resolved, setTheme } from "./themes.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

/** The one global `Esc`, which the chrome registers in the app and a surface test must add. */
function Escape(): null {
  useEscapeClosesTopLayer();
  return null;
}

function renderAgents(connection: "live" | "disconnected" = "live"): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <Escape />
      {/* The app's one draft model, which `App` mounts above the surface switch: the
          policy panel reads it rather than holding its own (#175). */}
      <ConfigProvider>
        <AgentsSurface connection={connection} onOpen={() => {}} />
      </ConfigProvider>
    </Providers>,
  );
}

const claimRows = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole("region", { name: "Claimed work" })).getAllByRole("listitem");

/**
 * The row for one work item — `wi-3` is the one whose owner has vanished. Found by the id its
 * token carries in its title: a row leads with the work item's title, not its id.
 */
const isRowFor = (row: HTMLElement, workItemId: string): boolean =>
  row.querySelector(`.orca-objid[title="${workItemId}"]`) !== null;
const claimRow = async (workItemId: string): Promise<HTMLElement> => {
  const row = (await claimRows()).find((r) => isRowFor(r, workItemId));
  if (!row) throw new Error(`no claim row for ${workItemId}`);
  return row;
};

/** `wi-3`'s title, which is what its controls are named by. */
const DEAD = "Document the rollout";

/** A press, as the app sees one: focus moves to the control, then it is clicked. */
function press(control: HTMLElement): void {
  act(() => control.focus());
  fireEvent.click(control);
}

/** A key pressed where focus is, which is what the window listener sees in the app. */
function key(name: string): void {
  fireEvent.keyDown(document.activeElement ?? window, { key: name, code: name });
}

/** Arm `wi-3`'s row and hand back the row and its two choices. */
async function arm(): Promise<{ row: HTMLElement; keep: HTMLElement; confirm: HTMLElement }> {
  const row = await claimRow("wi-3");
  press(within(row).getByRole("button", { name: `Release ${DEAD}` }));
  return {
    row,
    keep: within(row).getByRole("button", { name: "Keep" }),
    confirm: within(row).getByRole("button", { name: `Confirm release of ${DEAD}` }),
  };
}

/** Release `wi-3` the whole way: Release, then Confirm. */
async function releaseDead(): Promise<void> {
  press((await arm()).confirm);
}

const releaseCalls = (): unknown[] =>
  fake.calls.filter((call) => call.method === "claims.release").map((call) => call.params);

/** A claim whose run has finished, so the daemon lets it go: `wi-3`'s shape under another item. */
function finished(workItemId: string, title: string): ClaimView {
  return {
    ...CLAIMS[1]!,
    workItemId,
    workItem: { ...CLAIMS[1]!.workItem!, id: workItemId, slug: workItemId, title },
    owner: {
      runId: `run-${workItemId}`,
      name: `${workItemId}-run`,
      status: "succeeded",
      missing: false,
      releasable: true,
    },
  };
}

/** `wi-9`, a releasable claim to put after `wi-3`. */
const AUDIT = finished("wi-9", "Ship the audit log");

/**
 * A daemon holding these claims, in this order, that does what the real one does with a
 * release: the claim leaves the store, so the re-read after it no longer has it and its row
 * leaves the list.
 */
function holding(claims: readonly ClaimView[]): void {
  let held = [...claims];
  fake.script({
    "agents.list": () => ({ ok: true, result: { ...AGENTS_LIST, claims: held } }),
    "claims.list": () => ({ ok: true, result: { claims: held, asOf: AS_OF } }),
    "claims.release": ({ workItemId }) => {
      const claim = held.find((c) => c.workItemId === workItemId);
      if (!claim) return { ok: false, error: { code: "CLAIM_NOT_FOUND", message: `${workItemId} is not claimed` } };
      held = held.filter((c) => c !== claim);
      return { ok: true, result: { claim, asOf: AS_OF } };
    },
  });
}

/** Wait for a work item's row to have left the list. */
async function gone(workItemId: string): Promise<void> {
  await waitFor(() => {
    const rows = within(screen.getByRole("region", { name: "Claimed work" })).queryAllByRole("listitem");
    expect(rows.some((row) => row.textContent?.startsWith(workItemId))).toBe(false);
  });
}

beforeEach(() => {
  fake = installBridge();
  teardown.push(fake.install());
});
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
  setTheme(undefined);
});

describe("what a refusal is called", () => {
  it("says nothing about a claim the daemon would release", () => {
    expect(releaseRefusal(CLAIMS[1]!)).toBeUndefined();
  });

  it("names the run and its status, and points at the two ordinary ways out", () => {
    const reason = releaseRefusal(CLAIMS[0]!);
    expect(reason).toContain("The run could still resume");
    expect(reason).toContain("Add the SSO callback is running");
    expect(reason).toContain("Resume or cancel it first");
    // Force is named as a command-line act and is not offered as a control here.
    expect(reason).toContain("command line");
  });

  it("names the work, says what happens to it and who loses it, and predicts nothing beyond", () => {
    const phrases = releaseConsequence(CLAIMS[1]!);
    // Subject first, so a row cut short still says what it is about — and it is the title,
    // which is what a person knows the work by, in sans.
    expect(phrases[0]).toEqual({ text: DEAD });
    const words = phraseText(phrases);
    expect(words).toBe(
      `${DEAD} goes back to the scheduler. ☰ run-vanished loses its claim on it, and another run may claim it.`,
    );
    // The run has no name, so it is its id token — never the raw id — and that is the one
    // phrase set in mono (rule 8).
    expect(phrases.filter((phrase) => phrase.machine).map((phrase) => phrase.text)).toEqual(["☰ run-vanished"]);
    // Sentence case, no apology, no exclamation (rule 13).
    expect(words).not.toMatch(/[!]|sorry|oops/i);
  });

  it("falls back to the work item's id token, in mono, when the item has no title", () => {
    const untitled: ClaimView = { ...CLAIMS[1]!, workItem: undefined };
    expect(releaseConsequence(untitled)[0]).toEqual({ text: "⬡ wi-3", machine: true });
  });

  it("names a run with no name by its token in words, never its raw id", () => {
    const unnamed: ClaimView = {
      ...CLAIMS[0]!,
      owner: { ...CLAIMS[0]!.owner, name: undefined, runId: "run_01M4M8A1WDAQMMX98Q6KJH7X8P" },
    };
    expect(releaseRefusal(unnamed)).toContain("run JH7X8P is running");
    expect(releaseRefusal(unnamed)).not.toContain("run_01M4M8A1WDAQMMX98Q6KJH7X8P");
  });
});

describe("the claim row's ids", () => {
  it("leads with the work item's title and the run's name, each followed by its id token", async () => {
    renderAgents();
    const alive = await claimRow("wi-2");
    // No raw id column first: the row starts with what a person calls the work.
    expect(alive.textContent?.startsWith("Wire the login button")).toBe(true);
    const tokens = [...alive.querySelectorAll(".orca-objid")];
    expect(tokens.map((token) => token.getAttribute("title"))).toEqual(["wi-2", "run-parent"]);
    // Faint, because a name leads each one.
    for (const token of tokens) expect(token.className).toContain("orca-objid--faint");
    expect(alive.querySelector(".orca-agents__claim-run")?.textContent).toContain("Add the SSO callback");
  });

  it("draws an untitled item and an unnamed run as their tokens alone", async () => {
    renderAgents();
    const dead = await claimRow("wi-3");
    const run = dead.querySelector(".orca-agents__claim-run .orca-objid")!;
    expect(run.getAttribute("title")).toBe("run-vanished");
    expect(run.className).not.toContain("orca-objid--faint");
  });
});

describe("releasing a claim", () => {
  it("offers Release on a claim whose owner cannot resume, and refuses the one that can", async () => {
    renderAgents();
    const dead = await claimRow("wi-3");
    const alive = await claimRow("wi-2");

    // Named by the work it acts on, not the raw id: the title is what identifies the work.
    expect(within(dead).getByRole("button", { name: `Release ${DEAD}` })).toBeTruthy();

    // The other one is disabled with the daemon's own prediction on it, not absent: the
    // claim is real and the reason it cannot be released is the thing worth reading.
    const refused = within(alive).getByRole("button", { name: "Release Wire the login button" });
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.getAttribute("title")).toContain("The run could still resume");
  });

  it("rests quiet: no danger tone and no ✕ on a row nobody has asked about", async () => {
    renderAgents();
    for (const row of await claimRows()) {
      const release = within(row).getByRole("button", { name: /^Release / });
      // Status colour is the only saturation a resting screen carries (the brand book).
      expect(release.className).not.toContain("orca-btn--danger");
      expect(row.textContent).not.toContain("✕");
      expect(row.className).not.toContain("orca-agents__claim--armed");
    }
  });

  it("arms in place: the danger tone, Keep focused first, and nothing sent", async () => {
    renderAgents();
    const { row, keep, confirm } = await arm();

    // The row takes the danger tone and its declared two-line variant (rule 9).
    expect(row.className).toContain("orca-agents__claim--armed");
    expect(row.className).toContain("orca-agents__claim--note");

    // Keep comes first and holds focus, so a second Enter keeps the claim
    // (docs/design/20-attention-and-gates.md: never focused by default, never first).
    expect(document.activeElement).toBe(keep);
    const choices = within(row).getAllByRole("button");
    expect(choices.indexOf(keep)).toBeLessThan(choices.indexOf(confirm));
    expect(keep.className).not.toContain("orca-btn--danger");

    // Arming sent nothing at all.
    expect(releaseCalls()).toEqual([]);
  });

  it("draws Confirm in the danger tone with its ✕, named for the work and described by what it does", async () => {
    renderAgents();
    const { row, confirm } = await arm();

    expect(confirm.className).toContain("orca-btn--danger");
    // The glyph as well as the colour (rule 4), and kept out of the accessible name.
    const glyph = confirm.querySelector('[aria-hidden="true"]');
    expect(glyph?.textContent).toBe("✕");
    expect(confirm.textContent).toBe("✕Confirm release");

    // The consequence is the second line, and Confirm is described by it.
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const consequence = document.getElementById(describedBy!)!;
    expect(row.contains(consequence)).toBe(true);
    // The whole sentence in its title, because it truncates rather than wrapping. The text
    // says the same, except that the run's token says its kind as a word (visually hidden)
    // where the title shows its glyph.
    expect(consequence.getAttribute("title")).toBe(phraseText(releaseConsequence(CLAIMS[1]!)));
    expect(consequence.textContent).toBe(
      `${DEAD} goes back to the scheduler. ☰run run-vanished loses its claim on it, and another run may claim it.`,
    );
    // The run in mono — as its id token, since it has no name — and the title in sans (rule 8).
    expect([...consequence.querySelectorAll(".orca-objid")].map((span) => span.textContent)).toEqual([
      "☰run run-vanished",
    ]);

    // A screen reader entering the controls hears the question it is being asked.
    const group = within(row).getByRole("group", { name: `Release ${DEAD}?` });
    expect(group.getAttribute("aria-describedby")).toBe(describedBy);
  });

  it("disarms on Keep, sends nothing, and gives focus back to Release", async () => {
    renderAgents();
    const { row, keep } = await arm();

    press(keep);

    expect(row.className).not.toContain("orca-agents__claim--armed");
    expect(row.className).not.toContain("orca-agents__claim--note");
    expect(within(row).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(document.activeElement).toBe(within(row).getByRole("button", { name: `Release ${DEAD}` }));
    expect(releaseCalls()).toEqual([]);
  });

  it("disarms on Esc through the transient layer stack, and gives focus back to Release", async () => {
    renderAgents();
    expect(h.layers.depth).toBe(0);
    const { row } = await arm();
    // On the stack while it asks, like every other transient thing `Esc` unwinds.
    expect(h.layers.top()?.name).toBe("release-confirm");

    key("Escape");

    expect(h.layers.depth).toBe(0);
    expect(row.className).not.toContain("orca-agents__claim--armed");
    expect(document.activeElement).toBe(within(row).getByRole("button", { name: `Release ${DEAD}` }));
    expect(releaseCalls()).toEqual([]);
  });

  it("disarms when focus leaves the row, and leaves focus where it went", async () => {
    renderAgents();
    const { row } = await arm();
    const elsewhere = screen.getByRole("button", { name: "Permissions for claude" });

    act(() => elsewhere.focus());

    expect(row.className).not.toContain("orca-agents__claim--armed");
    expect(within(row).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    expect(h.layers.depth).toBe(0);
    expect(releaseCalls()).toEqual([]);
  });

  it("stays armed while focus moves between its own two choices", async () => {
    renderAgents();
    const { row, confirm } = await arm();

    act(() => confirm.focus());

    expect(row.className).toContain("orca-agents__claim--armed");
    expect(document.activeElement).toBe(confirm);
  });

  it("asks about one row at a time: arming a second disarms the first", async () => {
    const second: ClaimView = {
      ...CLAIMS[1]!,
      workItemId: "wi-9",
      workItem: { ...CLAIMS[1]!.workItem!, id: "wi-9", slug: "audit-log", title: "Ship the audit log" },
      owner: { runId: "run-done", name: "audit-log-run", status: "succeeded", missing: false, releasable: true },
    };
    fake.script({ "agents.list": () => ({ ok: true, result: { ...AGENTS_LIST, claims: [...CLAIMS, second] } }) });
    renderAgents();

    const { row: first } = await arm();
    const other = await claimRow("wi-9");
    press(within(other).getByRole("button", { name: "Release Ship the audit log" }));

    expect(first.className).not.toContain("orca-agents__claim--armed");
    expect(other.className).toContain("orca-agents__claim--armed");
    expect(screen.getAllByRole("button", { name: "Keep" })).toHaveLength(1);
    expect(document.activeElement).toBe(within(other).getByRole("button", { name: "Keep" }));
    expect(h.layers.depth).toBe(1);
    expect(releaseCalls()).toEqual([]);
  });

  it("calls claims.release exactly once on Confirm, never forced, then holds focus on the busy Release", async () => {
    renderAgents();
    const { row, confirm } = await arm();

    press(confirm);

    // Focus goes back to the control it came from, which is now busy rather than gone.
    const release = within(row).getByRole("button", { name: `Release ${DEAD}` });
    expect(document.activeElement).toBe(release);
    expect(release.getAttribute("aria-disabled")).toBe("true");
    expect(row.className).not.toContain("orca-agents__claim--armed");

    await waitFor(() => expect(releaseCalls()).toHaveLength(1));
    // Never forced: a run that could still resume is refused, and this one cannot.
    expect(releaseCalls()[0]).toEqual({ workItemId: "wi-3" });
    await waitFor(async () =>
      expect((await claimRow("wi-3")).textContent).toContain("released and back with the scheduler"),
    );
    expect(releaseCalls()).toHaveLength(1);
  });

  it("calls claims.release, announces the note, and shows it on the row", async () => {
    const said: string[] = [];
    renderAgents();
    teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));

    await releaseDead();

    await waitFor(async () =>
      expect((await claimRow("wi-3")).textContent).toContain("released and back with the scheduler"),
    );
    // Named by its title, which is what a person knows the work by — not its id.
    expect(said.join(" ")).toContain(`${DEAD} is released`);
  });

  it("shows and announces the daemon's note, when releasing did not fix everything", async () => {
    /* The note is what a release did *not* fix: a dead run's log never moves on, so the item
       can still read in-progress and the scheduler still treats it as running (#123). A
       person who released a claim and saw nothing change would otherwise have no way to
       learn why, so it is both said in the one live region and left on the row. */
    const note = "wi-3 is still in-progress (run run-vanished); the plan scheduler treats it as running";
    fake.script({
      "claims.release": () => ({ ok: true, result: { claim: CLAIMS[1]!, note, asOf: AS_OF } }),
    });

    const said: string[] = [];
    renderAgents();
    teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));

    await releaseDead();

    await waitFor(async () => expect((await claimRow("wi-3")).textContent).toContain(note));
    expect(said.join(" ")).toContain(note);
  });

  it("takes the declared two-line variant for the note, and leaves every other row one line", async () => {
    /* RULES.md rule 9: a row that needs two lines is a declared variant, not a row that
       grew. The base row wrapped for everybody, so any claim with a long title could push
       the list out of the rhythm the density sets; now the second line is asked for. */
    const note = "wi-3 is still in-progress (run run-vanished); the plan scheduler treats it as running";
    fake.script({ "claims.release": () => ({ ok: true, result: { claim: CLAIMS[1]!, note, asOf: AS_OF } }) });
    renderAgents();

    for (const row of await claimRows()) expect(row.className).not.toContain("orca-agents__claim--note");

    await releaseDead();

    await waitFor(async () => expect((await claimRow("wi-3")).className).toContain("orca-agents__claim--note"));
    // Only the row the note is about; the rest of the list is unchanged.
    const others = (await claimRows()).filter((row) => !isRowFor(row, "wi-3"));
    expect(others.length).toBeGreaterThan(0);
    for (const row of others) expect(row.className).not.toContain("orca-agents__claim--note");
  });

  it("re-reads the claims once after a release, because nothing pushes for one", async () => {
    renderAgents();
    await claimRows();
    expect(fake.calls.filter((c) => c.method === "claims.list")).toHaveLength(0);

    await releaseDead();

    // One read, on purpose: a release journals nothing, so there is no notification to wait
    // for and no reason to ask twice.
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "claims.list")).toHaveLength(1));
  });

  it("says why on the row when the daemon refuses", async () => {
    fake.script({
      "claims.release": () => ({ ok: false, error: { code: "RUN_STATE", message: "run-vanished is running" } }),
    });
    renderAgents();

    await releaseDead();

    await waitFor(async () => expect((await claimRow("wi-3")).textContent).toContain("RUN_STATE"));
  });

  it("offers no Release at all against a daemon that has no claims.release", async () => {
    /* A `--read-only` daemon leaves the control methods out of `hello.methods` and out of
       its capabilities. A viewer has no greyed buttons on it: writes are absent. */
    fake.script({ hello: () => Promise.resolve({ ok: true, result: HELLO_READ_ONLY }) });
    fake.connect({
      state: "live",
      since: AS_OF,
      capabilities: HELLO_READ_ONLY.capabilities,
      methods: HELLO_READ_ONLY.methods ?? [],
    });
    renderAgents();

    const dead = await claimRow("wi-3");
    expect(within(dead).queryByRole("button")).toBeNull();
  });
});

describe("where focus goes when a released row leaves", () => {
  /* After Confirm, focus is on the row's own busy Release. When the re-read no longer has the
     claim, that row — and the control holding focus — leaves the document, and without
     somewhere to go focus falls to the page body: a keyboard user's place in the list, gone
     with the row. */

  it("moves to the next row's Release when the row was in the middle", async () => {
    holding([CLAIMS[0]!, CLAIMS[1]!, AUDIT]);
    renderAgents();
    const next = within(await claimRow("wi-9")).getByRole("button", { name: "Release Ship the audit log" });

    await releaseDead();
    await gone("wi-3");

    // The row that slid into the gap: where the next Tab from the released row would have gone.
    expect(document.activeElement).toBe(next);
  });

  it("moves to the previous row's Release when the row was the last", async () => {
    holding([CLAIMS[0]!, CLAIMS[1]!]);
    renderAgents();
    const previous = within(await claimRow("wi-2")).getByRole("button", { name: "Release Wire the login button" });

    await releaseDead();
    await gone("wi-3");

    /* Refused, and still a stop: `Button` disables with `aria-disabled` rather than the
       attribute so the reason stays reachable, and `Tab` would land here as well. */
    expect(document.activeElement).toBe(previous);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
  });

  it("moves to the section when the row was the only one, and the list says it is empty", async () => {
    holding([CLAIMS[1]!]);
    renderAgents();
    const section = await screen.findByRole("region", { name: "Claimed work" });

    await releaseDead();
    await gone("wi-3");

    expect(document.activeElement).toBe(section);
    // Programmatically focusable and never a Tab stop of its own.
    expect(section.getAttribute("tabindex")).toBe("-1");
    expect(section.textContent).toContain("Nothing is claimed right now.");
  });

  it("stays on the same row's Release when the daemon refuses, because the row stays", async () => {
    fake.script({
      "claims.release": () => ({ ok: false, error: { code: "RUN_STATE", message: "run-vanished is running" } }),
    });
    renderAgents();

    await releaseDead();
    await waitFor(async () => expect((await claimRow("wi-3")).textContent).toContain("RUN_STATE"));

    const row = await claimRow("wi-3");
    const release = within(row).getByRole("button", { name: `Release ${DEAD}` });
    expect(document.activeElement).toBe(release);
    // No longer busy, so it can be pressed again from where the person already is.
    await waitFor(() => expect(release.getAttribute("aria-disabled")).toBeNull());
    // The refusal is on the row it was about, and only there.
    expect(document.querySelector(".orca-agents__claims-note")).toBeNull();
  });

  it("does not take focus back from somewhere the person moved it while the release was in flight", async () => {
    holding([CLAIMS[0]!, CLAIMS[1]!, AUDIT]);
    const answer = fake.hold("claims.release");
    renderAgents();

    await releaseDead();
    await waitFor(() => expect(releaseCalls()).toHaveLength(1));
    const elsewhere = screen.getByRole("button", { name: "Permissions for claude" });
    act(() => elsewhere.focus());

    answer();
    await gone("wi-3");

    expect(document.activeElement).toBe(elsewhere);
  });

  it("says the result under the section's heading once its row has gone, and still announces it", async () => {
    holding([CLAIMS[0]!, CLAIMS[1]!, AUDIT]);
    const said: string[] = [];
    renderAgents();
    teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));
    const section = await screen.findByRole("region", { name: "Claimed work" });

    await releaseDead();
    await gone("wi-3");

    // Said once into the app's one live region, whether or not the row survives.
    expect(said.filter((sentence) => sentence.includes("Document the rollout is released"))).toHaveLength(1);

    /* And left where it can still be read: the section's caption line, under its heading and
       above the rows. It names its work item, so it reads without the row it was about. */
    const note = section.querySelector<HTMLElement>(".orca-agents__claims-note");
    expect(note?.textContent).toBe("Document the rollout is released and back with the scheduler.");
    expect(note?.closest("li")).toBeNull();
    const list = within(section).getByRole("list");
    expect(note!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not a second live region: the announcer has already said it.
    expect(note?.closest("[aria-live], [role='status']")).toBeNull();
    // The rows that stayed are one line each; none of them took the note.
    for (const row of await claimRows()) expect(row.className).not.toContain("orca-agents__claim--note");
  });
});

describe("the policy panel", () => {
  it("opens from the agent card and shows that agent's written grants", async () => {
    renderAgents();
    fireEvent.click(await screen.findByRole("button", { name: "Permissions for claude" }));

    const panel = await screen.findByRole("complementary", { name: "Permissions for claude" });
    expect(within(panel).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(panel.textContent).toContain("allow edit under src");
    // A rule truncates at its end in a narrow panel, so each carries the whole of itself in
    // its title — the accessible name already had it; now a pointer does too.
    const texts = [...panel.querySelectorAll<HTMLElement>(".orca-config__rule-text")];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text.getAttribute("title")).toBe(text.textContent);
    // One read for the app, not one per opening: the draft model is above the surfaces
    // (#175's `ConfigProvider`), so opening the panel asks the daemon nothing new.
    expect(fake.calls.filter((c) => c.method === "config.get")).toHaveLength(1);
  });

  it("keeps the grant edits it is holding when it is closed and opened again", async () => {
    renderAgents();
    fireEvent.click(await screen.findByRole("button", { name: "Permissions for claude" }));
    const panel = await screen.findByRole("complementary", { name: "Permissions for claude" });

    fireEvent.click(within(panel).getByRole("button", { name: "Add a grant" }));
    await screen.findByRole("group", { name: "Unsaved configuration changes" });

    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Permissions for claude" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Permissions for claude" }));

    // The draft outlived the panel, and the file was read once for the whole app.
    await screen.findByRole("group", { name: "Unsaved configuration changes" });
    expect(fake.calls.filter((c) => c.method === "config.get")).toHaveLength(1);
  });
});

describe("the palette", () => {
  it("lists both actions as keyless commands on the objects on this screen", async () => {
    renderAgents();
    // Commands register in effects after the cards render; visible rows alone do not
    // mean the keyboard registry is ready. Wait for the commands themselves.
    await waitFor(() => {
      const entries = commandEntries(h.keyboard.list(), "darwin", ["card", "global"]);
      const permissions = entries.find((entry) => entry.label === "Edit permissions for claude");
      expect(permissions).toBeDefined();
      // Keyless (#205): the palette is the whole of how it is reached, so there is no chip.
      expect(permissions!.shortcut).toBeUndefined();
      expect(permissions!.section).toBe("actions");

      // One per releasable claim, and none for the claim the daemon would refuse. Named by
      // the work item's title and its token, never by its raw id.
      expect(entries.some((entry) => entry.label === `Release claim on ${DEAD} ⬡ wi-3`)).toBe(true);
      expect(entries.some((entry) => entry.objectId === "wi-2")).toBe(false);
    });
  });

  it("makes the release row a destructive one: its id in mono, sunk below the rest, armed before it runs", async () => {
    renderAgents();
    const entries = await waitFor(() => {
      const listed = commandEntries(h.keyboard.list(), "darwin", ["card", "global"]);
      expect(listed.some((entry) => entry.objectId === "wi-3")).toBe(true);
      return listed;
    });
    const release = entries.find((entry) => entry.objectId === "wi-3")!;

    // The work item by its title and its id token: the token is machine text inside a
    // sentence, so the palette sets it in mono (rule 8); the whole id is matched, not drawn.
    expect(release.label).toBe(`Release claim on ${DEAD} ⬡ wi-3`);
    expect(release.labelMachine).toBe("⬡ wi-3");
    // The Plan surface's release row has these two; this one now matches it, so the first
    // Enter arms the row rather than releasing, and it is never the first row on screen.
    expect(release.tone).toBe("danger");
    expect(release.confirm).toBe(`Release ${DEAD} ⬡ wi-3 — confirm`);
    expect(entries[0]?.tone).toBeUndefined();
    expect(entries.indexOf(release)).toBeGreaterThan(entries.findIndex((entry) => entry.tone === undefined));
  });

  it("opens the policy panel when its palette entry runs", async () => {
    renderAgents();
    const entry = await waitFor(() => {
      const registered = commandEntries(h.keyboard.list(), "darwin", ["card"]).find(
        (e) => e.label === "Edit permissions for gemini",
      );
      expect(registered).toBeDefined();
      return registered!;
    });
    // In `act`, because a palette row runs outside React's own event handling: the state it
    // sets would otherwise be flushed at whatever moment the next assertion happened to poll.
    await act(async () => entry.run());
    await screen.findByRole("complementary", { name: "Permissions for gemini" });
  });
});

describe("both themes", () => {
  it("rests Release in the quiet tone and arms Confirm in the danger one, from the real tokens", async () => {
    /* Against the *real* `tokens.css` and `components.css`, per RULES.md rule 7, plus this
       surface's own stylesheet for the armed row's edge. Resting, Release is an ordinary
       control: status colour is the only saturation a resting screen carries. Armed, the
       danger tone is `--status-failed` in both themes, on Confirm's two channels and on the
       row's edge — never a literal. */
    installDesignSystem();
    installSurfaceStyles();
    document.body.classList.add("orca");
    renderAgents();

    const row = await claimRow("wi-3");
    const release = within(row).getByRole("button", { name: `Release ${DEAD}` });
    for (const theme of THEMES) {
      setTheme(theme);
      expect(resolved(release, "color")).toBe(expectedToken(theme, "ink-primary"));
      expect(resolved(release, "color")).not.toBe(expectedToken(theme, "status-failed"));
    }

    const { confirm } = await arm();
    for (const theme of THEMES) {
      setTheme(theme);
      expect(resolved(confirm, "color")).toBe(expectedToken(theme, "status-failed"));
      expect(resolved(confirm, "border-color")).toBe(expectedToken(theme, "status-failed"));
      expect(resolved(row, "border-color")).toBe(expectedToken(theme, "status-failed"));
    }

    document.getElementById("orca-surface-styles")?.remove();
    document.body.classList.remove("orca");
  });

  it("chips a policy row with the design system's own chip, not a local one", async () => {
    installDesignSystem();
    document.body.classList.add("orca");
    renderAgents();
    fireEvent.click(await screen.findByRole("button", { name: "Permissions for claude" }));
    const panel = await screen.findByRole("complementary", { name: "Permissions for claude" });

    /* Both documents are named on the panel, each on `.orca-chip` — the component layer's
       class, so the radius, the height and the padding are the system's and nothing here
       restates them (rule 14). */
    const chips = [...panel.querySelectorAll(".orca-chip")].map((chip) => chip.textContent);
    expect(chips).toContain("config");
    expect(chips).toContain("sidecar");

    document.body.classList.remove("orca");
  });
});
