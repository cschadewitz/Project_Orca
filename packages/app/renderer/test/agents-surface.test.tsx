// @vitest-environment happy-dom
/**
 * The Agents surface against the fake preload bridge: the groups, the four health states,
 * the two timestamps, the claims region, the state views, and the live path — an
 * `agent.changed` repainting one card without a second read.
 *
 * Everything goes through `window.orca`, which is the whole of "the daemon" as far as the
 * renderer is concerned, so a screen that asked for the wrong thing fails here rather than
 * against a real daemon three waves later.
 *
 * The dual-theme block at the bottom asserts on colours the *real* tokens.css and
 * components.css resolve, per docs/design/RULES.md rule 7. It asserts on `.orca-agent--down`
 * — the design system's own class — rather than on this surface's stylesheet, which the
 * helper does not load.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AGENT_HEALTH_PRESENTATION, THEMES } from "@orca/design";
import type { AgentView, NotificationMessage } from "@orca/protocol";
import { AgentsSurface } from "../src/agents/agents-surface.js";
import { AGENTS, AGENTS_LIST, changed } from "./fixtures-agents.js";
import { AS_OF } from "./fixtures.js";
import { installBridge, harness, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { expectedToken, installDesignSystem, resolved, setTheme } from "./themes.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

/** The surface as the chrome mounts it, with everything `main.tsx` installs above it. */
function renderAgents(connection: "live" | "disconnected" = "live"): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <AgentsSurface connection={connection} />
    </Providers>,
  );
}

const cards = (): HTMLElement[] => screen.queryAllByRole("article");
/* By the name element, not by text: an agent's roles are on the card too, and `sandbox`
   fills a role of the same name. */
const card = (id: string): HTMLElement => {
  const found = cards().find((c) => c.querySelector(".orca-agent__name")?.textContent === id);
  if (!found) throw new Error(`no card for ${id}`);
  return found;
};
const groups = (): HTMLElement[] => screen.queryAllByRole("region", { name: /^Host / });

/** An `agent.changed` frame: no `runId` and no `seq`, which is the whole of #241. */
const agentChanged = (agent: AgentView, at = "2026-03-01T09:01:00.000Z"): NotificationMessage => ({
  kind: "notification",
  method: "agent.changed",
  params: { subscriptionId: "sub-1", at, agent },
});

