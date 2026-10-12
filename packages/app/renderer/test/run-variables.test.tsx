// @vitest-environment happy-dom
/**
 * A run's variables in the run summary, and the pane they sit in never scrolling sideways.
 *
 * An object variable used to be one line of compact JSON. Compact JSON has no break
 * opportunity between its tokens, so the value column's floor — `1fr`, whose minimum is the
 * widest thing in it that cannot break — was the length of the longest run of quotes, colons
 * and timestamps, the column grew past the pane, and `.orca-inspector__body` scrolled
 * sideways with the artifact chips under it. Now an object or an array is its indented JSON
 * in a sunken well under its name, clamped to a few lines with a button that opens it.
 *
 * happy-dom does no layout, so nothing here measures a width. What it can hold — the move
 * `status-chip-width.test.tsx` makes — is the structure that makes the claim true: what the
 * pane renders, which classes the values carry, and that the rules those classes resolve to
 * in the real stylesheets give every column a floor of zero and every machine string a way
 * to break or truncate. Whether the clamp cut anything off is the one number the layout
 * would have supplied, and it is stood in for the way `step-detail.test.tsx` stands in a
 * viewport: `scrollHeight` and `clientHeight` on the wells.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { THEMES } from "@orca/design";
import type { ArtifactView, RunsGetResult } from "@orca/protocol";
import { ArtifactPanelProvider } from "../src/artifacts/panel-context.js";
import { StepDetail } from "../src/step/step-detail.js";
import { variableText } from "../src/step/variable-value.js";
import { RUN_DETAILS } from "./fixtures.js";
import { harness, installBridge } from "./harness.js";
import { expectedToken, installDesignSystem, installSurfaceStyles, resolved, setTheme } from "./themes.js";
import { componentsCssSource } from "./type-notes.js";

const PARENT = RUN_DETAILS["run-parent"]!;

/** The shape the report came from: a work item, as a planning workflow hands it over. */
const WORK_ITEM = {
  description: "A token bucket per IP",
  slug: "seed-rate-limit",
  title: "Rate-limit the login endpoint",
};

/** A request, as the submission path seals it into a run: big, nested, timestamped. */
const REQUEST = {
  id: "req-01JA7K3N9V4XQ2B8M5T6R1Y0ZC",
  title: "Rate-limit the login endpoint",
  body: "Brute-force attempts against /api/v1/auth/login spiked last week; add a token bucket per IP.",
  source: { kind: "cli", actor: "casey" },
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-10T09:04:12.345Z",
  labels: ["security", "auth"],
};

const LONG_NAME = "reports/security/2026-10-10-login-endpoint-rate-limit-findings-and-recommendations.md";

const ARTIFACT: ArtifactView = { ...PARENT.artifacts[0]!, id: "a-long", name: LONG_NAME, version: 3 };

const DETAIL: RunsGetResult = {
  ...PARENT,
  vars: {
    branch: "feat/sso",
    attempts: 3,
    dryRun: false,
    none: null,
    empty: {},
    workItem: WORK_ITEM,
    request: REQUEST,
  },
  artifacts: [...PARENT.artifacts, ARTIFACT],
};

const teardown: (() => void)[] = [];

function renderSummary(detail: RunsGetResult = DETAIL): HTMLElement {
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  const view = render(
    <Providers>
      <ArtifactPanelProvider>
        <StepDetail detail={detail} connection="live" />
      </ArtifactPanelProvider>
    </Providers>,
  );
  return view.container;
}

/** The `<dd>` beside a variable's name. */
function valueOf(name: string): HTMLElement {
  const term = screen.getByText(name, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== "DD") throw new Error(`no value beside ${name}`);
  return value;
}

/* ---------- a stand-in for the one number layout would supply ---------- */

/** What the clamp is: eight lines of `mono-log` and the well's padding. */
const CLAMP = 8 * 18 + 16;
/** One line of `mono-log`. */
const LINE = 18;

let heights: { scroll?: PropertyDescriptor | undefined; client?: PropertyDescriptor | undefined } = {};

