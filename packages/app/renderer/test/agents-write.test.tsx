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
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { THEMES } from "@orca/design";
import { AgentsSurface } from "../src/agents/agents-surface.js";
import { releaseConsequence, releaseRefusal } from "../src/agents/agent-groups.js";
import { commandEntries } from "../src/palette/entries.js";
import { AS_OF, CLAIMS, HELLO_READ_ONLY } from "./fixtures.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

function renderAgents(connection: "live" | "disconnected" = "live"): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <AgentsSurface connection={connection} onOpen={() => {}} />
    </Providers>,
  );
}

const claimRows = async (): Promise<HTMLElement[]> =>
  within(await screen.findByRole("region", { name: "Claimed work" })).getAllByRole("listitem");

/** The row for one work item — `wi-3` is the one whose owner has vanished. */
const claimRow = async (workItemId: string): Promise<HTMLElement> => {
  const row = (await claimRows()).find((r) => r.textContent?.startsWith(workItemId));
  if (!row) throw new Error(`no claim row for ${workItemId}`);
  return row;
};

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

  it("states the item, the run and the consequence, and predicts nothing beyond them", () => {
    const words = releaseConsequence(CLAIMS[1]!);
    expect(words).toContain("wi-3");
    expect(words).toContain("run-vanished");
    expect(words).toContain("back to the scheduler");
  });
});

describe("releasing a claim", () => {
  it("offers Release on a claim whose owner cannot resume, and refuses the one that can", async () => {
    renderAgents();
    const dead = await claimRow("wi-3");
    const alive = await claimRow("wi-2");

    expect(within(dead).getByRole("button", { name: "Release wi-3" })).toBeTruthy();

    // The other one is disabled with the daemon's own prediction on it, not absent: the
    // claim is real and the reason it cannot be released is the thing worth reading.
    const refused = within(alive).getByRole("button", { name: "Release" });
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.getAttribute("title")).toContain("The run could still resume");
  });

  it("confirms before it calls, states what happens, and can be declined", async () => {
    renderAgents();
    const dead = await claimRow("wi-3");
    fireEvent.click(within(dead).getByRole("button", { name: "Release wi-3" }));

    const menu = await screen.findByRole("menu", { name: "Release wi-3" });
    expect(menu.textContent).toContain("The item goes back to the scheduler");
    // Declining calls nothing at all.
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Keep the claim/ }));
    expect(fake.calls.some((call) => call.method === "claims.release")).toBe(false);
  });

  it("calls claims.release, announces the note, and shows it on the row", async () => {
    const said: string[] = [];
    renderAgents();
    teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));

    const dead = await claimRow("wi-3");
    fireEvent.click(within(dead).getByRole("button", { name: "Release wi-3" }));
    const menu = await screen.findByRole("menu", { name: "Release wi-3" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Release wi-3/ }));

    await waitFor(() => expect(fake.calls.some((call) => call.method === "claims.release")).toBe(true));
    const call = fake.calls.find((c) => c.method === "claims.release")!;
    // Never forced: a run that could still resume is refused, and this one cannot.
    expect(call.params).toEqual({ workItemId: "wi-3" });

    await waitFor(async () =>
      expect((await claimRow("wi-3")).textContent).toContain("released and back with the scheduler"),
    );
    expect(said.join(" ")).toContain("wi-3 is released");
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

    const dead = await claimRow("wi-3");
    fireEvent.click(within(dead).getByRole("button", { name: "Release wi-3" }));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Release wi-3" })).getByRole("menuitem", {
        name: /^Release wi-3/,
      }),
    );

    await waitFor(async () => expect((await claimRow("wi-3")).textContent).toContain(note));
    expect(said.join(" ")).toContain(note);
  });

  it("re-reads the claims once after a release, because nothing pushes for one", async () => {
    renderAgents();
    await claimRows();
    expect(fake.calls.filter((c) => c.method === "claims.list")).toHaveLength(0);

    const dead = await claimRow("wi-3");
    fireEvent.click(within(dead).getByRole("button", { name: "Release wi-3" }));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Release wi-3" })).getByRole("menuitem", {
        name: /^Release wi-3/,
      }),
    );

    // One read, on purpose: a release journals nothing, so there is no notification to wait
    // for and no reason to ask twice.
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "claims.list")).toHaveLength(1));
  });

  it("says why on the row when the daemon refuses", async () => {
    fake.script({ "claims.release": () => ({ ok: false, error: { code: "RUN_STATE", message: "run-vanished is running" } }) });
    renderAgents();

    const dead = await claimRow("wi-3");
    fireEvent.click(within(dead).getByRole("button", { name: "Release wi-3" }));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Release wi-3" })).getByRole("menuitem", {
        name: /^Release wi-3/,
      }),
    );

    await waitFor(async () => expect((await claimRow("wi-3")).textContent).toContain("RUN_STATE"));
  });

  it("offers no Release at all against a daemon that has no claims.release", async () => {
    /* A `--read-only` daemon leaves the control methods out of `hello.methods` and out of
       its capabilities. A viewer has no greyed buttons on it: writes are absent. */
    fake.script({ hello: () => Promise.resolve({ ok: true, result: HELLO_READ_ONLY }) });
    fake.connect({ state: "live", since: AS_OF, capabilities: HELLO_READ_ONLY.capabilities });
    renderAgents();

    const dead = await claimRow("wi-3");
    expect(within(dead).queryByRole("button")).toBeNull();
  });
});

