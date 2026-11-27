/** The GTK theme a Linux window starts with (#1109): only an explicit dark choice sets one. */
import { expect, it } from "vitest";
import { gtkThemeFor } from "../src/main/linux-gtk-theme.js";

it("starts GTK dark for an explicit dark choice on Linux", () => {
  expect(gtkThemeFor("linux", "dark", {})).toBe("Adwaita:dark");
});

it("leaves GTK to the desktop otherwise", () => {
  expect(gtkThemeFor("linux", "system", {})).toBeUndefined();
  expect(gtkThemeFor("linux", "light", {})).toBeUndefined();
  expect(gtkThemeFor("win32", "dark", {})).toBeUndefined();
  expect(gtkThemeFor("darwin", "dark", {})).toBeUndefined();
});

it("never overrides a GTK_THEME somebody set", () => {
  expect(gtkThemeFor("linux", "dark", { GTK_THEME: "Yaru-dark" })).toBeUndefined();
});