/**
 * A well is as tall as its lines (plus padding), and a clamped one is no taller than the
 * clamp — the arithmetic the browser does, with every line one line tall. Anything that is
 * not a well keeps happy-dom's zeroes.
 */
function standInHeights(): void {
  heights = {
    scroll: Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "scrollHeight"),
    client: Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight"),
  };
  const content = (el: HTMLElement): number => (el.textContent ?? "").split("\n").length * LINE + 16;
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("orca-step__var-well") ? content(this) : 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("orca-step__var-well")) return 0;
      const full = content(this);
      return this.classList.contains("orca-step__var-well--clamped") ? Math.min(full, CLAMP) : full;
    },
  });
}

function restoreHeights(): void {
  for (const [key, property] of [
    ["scroll", "scrollHeight"],
    ["client", "clientHeight"],
  ] as const) {
    Reflect.deleteProperty(window.HTMLElement.prototype, property);
    const saved = heights[key];
    if (saved) Object.defineProperty(window.HTMLElement.prototype, property, saved);
  }
  heights = {};
}

beforeEach(() => {
  installBridge();
  standInHeights();
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
  restoreHeights();
  document.getElementById("orca-design-system")?.remove();
  document.getElementById("orca-surface-styles")?.remove();
  setTheme(undefined);
});

/* ---------- the plain half ---------- */

describe("how a variable is set", () => {
  it("leaves a string as itself, without the quotes JSON would add", () => {
    expect(variableText("feat/sso")).toEqual({ block: false, text: "feat/sso" });
  });

  it("puts a number, a boolean, null and an empty object or array on the line", () => {
    for (const [value, text] of [
      [3, "3"],
      [false, "false"],
      [null, "null"],
      [{}, "{}"],
      [[], "[]"],
    ] as const) {
      expect(variableText(value)).toEqual({ block: false, text });
    }
  });

  it("indents an object or an array two spaces, one key per line, in the order it has them", () => {
    const shown = variableText(WORK_ITEM);
    expect(shown).toEqual({
      block: true,
      text: '{\n  "description": "A token bucket per IP",\n  "slug": "seed-rate-limit",\n  "title": "Rate-limit the login endpoint"\n}',
    });
    expect(variableText(["a", "b"])).toEqual({ block: true, text: '[\n  "a",\n  "b"\n]' });
  });

  it("does not take the pane down over a value with no JSON", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(variableText(cycle)).toEqual({ block: false, text: "[object Object]" });
    expect(variableText(10n)).toEqual({ block: false, text: "10" });
  });
});

/* ---------- the run summary ---------- */

