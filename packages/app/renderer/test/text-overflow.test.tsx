// @vitest-environment happy-dom
/**
 * Text that does not fit (docs/design/RULES.md rule 15), held where it is decided: the
 * stylesheet. happy-dom lays nothing out, so a wrap cannot be seen here; what can be read is
 * whether each rule says the thing that stops one.
 *
 * 1. A bounded label never wraps, and its outline encloses its text: one line, and as wide as
 *    what it says — or, for a label allowed to be longer than its box, cut at its end inside
 *    its outline.
 * 2. A number and its noun are one unit: `count.test.ts`.
 * 3. A bar stays one line, and the text that gives way is marked, with its whole in `title`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DraftBar } from "../src/config/draft-bar.js";
import { componentsCssSource } from "./type-notes.js";

/** Every `selector { … }` in a stylesheet, comments stripped. */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    body: match[2]!.trim(),
  }));
}

/** One declaration of the one rule whose whole selector is `selector`. */
function declared(selector: string, property: string): string | undefined {
  const rule = rules(componentsCssSource).find((r) => r.selector === selector);
  if (!rule) throw new Error(`components.css has no ${selector} rule`);
  for (const line of rule.body.split(";")) {
    const [name, ...rest] = line.split(":");
    if (name?.trim() === property) return rest.join(":").trim();
  }
  return undefined;
}

afterEach(cleanup);

describe("a bounded label", () => {
  /* Chips, badges and pills: one line, never narrower than their text, never squeezed. */
  const ENCLOSING = [".orca-chip", ".orca-badge", ".orca-pinned", ".orca-titlebar__attn"];
  /* Controls and key caps: one line, and a flex line never squeezes them. */
  const CONTROLS = [".orca-btn", ".orca-kbd", ".orca-seg__btn", ".orca-menu__item"];
  /* Parts of a crumb, an id token, a node's flag: one line. */
  const PARTS = [".orca-crumb__type", ".orca-crumb__version", ".orca-objid", ".orca-node__flag"];

  it.each([...ENCLOSING, ...CONTROLS, ...PARTS])("%s is one line", (selector) => {
    expect(declared(selector, "white-space")).toBe("nowrap");
  });

  it.each(ENCLOSING)("%s is as wide as what it says, and a line never squeezes it", (selector) => {
    expect(declared(selector, "min-width")).toBe("max-content");
    expect(declared(selector, "flex")).toBe("none");
  });

  it.each([".orca-btn", ".orca-kbd", ".orca-seg"])("%s keeps its width in a line that runs out", (selector) => {
    expect(declared(selector, "flex")).toBe("none");
  });

  it.each([".orca-ref__label", ".orca-crumb__name", ".orca-truncate"])(
    "%s, a label allowed to outgrow its box, is cut at its end inside it",
    (selector) => {
      expect(declared(selector, "min-width")).toBe("0");
      expect(declared(selector, "overflow")).toBe("hidden");
      expect(declared(selector, "text-overflow")).toBe("ellipsis");
    },
  );

  it("is never cut in a way that could cut it in the middle", () => {
    // `text-overflow` has one value in the component layer: the end.
    const values = rules(componentsCssSource).flatMap((rule) =>
      [...rule.body.matchAll(/text-overflow\s*:\s*([^;]+)/g)].map((m) => m[1]!.trim()),
    );
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set(["ellipsis"]));
  });
});

describe("a bar", () => {
  it.each([".orca-draftbar", ".orca-statusbar", ".orca-titlebar"])("%s is one line and never wraps", (selector) => {
    expect(declared(selector, "white-space")).toBe("nowrap");
    expect(declared(selector, "flex-wrap")).not.toBe("wrap");
  });

  it("gives way at its sentences, never at its count or its controls", () => {
    const note = "Editing a field replaces any raw text you had typed: the last edited wins.";
    render(
      <DraftBar
        changes={4}
        busy={false}
        note={note}
        message="Validated: no errors."
        onValidate={() => {}}
        onSave={() => {}}
        onDiscard={() => {}}
        onReload={() => {}}
      />,
    );
    const bar = screen.getByRole("group", { name: "Unsaved configuration changes" });
    // The count is one unit and is not the part that is cut.
    const count = within(bar).getByText("4\u00a0changes", { normalizer: (text) => text });
    expect(count.className).not.toContain("orca-truncate");
    // The sentences are, each whole in its title.
    const sentence = within(bar).getByText(note);
    expect(sentence.className).toContain("orca-truncate");
    expect(sentence.getAttribute("title")).toBe(note);
    expect(within(bar).getByText("Validated: no errors.").getAttribute("title")).toBe("Validated: no errors.");
    // The buttons are controls, never the thing that gives way.
    for (const button of within(bar).getAllByRole("button")) expect(button.className).not.toContain("orca-truncate");
  });
});
