/**
 * The bundled faces. These tests guard the three ways the type track silently breaks:
 * a `url()` that resolves to nothing, a family the stacks name but no `@font-face`
 * declares, and a status glyph no bundled face carries — which is not a missing glyph but a
 * different typeface per platform, at chip scale, next to the word.
 *
 * Glyph *coverage* inside the woff2 files is verified where the files are made, by
 * `tools/font-build/build-fonts.js`; it has the font parser and this suite does not. What is
 * checked here is that the declarations and the files on disk still agree.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const read = (f: string) => readFileSync(join(pkg, f), "utf8");

interface Face {
  family: string;
  file: string;
  weight: number;
  style: string;
}

const tokens = JSON.parse(read("tokens.json")) as {
  type: { fonts: Face[]; families: Record<string, string> };
};
const css = read("css/tokens.css");

/** `file` is relative to css/tokens.css, which is what the browser resolves it against. */
const onDisk = (face: Face) => join(pkg, "css", face.file);

describe("bundled faces", () => {
  test("every declared face has a file", () => {
    assert.ok(tokens.type.fonts.length > 0, "type.fonts is empty: nothing would be bundled");
    for (const face of tokens.type.fonts) {
      assert.ok(existsSync(onDisk(face)), `${face.file} is declared in tokens.json but not in packages/design/fonts`);
    }
  });

  test("the licences ship beside the fonts", () => {
    for (const licence of ["fonts/LICENSE-IBM-Plex.txt", "fonts/LICENSE-Noto.txt"]) {
      assert.ok(existsSync(join(pkg, licence)), `${licence} is missing`);
      assert.match(read(licence), /SIL Open Font License/, `${licence} is not the OFL`);
    }
  });

  test("the package ships the fonts folder", () => {
    const manifest = JSON.parse(read("package.json")) as { files: string[] };
    assert.ok(
      manifest.files.includes("fonts"),
      "package.json `files` must include fonts, or url() resolves to nothing",
    );
  });
});

