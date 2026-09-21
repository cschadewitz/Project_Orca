// The `changelog.d/` news-fragment scheme: reading a directory of fragments and rendering
// them into the body of a CHANGELOG section. tools/release.js is the command line over
// this; keeping the rendering here gives it a test of its own (tools/test/changelog.test.js).
//
// A fragment is one file named `<issue>-<slug>.<section>.md`, holding its entry verbatim —
// the bullet(s) with their area prefix, or prose for `store`. One file per entry is the
// whole point: two pull requests in flight never edit the same region of the same file,
// which is what `## Unreleased` made them do (#216).
//
// A release section is grouped twice: by change type, which is the fragment's `<section>`
// and renders as `### Added`; and within that by change target, which is the bullet's own
// area prefix and renders as `#### app`. A wave-sized release is fifty bullets under four
// headings otherwise, and the question someone upgrading actually asks — "what moved in
// the part I use?" — has no heading to answer it.
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
/** A bullet at the left margin — the start of an entry, rather than a nested one inside it. */
const isTopBullet = (line) => /^[-*] /.test(line);
/** True when `lines` ends inside a list — a bullet, or an indented continuation of one. */
const endsInList = (lines) => /^\s*[-*] |^\s+\S/.test(lines[lines.length - 1] ?? "");

/** `- **protocol/daemon:** the control methods…` — the marker, the target, and the rest. */
const TARGET_PREFIX = /^([-*] )\*\*([^*]+?):\*\*[ \t]*(.*)$/;

const trimBlankEdges = (lines) => {
  const out = [...lines];
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
};

/**
 * Splits a fragment body into the entries it holds, one per top-level bullet, each carrying
 * the change target its `**area:**` prefix names. A fragment is allowed more than one bullet
 * and they need not share a target — #160 is one pull request that moved `protocol/daemon`,
 * `cli` and `cli/daemon` — so the split is per bullet rather than per file. Lines below a
 * bullet (wrapped prose, nested lists, fenced code) belong to it; anything before the first
 * bullet is prose, which `store` fragments are made of, and carries no target.
 *
 * The prefix is removed from a bullet that has one, because the `#### app` heading it renders
 * under now says it. Everything else is copied through untouched, which is the promise
 * `changelog.d/README.md` makes about fragment text.
 */
export function splitEntries(body) {
  const entries = [];
  for (const line of body) {
    if (isTopBullet(line) || !entries.length) entries.push({ target: null, lines: [] });
    const entry = entries[entries.length - 1];
    const prefix = entry.lines.length === 0 && isTopBullet(line) ? TARGET_PREFIX.exec(line) : null;
    // A bullet that is nothing but its prefix keeps it: stripping would leave a bare marker
    // whose text starts on the next line, which reads worse than the redundancy.
    if (prefix && prefix[3].trim() !== "") {
      entry.target = prefix[2];
      entry.lines.push(prefix[1] + prefix[3]);
    } else {
      entry.lines.push(line);
    }
  }
  return entries.map((entry) => ({ ...entry, lines: trimBlankEdges(entry.lines) })).filter((e) => e.lines.length);
}

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
 * The body of one section, grouped by change target. Entries with no target — prose, and the
 * occasional bullet written without a prefix — come first, directly under the section
 * heading, so a `store` section of pure prose renders exactly as it always has. The targets
 * that follow are alphabetical: the alternative, ordering them by the lowest issue number in
 * each, is a sort nobody reading the file can see, and a release's targets change from one
 * release to the next. Within a group, entries keep their issue order.
 */
function renderSection(fragments) {
  const entries = fragments.flatMap((f) => splitEntries(f.body));
  const out = [];
  const bodiesFor = (target) => entries.filter((e) => e.target === target).map((e) => e.lines);

  const untargeted = bodiesFor(null);
  if (untargeted.length) out.push(...joinBodies(untargeted));

  const targets = [...new Set(entries.map((e) => e.target).filter(Boolean))];
  targets.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const target of targets) {
    if (out.length) out.push("");
    out.push(`#### ${target}`, "", ...joinBodies(bodiesFor(target)));
  }
  return out;
}

/**
 * The lines of a release section's body: `### Store format` first, then the other sections
 * in order, each omitted when no fragment carries it, and each grouped by change target
 * inside. The output is what `tidy()` in tools/release.js produced from a hand-written
 * `## Unreleased` — no leading or trailing blank line, one blank line between subsections.
 */
export function renderEntries(fragments) {
  const out = [];
  for (const { key, heading } of SECTIONS) {
    const inSection = fragments.filter((f) => f.section === key);
    if (!inSection.length && key !== "store") continue;
    if (out.length) out.push("");
    out.push(`### ${heading}`, "", ...(inSection.length ? renderSection(inSection) : [NO_STORE_CHANGE]));
  }
  return out;
}

/** Removes the rendered fragments; the release commit carries the deletions. */
export function deleteFragments(fragments, dir = FRAGMENT_DIR) {
  for (const { name } of fragments) rmSync(join(dir, name));
}
