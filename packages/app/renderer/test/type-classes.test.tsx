// @vitest-environment happy-dom
/**
 * The guard for #211: a component class no longer carries a size, so every element that
 * takes one of the noted classes in `components.css` must also take its `orca-text-*`
 * class. Miss it and the element silently inherits the shell's 14px — it renders, it looks
 * almost right, and nothing fails. That is the failure mode this test exists for, and it
 * is why the check is a sweep over rendered trees rather than a list of call sites: a
 * surface written three waves from now is covered the day it is mounted here.
 *
 * The expected side is read out of `components.css` itself (`type-notes.ts`), so the note
 * above a rule is the single statement of what that rule expects. Adding a `type:` note to
 * a new component class is enough to put every element that takes it under this test.
 *
 * The trees swept are the ones that exist: the whole chrome, the command palette open, the
 * Runs surface with rows, and `#preview` — which is the gallery of every `ui/` primitive
 * in both themes, and so is how the primitives get covered without twenty mounts here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Preview } from "../src/preview/preview.js";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { LIVE, harness, installBridge, renderChrome, stubBridge, stubMatchMedia, type Harness } from "./harness.js";
import {
  checkableNotes,
  componentsCssSource,
  describeElement,
  expectedStyleFor,
  textClasses,
  type TypeNote,
} from "./type-notes.js";

const teardown: (() => void)[] = [];
const notes: TypeNote[] = checkableNotes();

/**
 * Every element under `root` that a `type:` note applies to, paired with the note. The
 * sweep is over the tree, not over the notes, because the question being asked is "is
 * anything on screen missing its size", and an element is the thing that can be missing it.
 */
function noted(root: ParentNode): { element: Element; note: TypeNote }[] {
  const found: { element: Element; note: TypeNote }[] = [];
  for (const element of root.querySelectorAll("*")) {
    const note = expectedStyleFor(element, notes);
    if (note) found.push({ element, note });
  }
  return found;
}

/** The offenders in `root`, as lines a person can act on without opening a debugger. */
function violations(root: ParentNode): string[] {
  return noted(root).flatMap(({ element, note }) => {
    const carried = textClasses(element);
    const want = `orca-text-${note.style}`;
    if (carried.length === 0) {
      return [`${describeElement(element)} needs ${want} (components.css:${note.line} — ${note.selector})`];
    }
    if (carried.length > 1) {
      return [`${describeElement(element)} carries ${carried.length} type classes: ${carried.join(" ")}`];
    }
    if (carried[0] !== want) {
      return [`${describeElement(element)} carries ${carried[0]}, wants ${want} (components.css:${note.line})`];
    }
    return [];
  });
}

/** A sweep that asserts it swept something: an empty tree would pass vacuously. */
function expectTyped(root: ParentNode, atLeast: number): void {
  expect(violations(root)).toEqual([]);
  expect(noted(root).length).toBeGreaterThanOrEqual(atLeast);
}

describe("the type notes in components.css", () => {
  it("are all parseable, and name styles the scale actually has", () => {
    expect(notes.length).toBeGreaterThan(60);
    for (const note of notes) {
      expect(note.selector, `components.css:${note.line}`).toMatch(/^[.#a-z[]/);
      expect(note.style, `components.css:${note.line}`).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it("are the only place a type size is written", () => {
    /* The premise of the whole exercise: a rule that writes its own size makes the note
       above it a lie. The header of components.css allows exactly two shapes through — a
       `--text-*-size` where a size is needed without the rest of a style, and an `--icon-*`
       where the thing being sized is a glyph, not type. Anything else is a regression. */
    const sizes = componentsCssSource
      .split("\n")
      .filter((line) => /^\s*font-size:/.test(line))
      .filter((line) => !/var\(--(text-[a-z-]+-size|icon-[a-z]+)\)/.test(line));
    expect(sizes).toEqual([]);
  });
});

describe("every noted class on screen carries its type class", () => {
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  describe("the ui primitives, through #preview", () => {
    it("renders every primitive at its intended size", () => {
      const { container } = render(<Preview />);
      expectTyped(container, 40);
    });
  });

  describe("the chrome, the palette and the Runs surface", () => {
    let h: Harness;

    beforeEach(() => {
      stubMatchMedia(1440);
      stubBridge(() => Promise.resolve(LIVE));
      h = harness();
      teardown.push(h.dispose);
    });

    it("types the title bar, the sidebar, the status bar and the docked panel", async () => {
      const { container } = renderChrome(h);
      await screen.findByRole("button", { name: "Attention" });
      expectTyped(container, 10);
    });

    it("types the command palette", async () => {
      renderChrome(h);
      await screen.findByRole("button", { name: "Attention" });
      fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
      const palette = await screen.findByRole("dialog", { name: "Command palette" });
      expectTyped(palette, 5);
    });
  });

  describe("the Runs surface with rows", () => {
    it("types the rows, the filter and the count", async () => {
      installBridge();
      const h = harness();
      teardown.push(h.dispose);
      const { Providers } = h;
      const { container } = render(
        <Providers>
          <RunsSurface connection="live" />
        </Providers>,
      );
      // The tree's rows are `treeitem`s, not options: the run tree has depth (#156). The
      // timeline beside it is still a listbox, but it has nothing in it until a run is
      // selected, so the tree is what says this surface has drawn.
      await waitFor(() => expect(screen.queryAllByRole("treeitem").length).toBeGreaterThan(0));
      expectTyped(container, 10);
    });
  });
});
