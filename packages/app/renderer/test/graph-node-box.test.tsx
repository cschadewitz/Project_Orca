// @vitest-environment happy-dom
/**
 * A graph node is a fixed box, and its text fits it.
 *
 * The workflow viewer, the editor and the plan's dependency graph all place a node with
 * `layout.ts`, which knows a node as `node-w` × `node-h` and nothing else: a forward edge
 * leaves the box at half of `node-h`, a back edge lands on its top. But the name and the meta
 * line wrapped freely, so "Design: requirements + design spec" took two lines and a running
 * node with an attempt and a nested count took three more on its meta line — a 64px slot
 * holding a 167px box, with its edges attached where the middle would have been.
 *
 * The rule, as approved: the name is at most two lines, the meta line one, both cut at their
 * end; the whole text is in a `title`, and the whole name is, as before, in the accessible
 * name (after the status) and the inspector; the box never grows past `node-h`. And `node-h`
 * is big enough that nothing is cut in half to fit it.
 *
 * happy-dom does no layout, so nothing here measures a box (the measuring was done in a real
 * Chromium against every variant below; the numbers are in the token's `usage`). What it can
 * hold is the structure that makes the claim true: the rules read as text, the token budget
 * summed from `tokens.json`, and every variant's markup rendered.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_GEOMETRY, STATUS_PRESENTATION, type RunStatus } from "@orca/design";
import { DependencyNode, WorkflowNode, asNodeType, type WorkflowNodeProps } from "../src/ui/index.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";
import { componentsCssSource, typeNotes } from "./type-notes.js";

// `node:path` rather than `new URL(relative, import.meta.url)` — the happy-dom trap
// `type-notes.ts` documents.
const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = join(here, "..", "src");
const tokensJson = JSON.parse(readFileSync(join(here, "..", "..", "..", "design", "tokens.json"), "utf8")) as {
  type: { groups: { styles: { name: string; lineHeight: string }[] }[] };
  spacing: { tokens: { name: string; value: string }[] };
  size: { tokens: { name: string; value: string }[] };
  border: { tokens: { name: string; value: string }[] };
};

/** Every stylesheet under `renderer/src`, by path from there. */
function stylesheets(): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".css"))
        found.push({ name: relative(rendererSrc, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
    }
  };
  walk(rendererSrc);
  return found;
}

/** Every `selector { … }` in a stylesheet, comments stripped — the prose argues about heights. */
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
function rule(css: string, selector: string, where = "components.css"): string {
  const found = rules(css).find((r) => r.selector === selector);
  if (!found) throw new Error(`${where} has no ${selector} rule`);
  return found.body;
}

const workflowCss = (): string => stylesheets().find((s) => s.name === "workflow/workflow.css")!.text;

/** A token's px value from `tokens.json`, the source the generated custom properties come from. */
function px(token: string): number {
  const all = [...tokensJson.spacing.tokens, ...tokensJson.size.tokens, ...tokensJson.border.tokens];
  const found = all.find((t) => t.name === token);
  if (!found) throw new Error(`tokens.json has no ${token}`);
  return Number.parseFloat(found.value);
}

/** `var(--space-2)` → 2's px, through the token it names. */
const pxOf = (value: string | undefined): number => {
  const name = /var\(--([a-z0-9-]+)\)/.exec(value ?? "")?.[1];
  if (name === undefined) throw new Error(`not a token reference: ${value}`);
  return px(name);
};

const lineHeight = (style: string): number => {
  const found = tokensJson.type.groups.flatMap((g) => g.styles).find((s) => s.name === style);
  if (!found) throw new Error(`tokens.json has no type style ${style}`);
  return Number.parseFloat(found.lineHeight);
};

/** The type style a part's `type:` note says it is set in — the size the budget has to hold. */
const styleOf = (selector: string): string => {
  const note = typeNotes().find((n) => n.selector === selector);
  if (!note) throw new Error(`components.css has no type note above ${selector}`);
  return note.style;
};

/**
 * A selector about a graph node's box or the text in it — not `.orca-nodelist`, which is rows,
 * and not `.orca-node__icon`, which is a 16px glyph wherever it is drawn.
 */
const NODE_SELECTOR = /\.orca-node(?!list|__icon)/;

afterEach(() => {
  cleanup();
});

