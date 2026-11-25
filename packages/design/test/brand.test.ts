/**
 * The mark and the app icon. They are drawn in token colours only, each file from the theme
 * its name says, so a token change that moves the accent or the ink is one the brand files
 * have to follow (docs/design/README.md, "Logo and app icon").
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const brand = join(pkg, "brand");
const appBuild = join(pkg, "..", "app", "build");

type Theme = "light" | "dark";
const tokens = JSON.parse(readFileSync(join(pkg, "tokens.json"), "utf8")) as {
  color: { tokens: { name: string; value: Record<Theme, string> }[] };
};
const value = (name: string, theme: Theme) => {
  const token = tokens.color.tokens.find((t) => t.name === name);
  assert.ok(token, `no colour token ${name}`);
  return token.value[theme].toLowerCase();
};

const files = readdirSync(brand).filter((f) => f.endsWith(".svg"));
// A mask, if a mark ever needs one, is drawn in pure black and white.
const maskColours = new Set(["#fff", "#000"]);

describe("brand files", () => {
  test("the mark and the icon exist in both themes", () => {
    for (const kind of ["mark", "icon"])
      for (const theme of ["light", "dark"])
        assert.ok(files.includes(`orrery-${kind}-${theme}.svg`), `missing orrery-${kind}-${theme}.svg`);
  });

  test("the small-size icon (16 and 24 px) exists in both themes, on both grids", () => {
    for (const theme of ["light", "dark"])
      for (const grid of ["", "-macos"])
        assert.ok(
          files.includes(`orrery-icon-${theme}-small${grid}.svg`),
          `missing orrery-icon-${theme}-small${grid}.svg`,
        );
  });

  for (const file of files) {
    test(`${file} uses only its theme's tokens`, () => {
      const theme: Theme = file.includes("-dark") ? "dark" : "light";
      const allowed = new Set(["ink-primary", "accent", "surface-base", "border-hairline"].map((n) => value(n, theme)));
      const svg = readFileSync(join(brand, file), "utf8");
      const used = [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
      assert.ok(used.length > 0);
      for (const colour of used)
        assert.ok(allowed.has(colour) || maskColours.has(colour), `${file}: ${colour} is not a ${theme} token`);
    });
  }

  test("electron-builder finds an icon for every platform", () => {
    for (const icon of ["icon.icns", "icon.ico", "icon.png"])
      assert.ok(existsSync(join(appBuild, icon)), `packages/app/build/${icon} is missing`);
  });
});
