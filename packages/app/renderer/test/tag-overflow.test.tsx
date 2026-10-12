// @vitest-environment happy-dom
/**
 * A row of chips, tags or labels stays inside the box it is in.
 *
 * The Agents surface drew an agent with seven roles as one unwrapped line of chips that ran
 * out past its card and under the card beside it, and drew `scripted-slow` as "scripted-"
 * over "slow", because the host label beside the name took the room first. The sweep that
 * followed found the same two shapes elsewhere: a run of chips that could not wrap (the
 * workflow inspector's kind and attempts, pinned in `workflow-surface.test.tsx`), and a
 * machine string with nowhere to go, which either broke at a hyphen or ran out past its pane
 * (the inspectors' titles, the editor's node list, the Plan rail's request ids, the
 * permission panel's agent id).
 *
 * One answer per shape:
 *
 * - **A run of chips wraps.** `.orca-chips` is the one class for it, and a card or a panel
 *   composes it. A row may not (RULES.md rule 9), and no row holds a list of chips.
 * - **A machine string that cannot wrap truncates at its end** — the brand book's "machine
 *   strings stay verbatim … truncate at the end" — and the element carries the whole string
 *   in its title.
 *
 * happy-dom does no layout, so nothing here measures a box. What it can hold, the move
 * `focus-and-selection.test.ts` makes for the focus ring, is the structure that makes the
 * claim true: the rules read as text, and the markup that composes them rendered.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentCard } from "../src/agents/agent-card.js";
import { PlanSidebar } from "../src/plan/plan-sidebar.js";
import { NO_FILTERS } from "../src/plan/plan-model.js";
import { EditorSidebar } from "../src/workflow/editor/editor-panels.js";
import { changed } from "./fixtures-agents.js";
import { PLAN } from "./fixtures-plan.js";
import { componentsCssSource } from "./type-notes.js";

// `node:path` rather than `new URL(relative, import.meta.url)` — the happy-dom trap
// `type-notes.ts` documents.
const rendererSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every file under `renderer/src` with one of `extensions`, by path from there. */
function sources(extensions: readonly string[]): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((ext) => entry.name.endsWith(ext)))
        found.push({ name: relative(rendererSrc, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
    }
  };
  walk(rendererSrc);
  return found;
}

/** Every `selector { … }` in a stylesheet, comments stripped — the prose argues about wrapping. */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    body: match[2]!.trim(),
  }));
}

/** One declaration's value, or `undefined` when the rule does not set that property. */
function declaration(body: string, property: string): string | undefined {
  for (const line of body.split(";")) {
    const [name, ...rest] = line.split(":");
    if (name?.trim() === property) return rest.join(":").trim();
  }
  return undefined;
}

/** The body of the one rule in `css` whose whole selector is `selector`. */
function rule(css: string, selector: string, where: string): string {
  const found = rules(css).find((r) => r.selector === selector);
  if (!found) throw new Error(`${where} has no ${selector} rule`);
  return found.body;
}

const sheet = (name: string): string => {
  const found = sources([".css"]).find((s) => s.name === name);
  if (!found) throw new Error(`no stylesheet ${name}`);
  return found.text;
};

/** The agent from the screenshot: seven roles, and a name with a hyphen in it. */
const SEVEN_ROLES = ["planner", "designer", "builder", "tester", "reviewer", "deployer", "decomposer"];

/** A request id as the daemon mints one: `req_` and a 26-character ULID, wider than the rail. */
const REQUEST_ID = "req_01J9ZQ4XK7M3T8V2N5R6W0YBHC";

afterEach(() => {
  cleanup();
});

describe("a run of chips", () => {
  it("wraps, and lets its parent's width decide rather than holding the parent open", () => {
    const chips = rule(componentsCssSource, ".orca-chips", "components.css");
    expect(declaration(chips, "display")).toBe("flex");
    expect(declaration(chips, "flex-wrap")).toBe("wrap");
    /* A flex or grid item's automatic minimum is its content's. Without this, a run of chips
       inside a `1fr` track still sets that track's minimum to the sum of its chips — the
       agent card's bug, in whatever parent the run is put in next. */
    expect(declaration(chips, "min-width")).toBe("0");
  });

  it("is one class in the component layer, not a copy per surface", () => {
    /* The Plan rail and the step detail each had their own `__chips` rule, identical to the
       other; the agent card had one that did not wrap. A run of chips declared on a surface
       is the place the next one that does not wrap will come from. */
    const copies = sources([".css"]).flatMap((s) =>
      rules(s.text)
        .filter((r) => /\.orca-[a-z-]+__chips\b/.test(r.selector))
        .map((r) => `${s.name} — ${r.selector}`),
    );
    expect(copies).toEqual([]);
    const retired = /orca-plan__chips|orca-step__chips/;
    expect(
      sources([".tsx", ".ts"])
        .filter((s) => retired.test(s.text))
        .map((s) => s.name),
    ).toEqual([]);

    // And the card's roles say only where they sit; how they lay out is the shared class.
    const roles = rule(componentsCssSource, ".orca-agent__roles", "components.css");
    expect(declaration(roles, "display")).toBeUndefined();
    expect(declaration(roles, "grid-column")).toBe("2 / -1");
  });

  it("holds every one of an agent's roles inside its card, however many there are", () => {
    render(<AgentCard agent={changed("claude", { id: "scripted", roles: SEVEN_ROLES })} live={false} />);

    const card = screen.getByRole("article", { name: "ok, scripted" });
    const runs = card.querySelectorAll(".orca-agent__roles");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.classList.contains("orca-chips")).toBe(true);
    /* Every role, in config order, and nothing standing in for any of them: a workflow picks
       an agent by role, so the one hidden behind a "+3" is the one somebody was looking for.
       A card is not a row, so it takes the extra line instead. */
    expect([...runs[0]!.querySelectorAll(".orca-chip")].map((chip) => chip.textContent)).toEqual(SEVEN_ROLES);
    expect(runs[0]!.textContent).not.toMatch(/\+\d/);
  });
});