describe("the policy panel", () => {
  it("opens from the agent card and shows that agent's written grants", async () => {
    renderAgents();
    fireEvent.click(await screen.findByRole("button", { name: "Permissions for claude" }));

    const panel = await screen.findByRole("complementary", { name: "Permissions for claude" });
    expect(within(panel).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(panel.textContent).toContain("allow edit under src");
    // Read once when it opens, and not before: a surface with no panel open asks nothing.
    expect(fake.calls.filter((c) => c.method === "config.get")).toHaveLength(1);
  });

  it("is not read at all until a card asks for it", async () => {
    renderAgents();
    await screen.findAllByRole("region", { name: /^Host / });
    expect(fake.calls.some((c) => c.method === "config.get")).toBe(false);
  });
});

describe("the palette", () => {
  it("lists both actions as keyless commands on the objects on this screen", async () => {
    renderAgents();
    await claimRows();

    const entries = commandEntries(h.keyboard.list(), "darwin", ["card", "global"]);
    const permissions = entries.find((entry) => entry.label === "Edit permissions for claude");
    expect(permissions).toBeDefined();
    // Keyless (#205): the palette is the whole of how it is reached, so there is no chip.
    expect(permissions!.shortcut).toBeUndefined();
    expect(permissions!.section).toBe("actions");

    // One per releasable claim, and none for the claim the daemon would refuse.
    expect(entries.some((entry) => entry.label === "Release claim on wi-3")).toBe(true);
    expect(entries.some((entry) => entry.label === "Release claim on wi-2")).toBe(false);
  });

  it("opens the policy panel when its palette entry runs", async () => {
    renderAgents();
    await screen.findAllByRole("region", { name: /^Host / });

    const entry = commandEntries(h.keyboard.list(), "darwin", ["card"]).find(
      (e) => e.label === "Edit permissions for gemini",
    );
    expect(entry).toBeDefined();
    // In `act`, because a palette row runs outside React's own event handling: the state it
    // sets would otherwise be flushed at whatever moment the next assertion happened to poll.
    await act(async () => entry!.run());
    await screen.findByRole("complementary", { name: "Permissions for gemini" });
  });
});

describe("both themes", () => {
  it("resolves Release's danger tone from the real tokens, in both themes", async () => {
    /* Against the *real* `tokens.css` and `components.css`, per RULES.md rule 7 — and on the
       design system's own `.orca-btn--danger` rather than on this surface's stylesheet,
       which the helper does not load. */
    installDesignSystem();
    document.body.classList.add("orca");
    renderAgents();

    const release = within(await claimRow("wi-3")).getByRole("button", { name: "Release wi-3" });
    for (const theme of THEMES) {
      setTheme(theme);
      // Never a literal: the danger tone is `--status-failed` in both themes, on two channels.
      expect(resolved(release, "color")).toBe(expectedToken(theme, "status-failed"));
      expect(resolved(release, "border-color")).toBe(expectedToken(theme, "status-failed"));
    }

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
