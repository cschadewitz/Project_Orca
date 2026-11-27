import { describe, expect, it } from "vitest";
import { checkTemplate, templateReferences } from "../src/index.js";
import { parseEachTag, scanTags } from "../src/template/render.js";

// The regexes the parser used before; the scanners must give the same answers.
const OLD_TAG = /\{\{(!--[\s\S]*?--|[^}]*)\}\}/g;
const OLD_EACH = /^#each\s+(.+?)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?$/;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomText(rand: () => number, pieces: string[], max: number): string {
  let out = "";
  const n = Math.floor(rand() * max);
  for (let i = 0; i < n; i++) out += pieces[Math.floor(rand() * pieces.length)];
  return out;
}

describe("template tag scanner", () => {
  it("matches the old tag regex on random input", () => {
    const rand = seeded(1);
    const pieces = ["{{", "}}", "{", "}", "!--", "--", "-", "!", "a", " ", "\n", "{{!--", "--}}", "#each", "/if"];
    for (let k = 0; k < 20_000; k++) {
      const src = randomText(rand, pieces, 14);
      const want = [...src.matchAll(OLD_TAG)].map((m) => [m.index, m.index + m[0].length, m[1]]);
      const got = [...scanTags(src)].map((m) => [m.index, m.end, m.inner]);
      expect(got, JSON.stringify(src)).toEqual(want);
    }
  });

  it("parses many unclosed comment openers in linear time", () => {
    const src = "{{!--".repeat(52_000);
    const start = performance.now();
    expect(checkTemplate(src)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe("#each tag parser", () => {
  it("matches the old each regex on random input", () => {
    const rand = seeded(2);
    const pieces = ["#each", " ", "  ", "\t", "\n", "as", "a", "b", "x.y", ",", "$", "_", "9", "-"];
    for (let k = 0; k < 50_000; k++) {
      const tag = "#each" + randomText(rand, pieces, 10);
      const m = OLD_EACH.exec(tag);
      const want = m ? { src: m[1], itemVar: m[2], ...(m[3] ? { indexVar: m[3] } : {}) } : undefined;
      expect(parseEachTag(tag), JSON.stringify(tag)).toEqual(want);
    }
  });

  it("keeps the documented forms", () => {
    expect(parseEachTag("#each workItem.acceptanceCriteria as criterion")).toEqual({
      src: "workItem.acceptanceCriteria",
      itemVar: "criterion",
    });
    expect(parseEachTag("#each items as item, i")).toEqual({ src: "items", itemVar: "item", indexVar: "i" });
    expect(parseEachTag("#each a as b as c")).toEqual({ src: "a as b", itemVar: "c" });
  });

  it("rejects a long run of spaces in linear time", () => {
    const start = performance.now();
    expect(() => templateReferences(`{{#each${" ".repeat(20_000)}x}}{{/each}}`)).toThrow(/malformed each/);
    expect(() => templateReferences(`{{#each a${" ".repeat(20_000)}as${" ".repeat(20_000)}}}`)).toThrow(
      /malformed each/,
    );
    expect(performance.now() - start).toBeLessThan(250);
  });
});