describe("a run's variables in the run summary", () => {
  it("lists each value as the value of its name, scalars on the line in mono as before", () => {
    renderSummary();
    expect(screen.getByText("Variables (7)")).toBeTruthy();
    // A description list, so a screen reader hears the pairing and not two strings.
    const list = document.querySelector("dl.orca-step__vars")!;
    expect(list.querySelectorAll(":scope > .orca-field > dt")).toHaveLength(7);

    for (const [name, text] of [
      ["branch", "feat/sso"],
      ["attempts", "3"],
      ["dryRun", "false"],
      ["none", "null"],
      ["empty", "{}"],
    ] as const) {
      const value = valueOf(name);
      expect(value.textContent).toBe(text);
      expect(value.classList.contains("orca-mono")).toBe(true);
      expect(value.classList.contains("orca-text-mono-body")).toBe(true);
      expect(value.querySelector(".orca-well")).toBeNull();
      expect(value.closest(".orca-field")!.classList.contains("orca-step__var--block")).toBe(false);
    }
  });

  it("sets an object as its indented JSON in a sunken well under its name", () => {
    renderSummary();
    const value = valueOf("workItem");
    const well = value.querySelector("pre.orca-well")!;
    expect(well).toBeTruthy();
    expect(well.classList.contains("orca-text-mono-log")).toBe(true);
    // Verbatim and whole: the text of the well is exactly the value's indented JSON.
    expect(well.textContent).toBe(JSON.stringify(WORK_ITEM, null, 2));
    expect(well.textContent).not.toContain('{"description"');
    // Under its name across the pane, not squeezed into the value column beside it.
    expect(value.closest(".orca-field")!.classList.contains("orca-step__var--block")).toBe(true);
  });

  it("draws the well on surface-sunken and lets it wrap, in both themes", () => {
    installDesignSystem();
    installSurfaceStyles();
    for (const theme of THEMES) {
      const container = renderSummary();
      container.classList.add("orca");
      // After the mount: the harness applies the app's own appearance, which names a theme.
      setTheme(theme);
      const well = valueOf("workItem").querySelector("pre")!;
      expect(resolved(well, "background-color"), theme).toBe(expectedToken(theme, "surface-sunken"));
      // `pre-wrap` keeps the indentation; `anywhere` lets a token wider than the pane break.
      expect(resolved(well, "white-space")).toBe("pre-wrap");
      expect(resolved(well, "overflow-wrap")).toBe("anywhere");
      cleanup();
    }
  });

  it("shows a value that fits whole, with no button under it", () => {
    renderSummary();
    // Five lines, inside the clamp's eight: nothing is cut off, so there is nothing to open.
    expect(within(valueOf("workItem")).queryByRole("button")).toBeNull();
  });

  it("clamps a long value and opens it with a button whose state is aria-expanded", () => {
    renderSummary();
    const value = valueOf("request");
    const well = value.querySelector<HTMLElement>("pre.orca-well")!;
    const lines = JSON.stringify(REQUEST, null, 2).split("\n").length;
    expect(lines).toBeGreaterThan(8);

    // Closed: clamped, and the whole value is still in the document for a screen reader.
    expect(well.classList.contains("orca-step__var-well--clamped")).toBe(true);
    expect(well.textContent).toBe(JSON.stringify(REQUEST, null, 2));

    // "Show all" to the eye; the variable's name too to a list of the pane's buttons.
    const button = within(value).getByRole("button", { name: "Show all of request" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(well.id);
    expect(well.id).not.toBe("");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(well.classList.contains("orca-step__var-well--clamped")).toBe(false);
    expect(button.textContent).toBe("Show less of request");

    // And back: the button is the way back, so it stays while the block is open.
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(well.classList.contains("orca-step__var-well--clamped")).toBe(true);
  });

  it("is reachable from the keyboard: the disclosure is a real button in the tab order", () => {
    renderSummary();
    const button = within(valueOf("request")).getByRole("button");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("tabindex")).toBe(false);
  });
});

/* ---------- nothing in the pane widens it ---------- */

const stepCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "step", "step.css"), "utf8");

/** Every `selector { … }` in a stylesheet, comments stripped — the prose argues about widths. */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    body: match[2]!.trim(),
  }));
}

function declaration(css: string, selector: string, property: string): string | undefined {
  const rule = rules(css).find((r) => r.selector === selector);
  if (!rule) throw new Error(`no ${selector} rule`);
  for (const line of rule.body.split(";")) {
    const [name, ...rest] = line.split(":");
    if (name?.trim() === property) return rest.join(":").trim();
  }
  return undefined;
}

