/**
 * The type and glyph proof surface — `#type` in a dev build (#194).
 *
 * #144 bundled the faces and proved, in `tools/font-build/build-fonts.js`, that every
 * declared file contains every codepoint claimed for it. The half a build script cannot
 * answer is whether the glyphs look right *next to the words*, at chip scale, in both
 * themes: a glyph that falls through to the OS still renders, just in another typeface, and
 * nobody notices it on the machine that happens to have that typeface installed. This page
 * is somewhere to look.
 *
 * Three rules it lives by.
 *
 * - **Nothing here is re-declared.** The type scale, the bundled families and the two font
 *   stacks are read out of `packages/design/tokens.json` (`type-sources.ts`); the statuses,
 *   connection states and their glyphs come from `@orca/design`'s presentation maps. A
 *   proof surface that carries its own copy of the thing it is proving proves nothing —
 *   and `test/type-proof.test.tsx` fails if the page stops covering all of them.
 * - **Both themes at once**, as `data-theme` subtrees, the same way `#preview` does it.
 * - **The fallback toggle is the point.** It rewrites `--font-sans` and `--font-mono` on
 *   this subtree to the same stacks minus every bundled family, which is exactly what a
 *   machine where the woff2 files failed to load would render. Flip it: anything that does
 *   not change was never coming from a bundled face.
 *
 * Dev-only. `routes.tsx` imports it under `import.meta.env.DEV`, so neither the branch nor
 * its dynamic import reaches a production bundle.
 */
import { useState, type CSSProperties, type JSX, type ReactNode } from "react";
import {
  CHROME_GLYPHS,
  CONNECTION_PRESENTATION,
  RUN_STATUSES,
  STATE_VIEW_PRESENTATION,
  STATUS_PRESENTATION,
  THEMES,
  type ConnectionState,
  type TextStyle,
  type ThemeId,
} from "@orca/design";
import { Button, ConnectionIndicator, StatusChip, Text, Well } from "../ui/index.js";
import { BUNDLED_FAMILIES, FALLBACK_STACKS, TYPE_STYLES, metrics, type TypeStyle } from "./type-sources.js";
import "./type-proof.css";

/* Derived, never re-declared: the design system owns the list of states. */
const CONNECTION_STATES = Object.keys(CONNECTION_PRESENTATION) as ConnectionState[];

/* A fixed instant, so the two theme columns render identical text. */
const LAST_EVENT = new Date(Date.now() - 6 * 60 * 1000);

export function TypeProof(): JSX.Element {
  const [fallback, setFallback] = useState(false);

  /* Custom properties, not a class: the values are derived from tokens.json, so there is
     nothing for a stylesheet to name. They inherit, so every descendant of this element —
     both theme columns — switches together. */
  const faces = fallback
    ? ({ "--font-sans": FALLBACK_STACKS.sans, "--font-mono": FALLBACK_STACKS.mono } as CSSProperties)
    : {};

  return (
    <div className="type-proof" data-faces={fallback ? "fallback" : "bundled"} style={faces}>
      <header className="type-proof__head">
        <Text style="title" as="h1">
          Type and glyphs
        </Text>
        <Text style="caption">
          Every style in tokens.json, every glyph in semantics.json, both themes. Primitives are at{" "}
          <a className="type-proof__link" href="#preview">
            #preview
          </a>
          .
        </Text>
        <div className="type-proof__toggle">
          <Button
            tone={fallback ? "primary" : "default"}
            aria-pressed={fallback}
            onClick={() => setFallback(!fallback)}
          >
            {fallback ? "Bundled faces off" : "Bundled faces on"}
          </Button>
          <Text style="caption">
            {fallback
              ? `Rendering without ${BUNDLED_FAMILIES.join(", ")}. Anything that did not change was never coming from a bundled face.`
              : `Bundled: ${BUNDLED_FAMILIES.join(", ")}.`}
          </Text>
        </div>
      </header>
      <div className="type-proof__themes">
        {THEMES.map((theme) => (
          <ThemeColumn key={theme} theme={theme} />
        ))}
      </div>
    </div>
  );
}

