#!/usr/bin/env node
/**
 * ORCA design system — font build.
 *
 *   pnpm run design:fonts
 *
 * Subsets the upstream releases into the woff2 files the app bundles, and copies the
 * licences beside them. Outputs land in `packages/design/fonts/` and are committed: this
 * script is run by hand when a face, a weight or a glyph changes, not on every install.
 *
 * Two families are bundled, for two different reasons.
 *
 *   IBM Plex Sans / IBM Plex Mono  the interface and machine tracks (docs/design/RULES.md 8),
 *                                  subset to Latin plus the punctuation and arrows the UI
 *                                  uses, plus box drawing for mono (the stream rules).
 *   Noto Sans Symbols 2 / Math     the status glyphs. Plex ships none of ◐ ◆ ✕ ⊘ ▣ ⏸ ◷ ●,
 *                                  so without a bundled symbol face every status glyph falls
 *                                  through to whatever the OS happens to have — a different
 *                                  face per platform, at chip scale, next to the word. These
 *                                  two are subset to exactly the glyphs ORCA renders (no
 *                                  Latin, not even a space), which is why they can sit at the
 *                                  front of the stacks in tokens.json without touching text.
 *
 * Every output is verified to cover the codepoints claimed for it before it is written.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import subsetFont from "subset-font";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "packages", "design", "fonts");

/* ---------- coverage ---------- */

const range = (lo, hi = lo) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const chars = (...cps) => cps.flat().map((cp) => String.fromCodePoint(cp));

/** Latin-1 plus the typographic punctuation and arrows the interface sets. */
const TEXT = chars(
  range(0x20, 0x7e),
  range(0xa0, 0xff),
  0x0131, // dotless i
  range(0x0152, 0x0153), // Œ œ
  0x02c6,
  0x02da,
  0x02dc,
  range(0x2013, 0x2014), // en dash, em dash
  range(0x2018, 0x201a),
  range(0x201c, 0x201e),
  range(0x2020, 0x2022), // dagger, double dagger, bullet — the status bar separator
  0x2026, // ellipsis — truncation, "Connecting…"
  0x2030,
  range(0x2039, 0x203a),
  0x2044,
  0x20ac,
  0x2122,
  range(0x2190, 0x2193), // arrows: keyboard hints, diff gutters
  0x2212, // minus
  range(0x2264, 0x2265),
  range(0xfb01, 0xfb02), // fi fl
);

/** Box drawing, for the stream rules and the tree guides. Mono only. */
const BOX = chars(range(0x2500, 0x257f));

/**
 * The glyphs ORCA renders as glyphs: the eight run statuses, the connection states, agent
 * health, the breadcrumb separator, the command key, the surfaces and the object kinds.
 * Kept in sync with packages/design/semantics.json by the check below, and the other way —
 * nothing here that semantics.json no longer renders — by packages/design/test/fonts.test.ts.
 *
 * Four glyphs carry a word in more than one domain, which is deliberate rather than an
 * oversight: a domain gives the glyph its word, and the same shape meaning "settled" or
 * "gone quiet" in two places reads as one vocabulary rather than two. Each comment below
 * names every use, so a reader does not take one of them for a mistake.
 */
const SYMBOLS = chars(
  0x25d0, // ◐ running
  0x25c6, // ◆ waiting
  0x2713, // ✓ succeeded · agent health ok
  0x2715, // ✕ failed · agent health down
  0x25a3, // ▣ blocked
  0x23f8, // ⏸ held
  0x25f7, // ◷ stale / disconnected · agent health degraded
  0x25cf, // ● connected
  0x25cc, // ◌ reconnecting · empty and no-results state views · agent health unknown
  0x25b8, // ▸ breadcrumb separator
  0x2318, // ⌘ command key, in palette and menu hints
  /* The five surfaces, for the rail the sidebar collapses to below 960px (#261). ◆ above is
     Attention's as well as waiting's, deliberately; these four are the rest. A cog would be
     the obvious fifth and there is no OFL cog here to bundle — U+2699 is in neither Noto
     face — which is why Config is radial rather than toothed. */
  0x2630, // ☰ surface runs · object kind run
  0x2b21, // ⬡ surface plan · object kind work item
  0x2442, // ⑂ surface workflows
  0x25c9, // ◉ surface agents
  0x274b, // ❋ surface config
  0x2750, // ❐ surface machines (#882): one screen in front of others
  /* The object kinds an id token leads with (semantics.json `objectKind`). ☰ and ⬡ above
     are the run's and the work item's, reused from the rail on purpose; these are the rest,
     and the gate's ⊓ is in the Math face below. None of them is a status glyph. */
  0x275d, // ❝ object kind request
  0x25eb, // ◫ object kind step — not ▭ U+25AD, which reads as a dash at mono-id size
  0x2726, // ✦ object kind event
);