describe("the run summary never scrolls sideways", () => {
  it("gives the value column a floor of zero rather than its widest unbreakable value", () => {
    /* The cause. `1fr` is `minmax(auto, 1fr)`, and `auto` is the column's min-content: the
       one long line of compact JSON. Both statements of the field's columns say zero. */
    for (const selector of [".orca-field", ".orca-inspector .orca-field"]) {
      expect(declaration(componentsCssSource, selector, "grid-template-columns"), selector).toMatch(
        /minmax\(0, 1fr\)$/,
      );
    }
    expect(declaration(stepCss, ".orca-step__vars > .orca-step__var--block", "grid-template-columns")).toBe(
      "minmax(0, 1fr)",
    );
  });

  it("lets every machine string in the pane break inside itself or truncate whole", () => {
    // A value, a name, a metric, an error: each breaks once it has no other way to fit.
    expect(declaration(stepCss, ".orca-step__var-value", "overflow-wrap")).toBe("anywhere");
    expect(declaration(stepCss, ".orca-step__var-value", "min-width")).toBe("0");
    expect(declaration(componentsCssSource, ".orca-inspector .orca-field__label", "overflow-wrap")).toBe("anywhere");
    expect(declaration(stepCss, ".orca-step__metric", "overflow-wrap")).toBe("anywhere");
    expect(declaration(stepCss, ".orca-step__error", "overflow-wrap")).toBe("anywhere");
    // The three sunken blocks of machine text the pane can hold, alike.
    for (const selector of [".orca-well", ".orca-tool__body", ".orca-card__cmd"]) {
      expect(declaration(componentsCssSource, selector, "white-space"), selector).toBe("pre-wrap");
      expect(declaration(componentsCssSource, selector, "overflow-wrap"), selector).toBe("anywhere");
    }
  });

  it("clamps by line, never by a length, and clips only what the button opens", () => {
    expect(declaration(stepCss, ".orca-step__var-well--clamped", "-webkit-line-clamp")).toBe("8");
    /* At the content edge, not the padding edge: `hidden` let the ninth line show through
       the well's bottom padding in Chromium. And `clip`, not `hidden`, so the closed well is
       not a scroll container that a wheel could move the value inside. */
    expect(declaration(stepCss, ".orca-step__var-well--clamped", "overflow")).toBe("clip");
    expect(declaration(stepCss, ".orca-step__var-well--clamped", "overflow-clip-margin")).toBe("content-box");
    // Nothing in the step pane hides overflow sideways to look tidy: that would cut text off.
    for (const rule of rules(stepCss)) {
      expect(declaration(stepCss, rule.selector, "overflow-x"), rule.selector).toBeUndefined();
    }
  });

  it("wraps the artifact chips, and truncates a name longer than the pane inside its chip", () => {
    renderSummary();
    const chip = screen.getByRole("button", { name: `${LONG_NAME}@v3` });
    // The whole name is the accessible name and the title; only the drawing truncates.
    expect(chip.getAttribute("title")).toBe(`${LONG_NAME}@v3`);
    expect(chip.querySelector(".orca-ref__label")?.textContent).toBe(`${LONG_NAME}@v3`);
    expect(chip.parentElement!.classList.contains("orca-chips")).toBe(true);

    expect(declaration(componentsCssSource, ".orca-chips", "flex-wrap")).toBe("wrap");
    expect(declaration(componentsCssSource, ".orca-chips", "min-width")).toBe("0");
    expect(declaration(componentsCssSource, ".orca-ref", "max-width")).toBe("100%");
    expect(declaration(componentsCssSource, ".orca-ref", "white-space")).toBe("nowrap");
    expect(declaration(componentsCssSource, ".orca-ref__label", "min-width")).toBe("0");
    expect(declaration(componentsCssSource, ".orca-ref__label", "overflow")).toBe("hidden");
    expect(declaration(componentsCssSource, ".orca-ref__label", "text-overflow")).toBe("ellipsis");
  });

  it("resolves those rules on the rendered pane, through the real stylesheets", () => {
    installDesignSystem();
    installSurfaceStyles();
    const container = renderSummary();
    container.classList.add("orca");

    for (const name of ["branch", "workItem", "request"]) {
      const field = valueOf(name).closest(".orca-field")!;
      expect(resolved(field, "grid-template-columns"), name).toMatch(/minmax\(0, ?1fr\)$/);
      expect(resolved(valueOf(name), "overflow-wrap"), name).toBe("anywhere");
    }
    // A scalar keeps its two columns; a block is one, and wins over the inspector's two — the
    // first version of this rule was one class deep and lost to `.orca-inspector .orca-field`.
    expect(resolved(valueOf("branch").closest(".orca-field")!, "grid-template-columns")).not.toMatch(
      /^minmax\(0, ?1fr\)$/,
    );
    for (const name of ["workItem", "request"]) {
      expect(resolved(valueOf(name).closest(".orca-field")!, "grid-template-columns"), name).toMatch(
        /^minmax\(0, ?1fr\)$/,
      );
    }
    const label = container.querySelector(".orca-ref__label")!;
    expect(resolved(label, "text-overflow")).toBe("ellipsis");
    expect(resolved(label.parentElement!, "max-width")).toBe("100%");
  });
});