describe("the node's box", () => {
  it("is node-h tall in the component layer, never a floor it can grow past", () => {
    const node = rule(componentsCssSource, ".orca-node");
    expect(declaration(node, "height")).toBe("var(--node-h)");
    expect(declaration(node, "min-height")).toBeUndefined();
    /* The slack a one-line name leaves is shared above and below the line the edges attach
       to, rather than pooled under the text. */
    expect(declaration(node, "justify-content")).toBe("center");
  });

  it("sits in a slot of exactly node-w × node-h, the box layout.ts routes the edges against", () => {
    const slot = rule(workflowCss(), ".orca-wfcanvas__box", "workflow.css");
    expect(declaration(slot, "width")).toBe("var(--node-w)");
    // It was `min-height`, which let a long name push the slot and its middle down.
    expect(declaration(slot, "height")).toBe("var(--node-h)");
    expect(declaration(slot, "min-height")).toBeUndefined();
    // A pill shorter than the slot is centred in it, so its middle is still the slot's.
    expect(declaration(slot, "display")).toBe("flex");
    expect(declaration(slot, "align-items")).toBe("center");
    expect(declaration(rule(workflowCss(), ".orca-wfcanvas__box > .orca-node", "workflow.css"), "height")).toBe("100%");
  });

  it("draws the start and end pills no taller than node-h, and no stylesheet lets any node grow", () => {
    const pills = rule(componentsCssSource, ".orca-node--start, .orca-node--end");
    expect(declaration(pills, "height")).toBe("auto");
    expect(declaration(pills, "max-height")).toBe("var(--node-h)");

    /* Every height said about a node anywhere — the component layer and every surface's own
       sheet — is one of these. A `min-height`, or a height from anything but the token, is
       a box that can outgrow the number its edges were routed to. */
    const sheets = [{ name: "components.css", text: componentsCssSource }, ...stylesheets()];
    const heights = sheets.flatMap((s) =>
      rules(s.text)
        .filter((r) => NODE_SELECTOR.test(r.selector))
        .flatMap((r) =>
          ["height", "min-height", "max-height"]
            .filter((p) => declaration(r.body, p) !== undefined)
            .map((p) => `${s.name} ${r.selector} { ${p}: ${declaration(r.body, p)} }`),
        ),
    );
    expect(heights.sort()).toEqual(
      [
        "components.css .orca-node { height: var(--node-h) }",
        "components.css .orca-node--start, .orca-node--end { height: auto }",
        "components.css .orca-node--start, .orca-node--end { max-height: var(--node-h) }",
        "workflow/workflow.css .orca-wfcanvas__box > .orca-node { height: 100% }",
        "workflow/workflow.css .orca-wfcanvas__box > .orca-node--start, .orca-wfcanvas__box > .orca-node--end { height: auto }",
      ].sort(),
    );
  });

  it("draws its type icon with the inline icon stroke, as the canvas controls do", () => {
    /* The brand book's iconography: inline SVG on the 16px grid with a 1.5px stroke. The
       hairline is a separator's width, not an icon's. */
    expect(px("stroke-icon")).toBe(1.5);
    expect(declaration(rule(componentsCssSource, ".orca-node__icon"), "stroke-width")).toBe("var(--stroke-icon)");
    expect(declaration(rule(componentsCssSource, ".orca-canvasctl__icon"), "stroke-width")).toBe("var(--stroke-icon)");
  });

  it("is tall enough for the kind, a two-line name and a meta line whole, on the 16px grid", () => {
    const node = rule(componentsCssSource, ".orca-node");
    const padding = pxOf(declaration(node, "padding")?.split(" ")[0]);
    const gap = pxOf(declaration(node, "gap"));
    const lines = Number(declaration(rule(componentsCssSource, ".orca-node__name"), "-webkit-line-clamp"));
    expect(lines).toBe(2);

    // The kind is its icon beside its word; the meta line holds a status chip.
    const kind = Math.max(
      pxOf(declaration(rule(componentsCssSource, ".orca-node__icon"), "height")),
      lineHeight(styleOf(".orca-node__kind")),
    );
    const name = lines * lineHeight(styleOf(".orca-node__name"));
    const meta = Math.max(
      pxOf(declaration(rule(componentsCssSource, ".orca-chip"), "height")),
      lineHeight(styleOf(".orca-node__meta")),
    );
    // The heaviest border any node state draws: a subworkflow's double one.
    const borders = rules(componentsCssSource)
      .filter((r) => NODE_SELECTOR.test(r.selector) && !r.selector.includes(" "))
      .flatMap((r) => {
        const width = declaration(r.body, "border-width") ?? declaration(r.body, "border")?.split(" ")[0];
        return width?.startsWith("var(") ? [pxOf(width)] : [];
      });
    const border = Math.max(...borders);
    expect(border).toBe(px("stroke-double"));

    const needed = 2 * border + 2 * padding + kind + gap + name + gap + meta;
    expect(needed, `the node's longest anatomy is ${needed}px`).toBeLessThanOrEqual(GRAPH_GEOMETRY["node-h"]);
    // A whole number of grid steps, like node-w, layer-gap and rank-gap (layout.ts, contract 4).
    expect(GRAPH_GEOMETRY["node-h"] % 16).toBe(0);
    /* And not a step more than it needs: the canvas pays for every pixel of it in every rank.
       The padding was chosen so the sum lands on a step (96 at space-1-5; 100 at space-2
       would be 112), so a part that grows by a pixel fails the line above, not this one. */
    expect(GRAPH_GEOMETRY["node-h"], `the smallest 16px step that holds ${needed}px`).toBe(Math.ceil(needed / 16) * 16);
  });
});

