// The `changelog.d/` news-fragment scheme: reading a directory of fragments and rendering
// them into the body of a CHANGELOG section. tools/release.js is the command line over
// this; keeping the rendering here gives it a test of its own (tools/test/changelog.test.js).
//
// A fragment is one file named `<issue>-<slug>.<section>.md`, holding its entry verbatim —
// the bullet(s) with their area prefix, or prose for `store`. One file per entry is the
// whole point: two pull requests in flight never edit the same region of the same file,
// which is what `## Unreleased` made them do (#216).
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const FRAGMENT_DIR = "changelog.d";

/**
 * The sections a release renders, in order. The key is the filename suffix; the heading is
 * what lands in CHANGELOG.md. `store` is special twice over: it always renders — every
 * release states whether the on-disk format moved, saying "No change." when it did not
 * (docs/RELEASING.md) — and its fragments are prose rather than bullets.
 */
export const SECTIONS = [
  { key: "store", heading: "Store format" },
  { key: "added", heading: "Added" },
  { key: "changed", heading: "Changed" },
  { key: "fixed", heading: "Fixed" },
];

const NO_STORE_CHANGE = "No change.";

const isBullet = (line) => /^\s*[-*] /.test(line);
/** True when `lines` ends inside a list — a bullet, or an indented continuation of one. */
const endsInList = (lines) => /^\s*[-*] |^\s+\S/.test(lines[lines.length - 1] ?? "");

const trimBlankEdges = (lines) => {
  const out = [...lines];
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
};

/**
 * Reads the fragments, in the order they render: by filename, numerically, so `#99` comes
 * before `#101` rather than after it. A name that does not end in a known section is a
 * typo worth failing on — silently dropping an entry is exactly the bookkeeping loss this
 * scheme exists to prevent. `README.md` documents the directory and is not a fragment.
 */
export function readFragments(dir = FRAGMENT_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => {
      const section = /\.([^.]+)\.md$/.exec(name)?.[1];
      if (!SECTIONS.some((s) => s.key === section)) {
        throw new Error(
          `${join(dir, name)}: a fragment is named <issue>-<slug>.<section>.md, where <section> is one of ` +
            `${SECTIONS.map((s) => s.key).join(", ")}`,
        );
      }
      const body = trimBlankEdges(readFileSync(join(dir, name), "utf8").split("\n"));
      if (!body.length) throw new Error(`${join(dir, name)}: empty fragment`);
      return { name, section, body };
    });
}

/**
 * Joins the bodies of one section. Two bullet lists run together with no blank line
 * between them — a blank line there makes the list "loose" and Markdown renders it with
 * extra spacing, so fragments would look different from a hand-written list. Prose gets
 * the blank line it needs.
 */
function joinBodies(bodies) {
  const out = [];
  for (const body of bodies) {
    if (out.length && !(endsInList(out) && isBullet(body[0]))) out.push("");
    out.push(...body);
  }
  return out;
}

/**
 * The lines of a release section's body: `### Store format` first, then the other sections
 * in order, each omitted when no fragment carries it. The output is what `tidy()` in
 * tools/release.js produced from a hand-written `## Unreleased` — no leading or trailing
 * blank line, one blank line between subsections.
 */
export function renderEntries(fragments) {
  const out = [];
  for (const { key, heading } of SECTIONS) {
    const bodies = fragments.filter((f) => f.section === key).map((f) => f.body);
    if (!bodies.length && key !== "store") continue;
    if (out.length) out.push("");
    out.push(`### ${heading}`, "", ...joinBodies(bodies.length ? bodies : [[NO_STORE_CHANGE]]));
  }
  return out;
}

/** Removes the rendered fragments; the release commit carries the deletions. */
export function deleteFragments(fragments, dir = FRAGMENT_DIR) {
  for (const { name } of fragments) rmSync(join(dir, name));
}