export default TypeProof;

function ThemeColumn({ theme }: { theme: ThemeId }): JSX.Element {
  return (
    <section className="type-proof__theme orca-surface" data-theme={theme} aria-label={`${theme} theme`}>
      <Text style="eyebrow">{theme}</Text>

      <Section title="The scale" note="Sample, then the metrics the class actually sets.">
        <div className="type-proof__scale">
          {TYPE_STYLES.map((style) => (
            <ScaleRow key={style.name} style={style} />
          ))}
        </div>
      </Section>

      <Section
        title="mono-id tracking"
        note="Two ids per row, aligned. The tracking is there so a one-character difference is findable by eye."
      >
        <div className="type-proof__ids">
          {ID_PAIRS.map(([left, right]) => (
            <div className="type-proof__id-row" key={left}>
              <Text style="mono-id">{left}</Text>
              <Text style="mono-id">{right}</Text>
            </div>
          ))}
        </div>
      </Section>

      <Section title="mono-log stream" note="Box drawing (U+2500–257F) is bundled in Plex Mono for exactly this.">
        <Well label="Streamed output" style="mono-log">
          {STREAM}
        </Well>
      </Section>

      <Section title="Run statuses" note="Glyph and word, then glyph alone at chip scale.">
        <div className="type-proof__row">
          {RUN_STATUSES.map((status) => (
            <StatusChip key={status} status={status} />
          ))}
        </div>
        <div className="type-proof__row">
          {RUN_STATUSES.map((status) => (
            <StatusChip key={status} status={status} glyphOnly />
          ))}
        </div>
      </Section>

      <Section title="Connection states" note="As the status bar draws them.">
        <div className="type-proof__stack">
          {CONNECTION_STATES.map((state) => (
            <ConnectionIndicator
              key={state}
              state={state}
              since={LAST_EVENT}
              eventCursor={4821}
              versions={{ app: "0.2.0", daemon: "0.3.0" }}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Every declared glyph"
        note="Large, then at the 11px the chip sets, in sans and in mono. Plex carries none of these."
      >
        <div className="type-proof__glyphs">
          {GLYPHS.map((entry) => (
            <div className="type-proof__glyph" key={entry.glyph}>
              <span className="type-proof__glyph-large orca-text-display" aria-hidden="true">
                {entry.glyph}
              </span>
              <span className="type-proof__glyph-small" aria-hidden="true">
                <span className="orca-text-caption">{entry.glyph} sans</span>
                <span className="orca-text-mono-log">{entry.glyph} mono</span>
              </span>
              <Text style="mono-id">{codepoint(entry.glyph)}</Text>
              <Text style="caption">{entry.names.join(", ")}</Text>
            </div>
          ))}
        </div>
      </Section>
    </section>
  );
}

function ScaleRow({ style }: { style: TypeStyle }): JSX.Element {
  return (
    <div className="type-proof__scale-row" data-style={style.name}>
      {/* The names are read out of tokens.json, so they are plain strings at compile time.
          The cast asserts what the generator guarantees — every style in tokens.json is a
          `TextStyle` and has an `orca-text-*` class — and the test checks the two lists
          against each other rather than trusting the cast. */}
      <Text style={style.name as TextStyle}>{sample(style.name)}</Text>
      <Text style="caption" className="type-proof__meta">
        {style.name} — {metrics(style)}
        {style.usage === undefined ? "" : ` — ${style.usage}`}
      </Text>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="type-proof__section">
      <Text style="heading" as="h2">
        {title}
      </Text>
      {note !== undefined && (
        <Text style="caption" as="p">
          {note}
        </Text>
      )}
      {children}
    </section>
  );
}

/**
 * Sample text per style — real ORCA strings, because the question is how a glyph sits
 * beside the words it will actually sit beside. A style with no entry still renders, with
 * a sample carrying the letterforms that go wrong first; that is deliberate, so a style
 * added to `tokens.json` appears here without an edit.
 */
const SAMPLES: Record<string, string> = {
  display: "No runs yet",
  title: "Roll out SSO to the admin console",
  heading: "Attention",
  body: "The migration ran twice; the second attempt succeeded and the first was cancelled.",
  "body-strong": "Ship the migration behind a flag, or hold for review?",
  label: "Started 14:02:31 · attempt 2 of 3",
  "label-strong": "Work item",
  caption: "6m ago · daemon 0.3.0 · event 148,392",
  eyebrow: "ATTENTION",
  "mono-body": "workflows/release.yaml:42 · steps.build.agent",
  "mono-strong": "npm run build",
  "mono-log": "› vitest run — 1 failed, 214 passed in 4.2s",
  "mono-id": "7f3a2c9e · 2026-09-19T14:02:31Z",
};

const FALLBACK_SAMPLE = "Sample 0O1lI · illegible? — “quoted”, 1,234 · 5.6s";

const sample = (name: string): string => SAMPLES[name] ?? FALLBACK_SAMPLE;

/**
 * Pairs a person would have to tell apart in a run list: ids differing in one character,
 * and the letterforms that carry the difference. `mono-id` is tracked out for this.
 */
const ID_PAIRS: readonly (readonly [string, string])[] = [
  ["7f3a2c9e", "7f3a2c9c"],
  ["b41d0e77", "b41d0e71"],
  ["run_01J8Z4KQ", "run_01J8Z4K0"],
  ["0O 1lI 8B 5S", "O0 Il1 B8 S5"],
];

/**
 * A stream excerpt using the rules the output pane draws: the box-drawing frame and tree
 * guides, the `── reconnected ──` seam from docs/design/40-connection-states.md, and two
 * status glyphs inline in mono — which is where a symbol face that did not lead the mono
 * stack would show itself.
 *
 * The frame is *counted*, not hand-padded: every line is exactly `FRAME` characters wide.
 * So if the corners do not sit above the verticals on screen, the box-drawing glyphs are
 * not on the same advance width as the Latin ones, which is the failure this section is
 * here to catch. A hand-drawn box would leave it unclear whether the page or the font was
 * wrong.
 */
const FRAME = 56;
const top = (title: string): string => `┌─ ${title} ${"─".repeat(FRAME - title.length - 4)}┐`;
const middle = (text: string): string => `│ ${text.padEnd(FRAME - 4)} │`;
const bottom = `└${"─".repeat(FRAME - 2)}┘`;

const STREAM = `${top("build · attempt 2 of 3")}
${middle("npm run build")}
${bottom}
├─ tsc --build                    ✓ ok         1.8s
├─ vite build                     ✓ ok         2.1s
└─ vitest run                     ✕ failed     4.2s
   │
   ├─ packages/app/renderer/test/themes.test.tsx
   │    ✕ status chips bind to their status token
   └─ 1 failed, 214 passed
◷ paused — reconnecting
── reconnected 14:07:22 ──
› 412 new lines… ↓`;

/** Every glyph the design system declares, with what declares it. Nothing is written twice. */
interface GlyphUse {
  glyph: string;
  names: string[];
}

const GLYPHS: readonly GlyphUse[] = (() => {
  const found = new Map<string, string[]>();
  const add = (glyph: string | undefined, name: string): void => {
    if (glyph === undefined) return;
    const names = found.get(glyph);
    if (names) names.push(name);
    else found.set(glyph, [name]);
  };

  for (const [status, presentation] of Object.entries(STATUS_PRESENTATION)) add(presentation.glyph, `status ${status}`);
  for (const [state, presentation] of Object.entries(CONNECTION_PRESENTATION)) add(presentation.glyph, state);
  for (const [kind, presentation] of Object.entries(STATE_VIEW_PRESENTATION)) add(presentation.glyph, `${kind} view`);
  for (const [name, glyph] of Object.entries(CHROME_GLYPHS)) add(glyph, name);

  return [...found].map(([glyph, names]) => ({ glyph, names }));
})();

/** `U+25D0`, so a reviewer can say which glyph rendered wrong without describing it. */
const codepoint = (glyph: string): string =>
  `U+${(glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