describe("the text in the box", () => {
  it("clamps the name at two lines, cut at the end of the second", () => {
    const name = rule(componentsCssSource, ".orca-node__name");
    expect(declaration(name, "display")).toBe("-webkit-box");
    expect(declaration(name, "-webkit-box-orient")).toBe("vertical");
    expect(declaration(name, "-webkit-line-clamp")).toBe("2");
    expect(declaration(name, "overflow")).toBe("hidden");
    /* A word wider than the box goes onto the second line and is cut at the end of it, rather
       than running off the first with no mark that it had. Breaks at spaces and hyphens are
       untouched: `anywhere` applies only when there is no other way to break. */
    expect(declaration(name, "overflow-wrap")).toBe("anywhere");
    // Never squeezed by the column to a line and a half.
    expect(declaration(name, "flex")).toBe("none");
  });

  it("keeps the meta line to one line, and the last fact on it is the one that gives way", () => {
    const meta = rule(componentsCssSource, ".orca-node__meta");
    expect(declaration(meta, "white-space")).toBe("nowrap");
    expect(declaration(meta, "overflow")).toBe("hidden");
    expect(declaration(meta, "min-width")).toBe("0");
    expect(declaration(meta, "flex")).toBe("none");
    /* The ellipsis is a fact's to draw: a flex container's own `text-overflow` does not reach
       its items. Every fact keeps its width but the last, which shrinks and is cut at its end. */
    const fact = rule(componentsCssSource, ".orca-node__fact");
    expect(declaration(fact, "flex")).toBe("none");
    expect(declaration(fact, "overflow")).toBe("hidden");
    expect(declaration(fact, "text-overflow")).toBe("ellipsis");
    const last = rule(componentsCssSource, ".orca-node__fact:last-child");
    expect(declaration(last, "flex-shrink")).toBe("1");
    expect(declaration(last, "min-width")).toBe("0");
    // The chip in front of them never shrinks — its own rule's promise, not this one's.
    expect(declaration(rule(componentsCssSource, ".orca-chip"), "flex")).toBe("none");
  });

  it("keeps the kind to one line, its word cut at its end", () => {
    const kind = rule(componentsCssSource, ".orca-node__kind");
    expect(declaration(kind, "white-space")).toBe("nowrap");
    expect(declaration(kind, "flex")).toBe("none");
    const label = rule(componentsCssSource, ".orca-node__kind-label");
    expect(declaration(label, "overflow")).toBe("hidden");
    expect(declaration(label, "text-overflow")).toBe("ellipsis");
    expect(declaration(label, "min-width")).toBe("0");
  });
});

const LONG_NAME = "Design: requirements + design spec, reviewed twice by both of the leads";
const word = (status: RunStatus): string => STATUS_PRESENTATION[status].word;

/**
 * Every variant a node is drawn in, with the props each surface hands it: the viewer's
 * definition and run overlay, the editor's draft states and flags, the containers' counts.
 * `meta` is the meta line's whole text, or `null` when the node has none.
 */
