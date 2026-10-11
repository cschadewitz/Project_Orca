// @vitest-environment happy-dom
/**
 * A status chip is never narrower than its own word, on any surface.
 *
 * "✓ succeeded" ran out past its own ground twice, on two surfaces, for one reason: the run
 * tree and the claims list each handed `StatusChip` a class that set `width: 12ch`, and twelve
 * zeros of Plex at caption size are narrower than the glyph, the gap, the word and the chip's
 * padding together. The run tree's copy was fixed in the run tree's own stylesheet, so the
 * claims list kept its copy of the bug. The fix now lives in the component: `.orca-chip`
 * refuses to be narrower than its content, a column of statuses is `StatusChip`'s `aligned`,
 * and `StatusChip` takes no `className` to size it with.
 *
 * happy-dom does no layout, so nothing here measures a chip. What it can hold — the move
 * `focus-and-selection.test.ts` makes for the focus ring — is the structure that makes the
 * claim true:
 *
 * - the component rule carries the guarantee, and the column variant cannot defeat it;
 * - no stylesheet the app adds on top of the component layer sizes a chip;
 * - every status on the two lists that had the bug is the shared chip and nothing else;
 * - no screen writes chip markup by hand, so there is one implementation to fix.
 */
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_STATUSES, STATUS_PRESENTATION, type RunStatus } from "@orca/design";
import { AgentsSurface } from "../src/agents/agents-surface.js";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { AGENTS_LIST } from "./fixtures-agents.js";
import { installBridge, harness, type Harness } from "./harness.js";
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

/** Every `selector { … }` in a stylesheet, comments stripped — the prose argues about widths. */
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

const componentRule = (selector: string): string => {
  const found = rules(componentsCssSource).find((rule) => rule.selector === selector);
  if (!found) throw new Error(`components.css has no ${selector} rule`);
  return found.body;
};

/** The properties that decide how wide a box is drawn, against its content. */
const SIZING = ["width", "min-width", "max-width", "flex", "flex-shrink", "flex-basis", "overflow", "overflow-x"];

/**
 * The chip itself or one of its parts — `orca-chip`, `orca-chip--failed`, `orca-chip__label` —
 * and not `orca-chips`, the run of them that wraps, which a surface composes on purpose.
 */
const CHIP_CLASS = /\borca-chip(?![a-z0-9])/;