describe("tokens.css", () => {
  test("declares an @font-face per bundled file, with font-display: block", () => {
    for (const face of tokens.type.fonts) {
      const rule = css.match(
        new RegExp(`@font-face \\{[^}]*${face.file.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}[^}]*\\}`),
      );
      assert.ok(rule, `no @font-face for ${face.file}`);
      assert.match(rule[0], new RegExp(`font-family: "${face.family}"`));
      assert.match(rule[0], new RegExp(`font-weight: ${face.weight}\\b`));
      assert.match(rule[0], new RegExp(`font-style: ${face.style}\\b`));
      /* swap would flash the fallback face on every window open; in a desktop app that
         reads as a bug, and the files are local. */
      assert.match(rule[0], /font-display: block/, `${face.file} must not swap`);
    }
  });

  test("the symbol faces lead every stack, and every bundled face is reachable", () => {
    const bundled = new Set(tokens.type.fonts.map((f) => f.family));
    const named = new Set<string>();
    for (const [name, stack] of Object.entries(tokens.type.families)) {
      const quoted = [...stack.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      quoted.forEach((f) => named.add(f));
      /* The symbol faces carry the status glyphs and no text, so they go first: anything
         later in the stack would only be reached for a glyph Plex already lacks. */
      assert.deepEqual(
        quoted.slice(0, 2),
        ["Noto Sans Symbols 2", "Noto Sans Math"],
        `--font-${name} must lead with the bundled symbol faces`,
      );
    }
    for (const family of bundled) {
      assert.ok(named.has(family), `${family} is bundled but no stack in type.families names it`);
    }
  });
});

describe("the six surfaces", () => {
  const semantics = JSON.parse(read("semantics.json")) as {
    surface?: Record<string, { word?: string; glyph?: string }>;
  };

  /* The order is the sidebar's and the ⌘<n> shortcuts are read off it, so it is part of the
     declaration rather than an accident of JSON key order. */
  test("semantics.json declares all six, in sidebar order, each with a word and a glyph", () => {
    const surface = semantics.surface;
    assert.ok(surface, "semantics.json has no `surface` map: the collapsed rail has nothing to draw");
    assert.deepEqual(Object.keys(surface), ["attention", "runs", "plan", "workflows", "agents", "config"]);
    for (const [id, presentation] of Object.entries(surface)) {
      assert.ok(presentation.word, `surface ${id} has no word — it is the button's accessible name`);
      assert.ok(presentation.glyph, `surface ${id} has no glyph — below 960px it would draw nothing`);
      assert.equal([...presentation.glyph].length, 1, `surface ${id}'s glyph must be one character`);
    }
  });

  /* Six destinations told apart by shape alone, once the labels are hidden. Two surfaces
     sharing a glyph would make the rail ambiguous in exactly the way #261 was filed about. */
  test("no two surfaces share a glyph", () => {
    const glyphs = Object.values(semantics.surface ?? {}).map((s) => s.glyph);
    assert.equal(new Set(glyphs).size, glyphs.length, `the rail repeats a glyph: ${glyphs.join(" ")}`);
  });
});

describe("status glyphs", () => {
  const semantics = JSON.parse(read("semantics.json")) as Record<string, unknown>;

  const glyphs = (node: unknown, found = new Set<string>()): Set<string> => {
    if (!node || typeof node !== "object") return found;
    const record = node as Record<string, unknown>;
    if (typeof record.glyph === "string") found.add(record.glyph);
    for (const value of Object.values(record)) glyphs(value, found);
    return found;
  };

  test("come from a face we bundle, not from the OS", () => {
    /* The set tools/font-build/build-fonts.js subsets into the two Noto faces. Adding a
       glyph to semantics.json without adding it there is the failure this catches. */
    const build = readFileSync(join(here, "..", "..", "..", "tools", "font-build", "build-fonts.js"), "utf8");
    for (const glyph of glyphs(semantics)) {
      const cp = `0x${glyph.codePointAt(0)!.toString(16)}`;
      assert.ok(
        build.includes(cp),
        `semantics.json renders ${glyph} (${cp}) but no bundled face carries it — it would fall ` +
          `back to a different typeface on every platform. Add it to build-fonts.js and rerun ` +
          `pnpm run design:fonts.`,
      );
    }
  });

  test("and the symbol faces carry nothing semantics.json does not render", () => {
    /* The other direction. A glyph swapped out of semantics.json and left in SYMBOLS — the
       step's ▭ when it became ◫ — still ships in every install, and the list stops saying
       what the app draws, which is the one thing a reader of build-fonts.js trusts it for. */
    const build = readFileSync(join(here, "..", "..", "..", "tools", "font-build", "build-fonts.js"), "utf8");
    const bundled = [...build.matchAll(/^const SYMBOLS(?:_MATH)? = chars\(([\s\S]*?)^\);/gm)].flatMap((list) =>
      [...list[1]!.matchAll(/^\s*0x([0-9a-f]+),/gm)].map((cp) => String.fromCodePoint(Number.parseInt(cp[1]!, 16))),
    );
    assert.ok(bundled.length > 0, "found no SYMBOLS or SYMBOLS_MATH list in build-fonts.js");
    const rendered = glyphs(semantics);
    const unused = bundled.filter((glyph) => !rendered.has(glyph));
    assert.deepEqual(
      unused,
      [],
      `build-fonts.js subsets ${unused.join(" ")} into a symbol face, and semantics.json renders none of them. ` +
        `Take them out and rerun pnpm run design:fonts.`,
    );
  });
});

describe("object kind glyphs", () => {
  interface Kind {
    prefix?: string;
    word?: string;
    glyph?: string;
  }
  const semantics = JSON.parse(read("semantics.json")) as Record<string, unknown> & {
    objectKind?: Record<string, Kind>;
    surface?: Record<string, { glyph?: string }>;
  };
  const kinds = semantics.objectKind ?? {};

  /* A kind glyph may be a surface's only where the two mean the same thing on purpose: the
     run's ☰ is the Runs rail's and the work item's ⬡ is the Plan rail's, the way Attention's
     ◆ is the waiting status's. Any other overlap is a glyph saying two things. */
  const SHARED_WITH_SURFACE: Readonly<Record<string, string>> = { run: "runs", workItem: "plan" };

  /** Every glyph in semantics.json outside `objectKind`, by the domain that gives it a word. */
  const elsewhere = (): Map<string, string[]> => {
    const found = new Map<string, string[]>();
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.glyph === "string") found.set(record.glyph, [...(found.get(record.glyph) ?? []), path]);
      for (const [key, value] of Object.entries(record)) walk(value, path === "" ? key : `${path}.${key}`);
    };
    for (const [domain, value] of Object.entries(semantics)) if (domain !== "objectKind") walk(value, domain);
    return found;
  };

  test("semantics.json declares each kind with its id prefix, a word and one glyph", () => {
    assert.ok(Object.keys(kinds).length > 0, "semantics.json has no `objectKind` map: an id token has no glyph");
    for (const [kind, presentation] of Object.entries(kinds)) {
      assert.match(presentation.prefix ?? "", /^[a-z]+$/, `object kind ${kind} has no id prefix`);
      assert.ok(presentation.word, `object kind ${kind} has no word — it is the token's accessible name`);
      assert.equal([...(presentation.glyph ?? "")].length, 1, `object kind ${kind}'s glyph must be one character`);
    }
    const prefixes = Object.values(kinds).map((k) => k.prefix);
    assert.equal(new Set(prefixes).size, prefixes.length, `two kinds claim one prefix: ${prefixes.join(" ")}`);
  });

  /* Six kinds told apart by shape in front of a six-character tail. Two sharing a glyph
     would make "☰ 7X8P8P" ambiguous in exactly the way the token exists to prevent. */
  test("no two kinds share a glyph", () => {
    const glyphs = Object.values(kinds).map((k) => k.glyph);
    assert.equal(new Set(glyphs).size, glyphs.length, `two kinds share a glyph: ${glyphs.join(" ")}`);
  });

  test("a kind glyph is never a status, and is a surface's only where that is the point", () => {
    const others = elsewhere();
    for (const [kind, presentation] of Object.entries(kinds)) {
      const uses = others.get(presentation.glyph ?? "") ?? [];
      const allowed = SHARED_WITH_SURFACE[kind];
      assert.deepEqual(
        uses,
        allowed === undefined ? [] : [`surface.${allowed}`],
        `object kind ${kind}'s ${presentation.glyph} is also ${uses.join(", ")} — a status glyph is never used for ` +
          `anything that is not that status, and a kind glyph says a kind and nothing else`,
      );
    }
    // And the allowance is not a dead letter: each shared pair really is the same glyph.
    for (const [kind, surface] of Object.entries(SHARED_WITH_SURFACE)) {
      assert.equal(kinds[kind]?.glyph, semantics.surface?.[surface]?.glyph, `${kind} and the ${surface} rail`);
    }
  });

  test("come from a face we bundle", () => {
    const build = readFileSync(join(here, "..", "..", "..", "tools", "font-build", "build-fonts.js"), "utf8");
    for (const [kind, presentation] of Object.entries(kinds)) {
      const cp = `0x${presentation.glyph!.codePointAt(0)!.toString(16)}`;
      assert.ok(build.includes(cp), `object kind ${kind}'s ${presentation.glyph} (${cp}) is not in build-fonts.js`);
    }
  });
});