/** Not in Noto Sans Symbols 2; Noto Sans Math carries them. */
const SYMBOLS_MATH = chars(
  0x2298, // ⊘ cancelled
  0x2293, // ⊓ object kind gate
);

/* ---------- what to build ---------- */

const plexSans = (f) => require.resolve(`@ibm/plex-sans/fonts/complete/woff2/${f}.woff2`);
const plexMono = (f) => require.resolve(`@ibm/plex-mono/fonts/complete/woff2/${f}.woff2`);
const fontsource = (pkg, f) => require.resolve(`@fontsource/${pkg}/files/${f}.woff2`);

const FACES = [
  { out: "IBMPlexSans-Regular.woff2", src: plexSans("IBMPlexSans-Regular"), cover: TEXT },
  { out: "IBMPlexSans-Italic.woff2", src: plexSans("IBMPlexSans-Italic"), cover: TEXT },
  { out: "IBMPlexSans-Medium.woff2", src: plexSans("IBMPlexSans-Medium"), cover: TEXT },
  { out: "IBMPlexSans-SemiBold.woff2", src: plexSans("IBMPlexSans-SemiBold"), cover: TEXT },
  { out: "IBMPlexMono-Regular.woff2", src: plexMono("IBMPlexMono-Regular"), cover: [...TEXT, ...BOX] },
  { out: "IBMPlexMono-Medium.woff2", src: plexMono("IBMPlexMono-Medium"), cover: [...TEXT, ...BOX] },
  {
    out: "NotoSansSymbols2-Regular.woff2",
    src: fontsource("noto-sans-symbols-2", "noto-sans-symbols-2-symbols-400-normal"),
    cover: SYMBOLS,
    symbolsOnly: true,
  },
  {
    out: "NotoSansMath-Regular.woff2",
    src: fontsource("noto-sans-math", "noto-sans-math-latin-400-normal"),
    cover: SYMBOLS_MATH,
    symbolsOnly: true,
  },
];

const LICENCES = [
  ["LICENSE-IBM-Plex.txt", require.resolve("@ibm/plex-sans/LICENSE.txt")],
  ["LICENSE-Noto.txt", require.resolve("@fontsource/noto-sans-symbols-2/LICENSE")],
];

/* ---------- build ---------- */

const hex = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

function missing(buffer, cover) {
  const font = fontkit.create(buffer);
  return cover.filter((c) => !font.hasGlyphForCodePoint(c.codePointAt(0)));
}

function assertGlyphsMatchSemantics() {
  const semantics = JSON.parse(readFileSync(join(here, "..", "..", "packages", "design", "semantics.json"), "utf8"));
  const used = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.glyph === "string") used.add(node.glyph);
    for (const v of Object.values(node)) walk(v);
  };
  walk(semantics);
  const bundled = new Set([...SYMBOLS, ...SYMBOLS_MATH]);
  const orphans = [...used].filter((g) => !bundled.has(g));
  if (orphans.length) {
    throw new Error(
      `semantics.json renders ${orphans.map((g) => `${g} (${hex(g)})`).join(", ")}, which this ` +
        `script does not bundle. Add them to SYMBOLS (or SYMBOLS_MATH) and rebuild, or they ` +
        `will fall back to a different face per platform.`,
    );
  }
}

assertGlyphsMatchSemantics();
mkdirSync(OUT, { recursive: true });

for (const face of FACES) {
  const source = readFileSync(face.src);
  const gaps = missing(source, face.cover);
  if (gaps.length) {
    throw new Error(`${face.src} does not contain ${gaps.map((c) => `${c} ${hex(c)}`).join(", ")}`);
  }

  const subset = await subsetFont(source, face.cover.join(""), { targetFormat: "woff2" });
  const stillGaps = missing(subset, face.cover);
  if (stillGaps.length) {
    throw new Error(`${face.out} lost ${stillGaps.map((c) => `${c} ${hex(c)}`).join(", ")} in subsetting`);
  }
  /* A symbol face sits in front of Plex in the stacks, so it must not claim any text. */
  if (face.symbolsOnly) {
    const leaked = [...TEXT, ...BOX].filter((c) => !missing(subset, [c]).length);
    if (leaked.length) {
      throw new Error(`${face.out} covers text codepoints (${leaked.map(hex).join(", ")}) and would hijack them`);
    }
  }

  writeFileSync(join(OUT, face.out), subset);
  console.log(`${face.out}  ${(subset.length / 1024).toFixed(1)} kB  (${face.cover.length} codepoints)`);
}

for (const [out, src] of LICENCES) {
  writeFileSync(join(OUT, out), readFileSync(src));
  console.log(out);
}