describe("the Agents surface", () => {
  beforeEach(() => {
    fake = installBridge();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
    setTheme(undefined);
  });

  it("groups the agents by host, in config order, with the transport beside each host id", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");

    const [local, remote] = groups();
    expect(within(local!).getByRole("heading", { name: "local" })).toBeTruthy();
    expect(within(remote!).getByRole("heading", { name: "build-box" })).toBeTruthy();
    expect(local!.textContent).toContain("2 agents");
    // The transport, not the id, is what says how the host is reached.
    expect(remote!.textContent).toContain("ssh");

    expect(within(local!).queryAllByRole("article")).toHaveLength(2);
    expect(within(remote!).queryAllByRole("article")).toHaveLength(2);
  });

  it("asks the daemon once, with no parameters it does not have", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");

    const calls = fake.calls.filter((c) => c.method === "agents.list");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual({});
  });

  it("renders every state as a glyph and a word, never colour alone", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");

    for (const agent of AGENTS) {
      const { word, glyph } = AGENT_HEALTH_PRESENTATION[agent.state];
      const text = card(agent.id).textContent ?? "";
      expect(text, agent.id).toContain(word);
      expect(text, agent.id).toContain(glyph);
    }

    // The state word leads the accessible name, so the card reads as "degraded, gemini".
    expect(card("gemini").getAttribute("aria-label")).toBe(`${AGENT_HEALTH_PRESENTATION.degraded.word}, gemini`);
    // And the card takes the design system's modifier, not a colour of this surface's own.
    expect(card("gemini").classList.contains("orca-agent--degraded")).toBe(true);
    expect(card("claude").classList.contains("orca-agent--ok")).toBe(false);
  });

  it("says what unknown means instead of leaving a blank card to read as a broken one", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");

    const codex = card("codex");
    expect(codex.textContent).toContain("Not contacted since the daemon started.");
    // Health is not persisted (#222), so there is nothing older to show and none is shown.
    expect(codex.querySelector("time")).toBeNull();
    expect(codex.textContent).not.toContain("Round trip");
  });

  it("shows both timestamps, and the round trip and failure count that explain a down card", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");

    // Two timestamps, because they answer different questions (#227).
    const claude = card("claude");
    expect(claude.textContent).toContain("Handshake");
    expect(claude.textContent).toContain("Last seen");
    expect(claude.querySelectorAll("time")).toHaveLength(2);
    expect(claude.textContent).toContain("240 ms");

    const sandbox = card("sandbox");
    expect(sandbox.textContent).toContain("Failed handshakes");
    expect(sandbox.textContent).toContain("3");
    // The error is why the card is red, so it is on the card.
    expect(sandbox.textContent).toContain("AGENT_SPAWN");
    expect(sandbox.textContent).toContain("connection refused");
    // And an agent that is not down carries none.
    expect(claude.textContent).not.toContain("AGENT_SPAWN");
  });

  it("updates one card from an agent.changed push, without re-reading the list", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");
    expect(card("claude").textContent).toContain(AGENT_HEALTH_PRESENTATION.ok.word);

    fake.notify(agentChanged(changed("claude", { state: "down", consecutiveFailures: 1 })));

    await waitFor(() => expect(card("claude").textContent).toContain(AGENT_HEALTH_PRESENTATION.down.word));
    expect(card("claude").classList.contains("orca-agent--down")).toBe(true);
    // The one rule this surface exists to keep: a push repaints, it does not refetch.
    expect(fake.calls.filter((c) => c.method === "agents.list")).toHaveLength(1);
    // And nothing else moved.
    expect(cards()).toHaveLength(AGENTS.length);
    expect(card("gemini").textContent).toContain(AGENT_HEALTH_PRESENTATION.degraded.word);
  });

  it("takes an agent it has never seen from the frame alone, with no read behind it", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");

    fake.notify(agentChanged({ ...changed("claude", {}), id: "late", hostId: "local" }));

    await waitFor(() => expect(screen.getByText("5 agents on 2 hosts")).toBeTruthy());
    expect(card("late")).toBeTruthy();
    expect(fake.calls.filter((c) => c.method === "agents.list")).toHaveLength(1);
  });

  it("lists what is claimed right now, with the run holding it and its status", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");

    const claims = screen.getByRole("region", { name: "Claimed work" });
    const items = within(claims).getAllByRole("listitem");
    expect(items).toHaveLength(AGENTS_LIST.claims.length);
    expect(items[0]!.textContent).toContain("wi-2");
    expect(items[0]!.textContent).toContain("Add the SSO callback");
    // A claim outlives its run, so "is the owner still alive" is what the row answers.
    expect(items[1]!.textContent).toContain("stale");
  });

  it("holds the values and says not to trust their freshness when the daemon is not answering", async () => {
    renderAgents("disconnected");
    await screen.findByText("4 agents on 2 hosts");

    expect(screen.getByRole("status").textContent).toContain("Not connected");
    expect(cards()).toHaveLength(AGENTS.length);
    // Absolute only: a relative time read off a stale clock is a lie.
    expect(card("claude").textContent).not.toContain("ago");
  });

  it("shows a loading view while the read is out", async () => {
    const release = fake.hold("agents.list");
    renderAgents();
    expect(await screen.findByRole("status", { name: "loading" })).toBeTruthy();
    release();
    await screen.findByText("4 agents on 2 hosts");
  });

  it("tells a live daemon's error from an absent daemon, and retries", async () => {
    fake.fail("agents.list", { code: "INTERNAL", message: "boom" });
    renderAgents();
    await screen.findByText("INTERNAL: boom");

    fake.script({ "agents.list": () => ({ ok: true, result: AGENTS_LIST }) });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("4 agents on 2 hosts");
  });

  it("says there is no daemon rather than reporting an error when nothing is connected", async () => {
    fake.fail("agents.list", { code: "AGENT_TRANSPORT", message: "no daemon" });
    renderAgents("disconnected");
    await screen.findByText("No daemon to read agents from");
  });

  it("says an empty config is empty, and how to fill it", async () => {
    fake.script({ "agents.list": () => ({ ok: true, result: { agents: [], claims: [], asOf: AS_OF } }) });
    renderAgents();
    await screen.findByText("No agents configured");
  });

  it("drops its listener when it goes away", async () => {
    renderAgents();
    await screen.findByText("4 agents on 2 hosts");
    expect(h.notifications.listeners).toBe(1);
    cleanup();
    expect(h.notifications.listeners).toBe(0);
  });
});

describe("the Agents surface in both themes", () => {
  beforeEach(() => {
    fake = installBridge();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
    setTheme(undefined);
  });

  for (const theme of THEMES) {
    it(`binds a down card to the failure token in ${theme}`, async () => {
      h = harness();
      teardown.push(h.dispose);
      const { Providers } = h;
      /* After the harness, not before: `installAppearance` applies the stored preference to
         `<html>`, and the default preference is `system` — which *removes* `data-theme`. */
      installDesignSystem();
      setTheme(theme);

      const container = document.createElement("div");
      container.className = "orca";
      document.body.append(container);
      render(
        <Providers>
          <AgentsSurface connection="live" />
        </Providers>,
        { container },
      );
      await screen.findByText("4 agents on 2 hosts");

      const down = container.querySelector(".orca-agent--down")!;
      expect(resolved(down, "border-top-color"), theme).toBe(expectedToken(theme, "status-failed"));
      const degraded = container.querySelector(".orca-agent--degraded")!;
      expect(resolved(degraded, "border-top-color"), theme).toBe(expectedToken(theme, "status-waiting"));

      container.remove();
    });
  }
});