describe("the agent card's header", () => {
  it("gives the name the room it needs first, and makes the host label the one that gives way", () => {
    const columns = declaration(rule(componentsCssSource, ".orca-agent", "components.css"), "grid-template-columns");
    expect(columns).toBe("auto minmax(0, max-content) minmax(0, 1fr)");
    /* A bare `1fr` is `minmax(auto, 1fr)`: its minimum is whatever is placed in it, which is
       how seven roles held the card's grid open past the card. Every flexible track states
       its minimum. */
    expect(columns!.replace(/minmax\([^)]*\)/g, "")).not.toContain("fr");
  });

  it("keeps the name and the host on one line each, cut at their ends and whole in their titles", () => {
    for (const selector of [".orca-agent__name", ".orca-agent__host"]) {
      const body = rule(componentsCssSource, selector, "components.css");
      // `scripted-slow` broke at its hyphen; an id across two lines reads as two ids.
      expect(declaration(body, "white-space"), selector).toBe("nowrap");
      expect(declaration(body, "overflow"), selector).toBe("hidden");
      expect(declaration(body, "text-overflow"), selector).toBe("ellipsis");
    }

    render(<AgentCard agent={changed("gemini", { id: "scripted-slow" })} live={false} />);
    const card = screen.getByRole("article", { name: /scripted-slow$/ });
    expect(card.querySelector(".orca-agent__name")?.getAttribute("title")).toBe("scripted-slow");
    // The host and its transport, the way the card draws them, whole.
    expect(card.querySelector(".orca-agent__host")?.getAttribute("title")).toBe("build-box · ssh");
  });
});

describe("a machine string with nowhere to wrap to", () => {
  /**
   * Each of these is an id or a name ORCA produced, in a box narrower than a long one: it
   * keeps one line — on its own rule, or on the head or button it is in — and truncates at
   * its end, which is the only place rule 8's verbatim allows outside an id's middle.
   */
  const TRUNCATING: readonly { sheet: string; selector: string; line: string }[] = [
    { sheet: "components.css", selector: ".orca-inspector__title", line: ".orca-inspector__head" },
    { sheet: "components.css", selector: ".orca-nodelist__name", line: ".orca-nodelist__name" },
    { sheet: "components.css", selector: ".orca-nodelist__type", line: ".orca-nodelist__type" },
    { sheet: "plan/plan.css", selector: ".orca-plan__filter-label", line: ".orca-plan__filter" },
    { sheet: "config/policy.css", selector: ".orca-policy__agent", line: ".orca-policy__agent" },
  ];

  for (const { sheet: name, selector, line } of TRUNCATING) {
    it(`${selector} truncates at its end rather than wrapping or running out`, () => {
      const css = name === "components.css" ? componentsCssSource : sheet(name);
      const body = rule(css, selector, name);
      expect(declaration(body, "overflow")).toBe("hidden");
      expect(declaration(body, "text-overflow")).toBe("ellipsis");
      expect(declaration(rule(css, line, name), "white-space")).toBe("nowrap");
    });
  }

  it("keeps a request id on the Plan rail whole in its title, in a rail of filters that wraps", () => {
    render(
      <PlanSidebar
        plan={{ ...PLAN, requestIds: [REQUEST_ID] }}
        filters={NO_FILTERS}
        onRequest={() => {}}
        onClassification={() => {}}
        onStatus={() => {}}
      />,
    );
    const filter = screen.getByRole("button", { name: REQUEST_ID });
    expect(filter.getAttribute("title")).toBe(REQUEST_ID);
    // The ellipsis is the label's to draw: a button's own `text-overflow` does not reach the
    // anonymous box its text sits in.
    expect(filter.querySelector(".orca-plan__filter-label")?.textContent).toBe(REQUEST_ID);
    expect(filter.parentElement?.classList.contains("orca-chips")).toBe(true);
  });

  it("keeps each node's kind and id whole in the editor's node list", () => {
    const id = "generate-implementation-plan-from-the-approved-spec";
    const type = "custom:acme-deployment-orchestrator";
    render(
      <EditorSidebar
        graph={{ start: id, nodes: [{ id, type, raw: {} }], edges: [] }}
        selection={undefined}
        readOnly
        issues={{ byNode: new Map() }}
        onAdd={() => {}}
        onSelect={() => {}}
        onMove={() => {}}
      />,
    );
    const outline = screen.getByRole("list", { name: "Nodes, in file order" });
    expect(outline.querySelector(".orca-nodelist__name")?.getAttribute("title")).toBe(id);
    expect(outline.querySelector(".orca-nodelist__type")?.getAttribute("title")).toBe(type);
  });
});
