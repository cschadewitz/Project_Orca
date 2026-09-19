/**
 * What the type proof surface (`#type`) proves things *about*: `packages/design/tokens.json`
 * itself — the type scale, the faces that are bundled, and the two font stacks.
 *
 * The surface must not carry its own copy of any of that. A proof surface that restates
 * what it is proving proves nothing, and the list it would have to restate is the one most
 * likely to grow. So the styles, the bundled families and the stacks are read from the
 * source of truth, and a style added to `tokens.json` appears on the page with no edit
 * here — `test/type-proof.test.tsx` fails if it ever stops appearing.
 *
 * Two things about the import are deliberate.
 *
 * - `?raw` and `JSON.parse`, rather than a JSON import: the renderer's TypeScript project
 *   does not enable `resolveJsonModule`, and `?raw` is typed as a string by `vite/client`.
 *   Vite inlines the text at build time, so there is no file read at runtime.
 * - A relative path rather than `@orca/design/…`, because the root `vitest.config.ts`
 *   aliases `@orca/design` with a *string*, which is a prefix match: under vitest a subpath
 *   would be rewritten to `…/design/src/index.ts/tokens.json` and fail to resolve. This
 *   package's `vite.config.ts` anchors its aliases and would be fine; the relative path is
 *   the one form both resolve. `test/themes.tsx` reaches the same package's files the same
 *   way, with `readFileSync`.
 */
import tokensJson from "../../../../design/tokens.json?raw";

/** Only the `type` block is read here; the rest of tokens.json is not this page's business. */
interface TypeTokens {
  type: {
    fonts: { family: string; weight: number; style: string }[];
    families: Record<string, string>;
    groups: { name: string; family: string; styles: RawStyle[] }[];
  };
}

interface RawStyle {
  name: string;
  family?: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing?: string;
  fontStyle?: string;
  usage?: string;
}

const tokens = JSON.parse(tokensJson) as TypeTokens;

/** One entry of the type scale: an `orca-text-*` class and the values behind it. */
export interface TypeStyle {
  /** The style name, e.g. `mono-id`. `orca-text-${name}` is the class `Text` sets. */
  name: string;
  /** Which stack it is on — the `sans` / `mono` of `var(--font-sans)`. */
  track: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing?: string;
  fontStyle?: string;
  /** What tokens.json says the style is for. Shown, so the sample can be judged against it. */
  usage?: string;
}

/** `"IBM Plex Sans"` and `IBM Plex Sans` are the same family; the quotes are CSS syntax. */
const unquote = (name: string): string => name.trim().replace(/^["']|["']$/g, "");

/** The families the app ships as woff2 files, in declaration order, deduplicated by weight. */
export const BUNDLED_FAMILIES: readonly string[] = [...new Set(tokens.type.fonts.map((face) => face.family))];

/** `--font-sans`, `--font-mono`: the stacks `type.families` declares, verbatim. */
export const FONT_STACKS: Readonly<Record<string, string>> = tokens.type.families;

/**
 * The same stacks with every bundled family removed — what the app renders on a machine
 * where the woff2 files failed to load, and what the fallback toggle applies.
 *
 * Derived by subtraction rather than written out, so it stays the *declared* fallback
 * (`Segoe UI`, `Ubuntu`, `ui-monospace`, …) in the order `tokens.json` gives it. Writing it
 * out here would make the toggle a comparison against a second opinion rather than against
 * the stack the app really falls back to.
 */
export const FALLBACK_STACKS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FONT_STACKS).map(([name, stack]) => [
    name,
    stack
      .split(",")
      .filter((entry) => !BUNDLED_FAMILIES.includes(unquote(entry)))
      .join(", "),
  ]),
);

/**
 * Every type style in the scale, in the order tokens.json declares them — the Interface
 * group first, then Machine. A style's own `family` wins over its group's, which is how the
 * generator resolves it too.
 */
export const TYPE_STYLES: readonly TypeStyle[] = tokens.type.groups.flatMap((group) =>
  group.styles.map((style) => ({
    name: style.name,
    track: style.family ?? group.family,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    fontWeight: style.fontWeight,
    ...(style.letterSpacing === undefined ? {} : { letterSpacing: style.letterSpacing }),
    ...(style.fontStyle === undefined ? {} : { fontStyle: style.fontStyle }),
    ...(style.usage === undefined ? {} : { usage: style.usage }),
  })),
);

/** `mono · 13px/20px · 500 · 0.06em` — the metrics beside a sample. */
export const metrics = (style: TypeStyle): string =>
  [style.track, `${style.fontSize}/${style.lineHeight}`, String(style.fontWeight), style.letterSpacing, style.fontStyle]
    .filter(Boolean)
    .join(" · ");
