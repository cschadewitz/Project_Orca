/**
 * A control's font reset never beats its type class.
 *
 * A `<button>` or an `<input>` takes the user agent's font rather than the page's, so a class
 * that styles one resets it with `font: inherit`. Written in the class's own rule, that reset
 * has a class's specificity and comes later in the cascade than `tokens.css`, so it beats the
 * `orca-text-*` class on the same element: the crumbs read 14px where their `type: label` note
 * says 13. Inside `:where()` the reset has no specificity at all — it still beats the user
 * agent, as every author rule does, and it loses to any type class, which is the order wanted.
 *
 * This reads the stylesheets rather than computed styles: happy-dom has no cascade worth
 * asserting on, and the mistake is one line of CSS that is easy to spot as text.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { componentsCssSource } from "./type-notes.js";

/** Every `selector { … }` in a stylesheet, comments stripped. */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    body: match[2]!.trim(),
  }));
}

/** The `font` shorthand set to inherit: the reset that wipes size, line height, weight and family at once. */
const RESETS_FONT = /(^|;)\s*font\s*:\s*inherit\s*(;|$)/;

const rendererSrc = fileURLToPath(new URL("../src", import.meta.url));
const stylesheets = (dir: string): { name: string; text: string }[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css")
      ? [{ name: path.slice(rendererSrc.length + 1), text: readFileSync(path, "utf8") }]
      : [];
  });

/**
 * Resets still written in their class's own rule, each over an element that takes a type class
 * — so each still renders at the shell's 14px. The next change folds them into the `:where()`.
 */
const NOT_YET = new Set([
  ".orca-bare",
  ".orca-btn",
  ".orca-badge__why",
  ".orca-nav",
  ".orca-crumb__more",
  ".orca-menu__item",
  ".orca-palette__input",
  ".orca-seg__btn",
  ".orca-plan__filter",
]);

describe("a control's font reset", () => {
  const sheets = [{ name: "components.css", text: componentsCssSource }, ...stylesheets(rendererSrc)];

  it("is written only at zero specificity, where a type class beats it", () => {
    const offenders = sheets.flatMap(({ name, text }) =>
      rules(text)
        .filter((rule) => RESETS_FONT.test(rule.body))
        .filter((rule) => !/^:where\(/.test(rule.selector) && !NOT_YET.has(rule.selector))
        .map((rule) => `${name}: ${rule.selector}`),
    );
    expect(offenders).toEqual([]);
  });

  it("covers the crumbs and the … that folds them", () => {
    const where = rules(componentsCssSource).find((rule) => /^:where\(.*\.orca-crumb\b/.test(rule.selector));
    expect(where?.selector).toContain(".orca-objhead__elision");
    expect(where?.body).toMatch(RESETS_FONT);
    for (const selector of [".orca-crumb", ".orca-objhead__elision"]) {
      const own = rules(componentsCssSource).find((rule) => rule.selector === selector);
      expect(own?.body, selector).not.toMatch(/(^|;)\s*font\s*:/);
    }
  });
});
