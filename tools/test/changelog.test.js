// The fragment reader and renderer behind `node tools/release.js prepare`. What is being
// protected is a release's notes: a fragment that is dropped, reordered or run together
// with the next one is a change nobody upgrading gets told about.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteFragments, readFragments, renderEntries } from "../changelog.js";

let dir;

const write = (name, body) => writeFileSync(join(dir, name), body);
const render = () => renderEntries(readFragments(dir)).join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-changelog-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readFragments", () => {
  it("orders by issue number rather than by string", () => {
    write("99-late.added.md", "- **cli:** ninety-nine.\n");
    write("101-early.added.md", "- **cli:** a hundred and one.\n");
    write("9-earliest.added.md", "- **cli:** nine.\n");

    expect(readFragments(dir).map((f) => f.name)).toEqual([
      "9-earliest.added.md",
      "99-late.added.md",
      "101-early.added.md",
    ]);
  });

  it("ignores the directory's README and returns nothing for a missing directory", () => {
    write("README.md", "# Changelog fragments\n");

    expect(readFragments(dir)).toEqual([]);
    expect(readFragments(join(dir, "nope"))).toEqual([]);
  });

  it("refuses a fragment whose section is not one of the four", () => {
    write("12-typo.add.md", "- **cli:** something.\n");

    expect(() => readFragments(dir)).toThrow(/store, added, changed, fixed/);
  });

  it("refuses an empty fragment", () => {
    write("12-empty.added.md", "\n\n");

    expect(() => readFragments(dir)).toThrow(/empty fragment/);
  });

  it("reads every fragment committed to changelog.d", () => {
    // The real directory, not a temporary one: `release.js notes` and `prepare` stop at the
    // first misnamed fragment, and the milestone close that runs them is too late to find it.
    expect(() => readFragments(fileURLToPath(new URL("../../changelog.d", import.meta.url)))).not.toThrow();
  });
});

describe("renderEntries", () => {
  it("says the store did not move when no fragment claims it did", () => {
    write("12-a.added.md", "- **cli:** something.\n");

    expect(render()).toBe(
      ["### Store format", "", "No change.", "", "### Added", "", "#### cli", "", "- something."].join("\n"),
    );
  });

  it("omits every empty section but the store one, and orders the rest", () => {
    write("12-a.fixed.md", "- **engine:** a fix.\n");
    write("13-b.store.md", "The lease directory is new; an older store needs no migration.\n");

    expect(render()).toBe(
      [
        "### Store format",
        "",
        "The lease directory is new; an older store needs no migration.",
        "",
        "### Fixed",
        "",
        "#### engine",
        "",
        "- a fix.",
      ].join("\n"),
    );
  });

  it("runs two bullet fragments together, so the list renders tight like a hand-written one", () => {
    write("12-a.added.md", "- **cli:** one.\n  Wrapped onto a second line.\n");
    write("13-b.added.md", "- **cli:** two.\n");

    expect(render()).toBe(
      [
        "### Store format",
        "",
        "No change.",
        "",
        "### Added",
        "",
        "#### cli",
        "",
        "- one.",
        "  Wrapped onto a second line.",
        "- two.",
      ].join("\n"),
    );
  });

  it("keeps the blank line between two prose fragments", () => {
    write("12-a.store.md", "First paragraph.\n");
    write("13-b.store.md", "Second paragraph.\n");

    expect(render()).toBe(["### Store format", "", "First paragraph.", "", "Second paragraph."].join("\n"));
  });

  it("separates prose from the bullets that follow it", () => {
    write("12-a.store.md", "Prose about the store.\n");
    write("13-b.store.md", "- A bullet, unusually.\n");

    expect(render()).toBe(["### Store format", "", "Prose about the store.", "", "- A bullet, unusually."].join("\n"));
  });

  it("renders nothing at the edges, so the section drops straight under its heading", () => {
    write("12-a.added.md", "\n- **cli:** padded with blank lines.\n\n\n");

    const lines = render().split("\n");
    expect(lines[0]).toBe("### Store format");
    expect(lines[lines.length - 1]).toBe("- padded with blank lines.");
  });
});

describe("grouping a section by change target", () => {
  it("gathers a target's entries under one heading however they were filed, alphabetically", () => {
    write("12-a.added.md", "- **cli:** the first cli entry.\n");
    write("13-b.added.md", "- **app:** an app entry.\n");
    write("14-c.added.md", "- **cli:** the second cli entry.\n");

    expect(render().split("\n").slice(4)).toEqual([
      "### Added",
      "",
      "#### app",
      "",
      "- an app entry.",
      "",
      "#### cli",
      "",
      "- the first cli entry.",
      "- the second cli entry.",
    ]);
  });

  it("splits a fragment whose bullets name different targets", () => {
    write("12-a.added.md", "- **protocol/daemon:** the control methods.\n- **cli:** the flag over them.\n");

    expect(render().split("\n").slice(4)).toEqual([
      "### Added",
      "",
      "#### cli",
      "",
      "- the flag over them.",
      "",
      "#### protocol/daemon",
      "",
      "- the control methods.",
    ]);
  });

  it("keeps a bullet's own continuation lines with it when it is regrouped", () => {
    write("12-a.changed.md", "- **app:** one.\n  Wrapped.\n- **cli:** two.\n");
    write("13-b.changed.md", "- **app:** three.\n  - a nested bullet\n");

    expect(render().split("\n").slice(4)).toEqual([
      "### Changed",
      "",
      "#### app",
      "",
      "- one.",
      "  Wrapped.",
      "- three.",
      "  - a nested bullet",
      "",
      "#### cli",
      "",
      "- two.",
    ]);
  });

  it("leaves a bullet with no target prefix ungrouped, above the headings", () => {
    write("12-a.fixed.md", "- **cli:** targeted.\n");
    write("13-b.fixed.md", "- No prefix on this one.\n");

    expect(render().split("\n").slice(4)).toEqual([
      "### Fixed",
      "",
      "- No prefix on this one.",
      "",
      "#### cli",
      "",
      "- targeted.",
    ]);
  });

  it("groups the store section too, when a store fragment is written as targeted bullets", () => {
    write("12-a.store.md", "Prose about the store.\n");
    write("13-b.store.md", "- **engine:** the event payloads moved.\n");

    expect(render()).toBe(
      ["### Store format", "", "Prose about the store.", "", "#### engine", "", "- the event payloads moved."].join(
        "\n",
      ),
    );
  });

  it("keeps the prefix on a bullet that is nothing else, rather than leaving a bare marker", () => {
    write("12-a.added.md", "- **app:**\n  The text starts on the next line.\n");

    expect(render().split("\n").slice(4)).toEqual([
      "### Added",
      "",
      "- **app:**",
      "  The text starts on the next line.",
    ]);
  });
});

describe("deleteFragments", () => {
  it("removes exactly what it rendered", () => {
    write("12-a.added.md", "- **cli:** something.\n");
    write("README.md", "# Changelog fragments\n");
    const fragments = readFragments(dir);

    deleteFragments(fragments, dir);

    expect(readFragments(dir)).toEqual([]);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });
});