const VARIANTS: readonly { label: string; props: Omit<WorkflowNodeProps, "id" | "type">; meta: string | null }[] = [
  { label: "a start pill", props: { typeLabel: "start", name: "start" }, meta: null },
  { label: "an end pill", props: { typeLabel: "end", name: "Deploy: open PR / ship it" }, meta: null },
  { label: "an agent", props: { typeLabel: "agent", name: LONG_NAME }, meta: null },
  { label: "a gate", props: { typeLabel: "gate", name: "Approve spec" }, meta: null },
  { label: "a decision", props: { typeLabel: "decision", name: "Did tests pass?" }, meta: null },
  {
    label: "a plugin's node",
    props: { typeLabel: "custom:acme-deployment-orchestrator-extended", name: "deploy" },
    meta: null,
  },
  {
    label: "an id with nowhere to break",
    props: { typeLabel: "agent", name: "generate_implementation_plan_from_the_approved_specification_v2" },
    meta: null,
  },
  {
    label: "a collapsed loop",
    props: { typeLabel: "loop", name: LONG_NAME, collapsed: "1 nested graph" },
    meta: "1 nested graph",
  },
  {
    label: "a collapsed parallel",
    props: { typeLabel: "parallel", name: "Fan out the pieces", collapsed: "2 nested graphs" },
    meta: "2 nested graphs",
  },
  {
    label: "a running container on its second attempt",
    props: {
      typeLabel: "parallel",
      name: LONG_NAME,
      runState: { status: "running", attempts: 2, current: true },
      collapsed: "3 nested graphs",
    },
    meta: `${word("running")} · attempt 2 · 3 nested graphs`,
  },
  {
    label: "a failed node on its third attempt",
    props: { typeLabel: "agent", name: LONG_NAME, runState: { status: "failed", attempts: 3 } },
    meta: `${word("failed")} · attempt 3`,
  },
  {
    label: "a gate waiting on a person",
    props: { typeLabel: "gate", name: LONG_NAME, runState: { status: "waiting" } },
    meta: word("waiting"),
  },
  {
    label: "a start the run passed",
    props: { typeLabel: "start", name: "start", runState: { status: "succeeded" } },
    meta: word("succeeded"),
  },
  { label: "a node not taken", props: { typeLabel: "agent", name: LONG_NAME, untaken: true }, meta: null },
  {
    label: "an added node flagged as the start",
    props: { typeLabel: "agent", name: LONG_NAME, draft: "added", flag: "start" },
    meta: null,
  },
  {
    label: "a changed node flagged as pinned",
    props: { typeLabel: "gate", name: LONG_NAME, draft: "changed", flag: "pinned" },
    meta: null,
  },
  { label: "a removed node", props: { typeLabel: "agent", name: LONG_NAME, draft: "removed" }, meta: null },
  {
    label: "a node with errors",
    props: { typeLabel: "decision", name: LONG_NAME, invalid: true, flag: "2 errors" },
    meta: null,
  },
  {
    label: "an editor container with its way in",
    props: { typeLabel: "parallel", name: LONG_NAME, draft: "added", collapsed: "3 inside — double-click to open" },
    meta: "3 inside — double-click to open",
  },
];

describe("every variant of a workflow node", () => {
  for (const { label, props, meta } of VARIANTS) {
    it(`${label}: each part one element that can be cut, each whole in its title and the name`, () => {
      render(<WorkflowNode id="n" type={asNodeType(props.typeLabel)} {...props} />);
      const node = screen.getByRole("option");

      // The kind: its word in its own element, so the ellipsis can reach it.
      const kind = node.querySelector(".orca-node__kind")!;
      expect(kind.querySelectorAll(".orca-node__kind-label")).toHaveLength(1);
      expect(kind.querySelector(".orca-node__kind-label")!.getAttribute("title")).toBe(props.typeLabel);

      // The name: verbatim in the markup and in its title — a clamp is drawing, not editing.
      const name = node.querySelector(".orca-node__name")!;
      expect(name.textContent).toBe(props.name);
      expect(name.getAttribute("title")).toBe(props.name);

      // The meta line: every fact after the chip is a fact element, and the title is the line.
      const line = node.querySelector(".orca-node__meta");
      if (meta === null) {
        expect(line).toBeNull();
      } else {
        expect(line!.getAttribute("title")).toBe(meta);
        const chip = line!.querySelector(".orca-chip");
        const facts = [...line!.children]
          .filter((child) => child.classList.contains("orca-node__fact"))
          .map((fact) => fact.textContent);
        expect([...(chip ? [chip.querySelector(".orca-chip__label")!.textContent] : []), ...facts].join(" · ")).toBe(
          meta,
        );
        // Nothing on the line that is not the chip or a fact: a bare span would not be cut.
        expect(line!.children).toHaveLength(facts.length + (chip ? 1 : 0));
      }

      /* The accessible name still says all of it, status first (50-accessibility-and-keyboard
         .md): whatever the box cuts, a screen reader hears the whole name. */
      const accessible = node.getAttribute("aria-label")!;
      expect(accessible).toContain(props.name);
      expect(accessible).toContain(props.typeLabel);
      if (props.runState) expect(accessible.startsWith(`${word(props.runState.status)}, `)).toBe(true);
      if (props.runState?.attempts) expect(accessible).toContain(`attempt ${props.runState.attempts}`);
      // And the node itself takes no title: on an element with a name, it would be read again.
      expect(node.hasAttribute("title")).toBe(false);
    });
  }
});