describe("the chip's box", () => {
  it("is never narrower than its glyph and word, by the component rule itself", () => {
    const chip = componentRule(".orca-chip");
    /* A minimum beats a `width` and a `max-width` both, so this is the declaration that
       makes a `width: 12ch` from anywhere harmless; `flex: none` is the same promise to a
       flex row that runs out of room. `nowrap` is what makes "content" one line. */
    expect(declaration(chip, "min-width")).toBe("max-content");
    expect(declaration(chip, "flex")).toBe("none");
    expect(declaration(chip, "white-space")).toBe("nowrap");
    // And the base rule does not clamp itself: no width, no ceiling, nothing clipped.
    for (const property of ["width", "max-width", "overflow"]) {
      expect(declaration(chip, property), property).toBeUndefined();
    }
  });

  it("lines a column up with a floor that the base rule still beats", () => {
    const aligned = componentRule(".orca-chip--aligned");
    /* The floor is a `width`, never a `min-width` (which would replace the base rule's
       guarantee) or a `max-width` (which would be the bug again): `min-width: max-content`
       wins over it, so a longer label grows its chip. */
    expect(declaration(aligned, "min-width")).toBeUndefined();
    expect(declaration(aligned, "max-width")).toBeUndefined();
    expect(declaration(aligned, "overflow")).toBeUndefined();
    /* The floor is one custom property, defined once on the shell root, so the one other box
       that has to be exactly as wide — the run tree's never-run placeholder — reads the same
       number rather than a copy of it. */
    expect(declaration(aligned, "width")).toBe("var(--chip-aligned-width)");
    // The longest word's room plus exactly the chip's other parts, each by its token.
    const root = rules(componentsCssSource).find(
      (rule) => rule.selector === ".orca" && declaration(rule.body, "--chip-aligned-width") !== undefined,
    );
    expect(root, "components.css defines --chip-aligned-width on .orca").toBeDefined();
    const floor = (declaration(root!.body, "--chip-aligned-width") ?? "").replace(/\s+/g, " ");
    expect(floor).toMatch(/^calc\( ?\d+ch \+ /);
    for (const part of ["--icon-sm", "--space-0-5", "--space-1-5", "--stroke-hairline"]) {
      expect(floor, part).toContain(`var(${part})`);
    }
  });

  it("holds the run tree's never-run placeholder to exactly the aligned chip's width", () => {
    /* A row with no status (a step that never ran) draws a placeholder in the status column.
       It was `12ch` of label type, about ten pixels short of an aligned chip, so on those rows
       the name and everything after it sat off the column. It now takes the chip's own
       custom property — and the chip's type, because `ch` resolves in the face of the element
       that uses it, so only the chip's type makes it the same number of pixels. */
    const runsCss = sources([".css"]).find((sheet) => sheet.name === "runs/runs.css")!.text;
    const placeholder = rules(runsCss).find((rule) => rule.selector === ".orca-runs__skipped")!.body;
    expect(declaration(placeholder, "width")).toBe("var(--chip-aligned-width)");
    expect(declaration(placeholder, "flex")).toBe("none");
    // The chip's weight; its size comes from the type class the run tree puts beside it.
    expect(declaration(placeholder, "font-weight")).toBe(declaration(componentRule(".orca-chip"), "font-weight"));
    const tree = sources([".tsx"]).find((file) => file.name === "runs/tree/run-tree.tsx")!.text;
    expect(tree).toMatch(/className=\{`orca-runs__skipped \$\{textClass\("caption"\)\}`\}/);
    // And no stylesheet restates the arithmetic: the property is defined once.
    const definitions = [componentsCssSource, ...sources([".css"]).map((sheet) => sheet.text)].flatMap((css) => [
      ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--chip-aligned-width\s*:/g),
    ]);
    expect(definitions).toHaveLength(1);
  });

  it("is sized by no stylesheet the app adds on top of the component layer", () => {
    const sizing: string[] = [];
    for (const sheet of sources([".css"])) {
      for (const rule of rules(sheet.text)) {
        if (!CHIP_CLASS.test(rule.selector)) continue;
        for (const property of SIZING) {
          if (declaration(rule.body, property) !== undefined)
            sizing.push(`${sheet.name} — ${rule.selector} { ${property} }`);
        }
      }
    }
    expect(sizing).toEqual([]);

    /* The two classes that used to size a chip from a surface — the run tree's, fixed in
       place, and the claims list's, which was not — are gone rather than corrected, so
       there is no second statement of the chip's width left to drift. */
    const retired = /\.orca-runs__chip\b|\.orca-agents__claim-status\b/;
    expect(sources([".css"]).filter((sheet) => retired.test(sheet.text.replace(/\/\*[\s\S]*?\*\//g, "")))).toEqual([]);
  });
});

/** The class list `StatusChip` draws, and nothing a surface added to it. */
function expectSharedStatusChip(chip: Element, where: string): RunStatus {
  const status = RUN_STATUSES.find((s) => chip.classList.contains(`orca-chip--${s}`));
  expect(status, `${where}: a chip with no status modifier`).toBeDefined();
  const allowed = new Set(["orca-chip", "orca-text-caption", `orca-chip--${status}`, "orca-chip--aligned"]);
  expect(
    [...chip.classList].filter((name) => !allowed.has(name)),
    `${where}: a class the component did not put there`,
  ).toEqual([]);
  // Glyph and word, from the one map (rule 4).
  expect(chip.querySelector(".orca-chip__glyph")?.textContent, where).toBe(STATUS_PRESENTATION[status!].glyph);
  expect(chip.querySelector(".orca-chip__label")?.textContent, where).toBe(STATUS_PRESENTATION[status!].word);
  return status!;
}

describe("every status on the lists that had the bug is the shared chip", () => {
  let h: Harness;
  const teardown: (() => void)[] = [];

  beforeEach(() => {
    installBridge();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  function mount(surface: JSX.Element): void {
    h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    render(<Providers>{surface}</Providers>);
  }

  it("on the claims list, one aligned column of them", async () => {
    mount(<AgentsSurface connection="live" />);
    await screen.findByText("4 agents on 2 hosts");

    const items = within(screen.getByRole("region", { name: "Claimed work" })).getAllByRole("listitem");
    expect(items).toHaveLength(AGENTS_LIST.claims.length);
    items.forEach((item, index) => {
      const chips = item.querySelectorAll(".orca-chip");
      expect(chips, `claim ${index}`).toHaveLength(1);
      expect(expectSharedStatusChip(chips[0]!, `claim ${index}`)).toBe(AGENTS_LIST.claims[index]!.owner.status);
      expect(chips[0]!.classList.contains("orca-chip--aligned"), `claim ${index}`).toBe(true);
    });
  });

  it("on the run tree, one aligned column of them, runs and steps alike", async () => {
    mount(<RunsSurface connection="live" />);
    const tree = await screen.findByRole("tree", { name: "Run tree" });
    // Open the fixture with everything in it, so step rows are on screen too.
    fireEvent.keyDown(tree, { key: "End", code: "End" });
    await act(async () => {
      fireEvent.keyDown(tree, { key: "ArrowRight", code: "ArrowRight" });
    });
    await waitFor(() => expect(within(tree).queryAllByRole("treeitem").length).toBeGreaterThan(5));

    const chips = [...tree.querySelectorAll(".orca-chip")];
    expect(chips.length).toBeGreaterThan(5);
    for (const chip of chips) {
      const where = chip.closest("[role='treeitem']")?.id ?? "a tree row";
      expectSharedStatusChip(chip, where);
      expect(chip.classList.contains("orca-chip--aligned"), where).toBe(true);
    }
  });
});

describe("no screen draws a chip by hand", () => {
  it("leaves the chip classes to the two primitives that own them", () => {
    /* `Chip` and `StatusChip` are the only places the markup is written, so a fix to either
       is a fix everywhere a chip is drawn. Comments are stripped first: several explain why
       a thing is *not* an `orca-chip`, and that is the argument, not the markup. */
    const owners = new Set(["ui/chip.tsx", "ui/status-chip.tsx"]);
    const handRolled = sources([".ts", ".tsx"])
      .filter((file) => !owners.has(file.name))
      .filter((file) => CHIP_CLASS.test(file.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")))
      .map((file) => file.name);
    expect(handRolled).toEqual([]);
  });
});
