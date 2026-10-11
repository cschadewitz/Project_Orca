/**
 * A number and the word it counts are one unit (docs/design/RULES.md rule 15): the noun agrees
 * with the number, and the two are joined by a no-break space so no line ever ends on a bare
 * number. A list of units can still wrap, between them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NBSP, counted, countedOf, unit } from "../src/ui/count.js";

describe("a count and its noun", () => {
  it("joins them with a no-break space, never an ordinary one", () => {
    expect(NBSP).toBe(" ");
    expect(counted(4, "change")).toBe("4 changes");
    expect(counted(4, "change")).not.toContain(" ");
    expect(unit("+2", "added")).toBe("+2 added");
  });

  it("agrees: one is singular, every other number is plural", () => {
    expect(counted(1, "edge")).toBe("1 edge");
    expect(counted(0, "edge")).toBe("0 edges");
    expect(counted(2, "edge")).toBe("2 edges");
    expect(counted(1, "entry", "entries")).toBe("1 entry");
    expect(counted(3, "entry", "entries")).toBe("3 entries");
  });

  it("says a narrowed list as one unit, agreeing with the total", () => {
    expect(countedOf(9, 9, "item")).toBe("9 items");
    expect(countedOf(3, 9, "item")).toBe("3 of 9 items");
    expect(countedOf(0, 1, "decision")).toBe("0 of 1 decision");
  });

  it("leaves the separators between units breakable", () => {
    const line = [counted(1, "error"), counted(2, "warning"), counted(0, "note")].join(" · ");
    // The only ordinary spaces are around the separators: a line breaks there or nowhere.
    expect(line.split(" ")).toEqual(["1 error", "·", "2 warnings", "·", "0 notes"]);
  });
});

describe("the renderer's sources", () => {
  /* The shape the helper replaced: a number interpolated straight in front of a word, with an
     ordinary space between them. `${n} nodes` read "1 nodes" and broke between the two. A
     line that still writes one has to say why on the line (`count-ok:`), which nothing does
     today. Numbers that are not counts of a noun ("v3", "line 7", "#148", "100%") are not
     this shape, because the word after them is not a plural noun. */
  const COUNT = /\$\{[^}]*(?:\.length|[cC]ount|total|shown|errors|warnings|notes|pending|changes)\}\s(?:[a-z]+s)\b/;
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });

  it("knows the shape it is looking for", () => {
    // Lines this branch replaced, and lines that only look like them.
    expect(COUNT.test("{`${graph.edges.length} edges, starting at `}")).toBe(true);
    expect(COUNT.test("hintMachine: `${workflow.id} · v${workflow.version} · ${workflow.nodeCount} nodes`,")).toBe(true);
    expect(COUNT.test("`${shown} of ${total} decisions`")).toBe(true);
    expect(COUNT.test("{`${counted(graph.edges.length, \"edge\")}`}")).toBe(false);
    expect(COUNT.test("`v${workflow.version} is current`")).toBe(false);
  });

  it("count nouns through counted, never as a bare interpolation", () => {
    const offenders = files(root).flatMap((path) =>
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line, index) => ({ line, at: `${path.slice(root.length + 1)}:${index + 1}` }))
        .filter(({ line }) => COUNT.test(line) && !line.includes("count-ok:"))
        .map(({ line, at }) => `${at}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