describe("a dependency node", () => {
  const CASES = [
    { name: "implement-the-single-sign-on-callback-handler-for-okta", target: "item", state: "open", words: "open" },
    {
      name: "datastore-choice-for-the-event-log",
      target: "decision",
      state: "waived",
      inCycle: true,
      words: "waived · on a cycle",
    },
    {
      name: "github:acme/platform#4521-upstream-release",
      target: "external",
      state: "failed",
      inCycle: true,
      words: "failed · on a cycle",
    },
  ] as const;

  for (const { words, ...props } of CASES) {
    it(`takes the same box and the same cut: ${props.target}, ${words}`, () => {
      render(<DependencyNode id="d" {...props} />);
      const node = screen.getByRole("option");
      expect(node.classList.contains("orca-node")).toBe(true);
      const name = node.querySelector(".orca-node__name")!;
      expect(name.textContent).toBe(props.name);
      expect(name.getAttribute("title")).toBe(props.name);
      const line = node.querySelector(".orca-node__meta")!;
      expect(line.getAttribute("title")).toBe(words);
      expect([...line.children].map((c) => [c.className, c.textContent])).toEqual([["orca-node__fact", words]]);
      expect(node.querySelectorAll(".orca-node__kind > .orca-node__kind-label")).toHaveLength(1);
      // The state leads the accessible name, and the whole name follows it.
      expect(node.getAttribute("aria-label")!.startsWith(`${props.state}, `)).toBe(true);
      expect(node.getAttribute("aria-label")).toContain(props.name);
    });
  }
});

describe("on the canvases", () => {
  beforeEach(() => stubMatchMedia(1440));
  const teardown: (() => void)[] = [];
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  async function open(url: string): Promise<HTMLElement> {
    const fake = installBridge({ deepLink: url });
    teardown.push(fake.install());
    const h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    const canvas = await screen.findByRole("listbox", { name: /graph$/ });
    await act(async () => {});
    return canvas;
  }

  /** Each option on a canvas, with the name its title carries. */
  const titled = (canvas: HTMLElement): { label: string; title: string | null }[] =>
    within(canvas)
      .getAllByRole("option")
      .map((node) => ({
        label: node.getAttribute("aria-label") ?? "",
        title: node.querySelector(".orca-node__name")?.getAttribute("title") ?? null,
      }));

  it("titles every node's name on the workflow viewer, the long one included", async () => {
    const canvas = await open("orca://workflow/ai-sdlc");
    const nodes = titled(canvas);
    expect(nodes).toHaveLength(16);
    for (const { label, title } of nodes) expect(label).toContain(title);
    expect(nodes.map((n) => n.title)).toContain("Design: requirements + design spec");
  });

  it("titles the overlay's meta line with all of it, status first", async () => {
    // `run-parent` is at `fanout`, a collapsed parallel with two branches.
    const canvas = await open("orca://workflow/sdlc?run=run-parent");
    const fanout = await waitFor(() => {
      const found = within(canvas)
        .getAllByRole("option")
        .find((node) => node.getAttribute("aria-label")?.includes("current node"));
      expect(found).toBeDefined();
      return found!;
    });
    const status = fanout.getAttribute("aria-label")!.split(", ")[0]!;
    const line = fanout.querySelector(".orca-node__meta")!;
    expect(line.getAttribute("title")!.startsWith(`${status} · `)).toBe(true);
    expect(line.getAttribute("title")!.endsWith("2\u00a0nested graphs")).toBe(true);
  });

  it("titles every node's name on the plan's dependency graph", async () => {
    const fake = installBridge({});
    teardown.push(fake.install());
    const h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.click(screen.getByRole("button", { name: "Dependencies" }));
    const graph = await screen.findByRole("listbox", { name: "Dependency graph" });
    await waitFor(() => expect(within(graph).getAllByRole("option").length).toBeGreaterThan(0));
    for (const { label, title } of titled(graph)) {
      expect(title).not.toBeNull();
      expect(label).toContain(title);
    }
  });
});
