// The body of the `release: vX.Y.Z` pull request that release-prepare.yml opens. It lives
// here rather than inline in the workflow so its size limit can be tested: GitHub refuses
// a pull request body over 65,536 characters, and by the time the body is built the
// release branch is already pushed, so an oversized body would leave a half-done prepare.
//
// Usage (the workflow passes the rest through the environment):
//   node tools/release-pr-body.js <notes-file>
//
// Environment: REPO, NUMBER, VERSION, BUMP, PIN, MILESTONE_TITLE, UNLABELLED, and for a
// final release after a candidate, DRIFT_SINCE (the newest rc tag) and DRIFT_FILE (the
// `git diff --stat` of DRIFT_PATHS since it).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** GitHub's limit is 65,536 characters; keep a margin for anything it adds. */
export const BODY_LIMIT = 65_000;
/** How many unlabelled issues are listed before the rest is summarised as a count. */
export const UNLABELLED_LIMIT = 50;

/** How many `git diff --stat` lines are shown before the rest is summarised as a count. */
export const DRIFT_LIMIT = 40;

/**
 * Everything a release is built from, as git pathspecs: the packages and their manifests,
 * what the CLI ships beside them, and the root build inputs. A dependency bump in a
 * manifest or the lockfile changes the shipped app as surely as a source edit does.
 * release-prepare.yml passes exactly these to `git diff` (tools/test holds it to that).
 */
export const DRIFT_PATHS = [
  "packages/",
  "workflows/",
  "templates/",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/",
  "tsconfig*.json",
  "release-compatibility.json",
];

/** Characters as GitHub counts them (code points), not UTF-16 units. */
const length = (text) => [...text].length;

/**
 * Build the pull request body. When the notes would push it past BODY_LIMIT, link to
 * CHANGELOG.md on the release branch instead of inlining them; the release body itself
 * (a separate, larger limit) still carries the notes verbatim.
 */
export function prBody({ repo, number, version, bump, pin, title, unlabelled, notes, drift }) {
  const lines = [
    `Closing milestone [${title}](https://github.com/${repo}/milestone/${number}) proposes **v${version}**.`,
  ];
  lines.push(
    pin
      ? `Version pinned by the milestone description; the \`release:*\` labels said \`${bump}\`.`
      : `Version derived from the \`release:${bump}\` label on the milestone's issues.`,
  );
  lines.push("");
  const issues = (unlabelled ?? "").split("\n").filter((line) => line.trim() !== "");
  const notesLink = `[\`CHANGELOG.md\` on this branch](https://github.com/${repo}/blob/release/v${version}/CHANGELOG.md)`;
  const intro = (inline) =>
    inline
      ? [
          `Merging this tags \`v${version}\` and publishes the release. Review the notes below first —`,
          "they are the release body verbatim, so edit `CHANGELOG.md` on this branch to change them.",
        ]
      : [
          `Merging this tags \`v${version}\` and publishes the release. Review the notes first: they are`,
          `too long for this description, so read them in ${notesLink}. They are the release body`,
          "verbatim; edit `CHANGELOG.md` on this branch to change them.",
        ];
  const note = [];
  if (issues.length > 0) {
    note.push("", "> [!NOTE]", "> These issues carry no `release:*` label and were counted as `release:none`:");
    for (const issue of issues.slice(0, UNLABELLED_LIMIT)) note.push(`> ${issue}`);
    if (issues.length > UNLABELLED_LIMIT) note.push(`> …and ${issues.length - UNLABELLED_LIMIT} more.`);
  }
  note.push(...driftSection(repo, version, drift));
  const inline = [...lines, ...intro(true), ...note, "", "---", "", notes.replace(/\n+$/, "")].join("\n") + "\n";
  if (length(inline) <= BODY_LIMIT) return inline;
  return [...lines, ...intro(false), ...note].join("\n") + "\n";
}

/**
 * A final release should be its last candidate's code plus fixes someone chose (#863,
 * docs/RELEASING.md). This says what changed in DRIFT_PATHS since that candidate, so
 * anything that merged to main after it is visible before the merge, not after the tag.
 */
function driftSection(repo, version, drift) {
  if (!drift?.since) return [];
  const stat = (drift.stat ?? "").split("\n").filter((line) => line.trim() !== "");
  const compare = `https://github.com/${repo}/compare/${drift.since}...release/v${version}`;
  if (stat.length === 0)
    return [
      "",
      `Nothing the release is built from (packages, their manifests, the lockfile or root build config) changed since \`${drift.since}\`: this is that candidate's code.`,
    ];
  const shown = stat.length > DRIFT_LIMIT ? [...stat.slice(0, DRIFT_LIMIT - 1), stat.at(-1)] : stat;
  return [
    "",
    "> [!WARNING]",
    `> What the release is built from changed since the last candidate, \`${drift.since}\`. A final should be`,
    "> that candidate plus fixes chosen on purpose; check each file below is one of them",
    `> ([full comparison](${compare})).`,
    "",
    "```",
    ...shown.slice(0, -1),
    ...(stat.length > DRIFT_LIMIT ? [`…and ${stat.length - DRIFT_LIMIT} more files`] : []),
    shown.at(-1),
    "```",
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("usage: node tools/release-pr-body.js <notes-file>\n");
    process.exit(2);
  }
  const env = process.env;
  process.stdout.write(
    prBody({
      repo: env.REPO,
      number: env.NUMBER,
      version: env.VERSION,
      bump: env.BUMP,
      pin: env.PIN,
      title: env.MILESTONE_TITLE,
      unlabelled: env.UNLABELLED,
      notes: readFileSync(file, "utf8"),
      drift: env.DRIFT_SINCE
        ? {
            since: env.DRIFT_SINCE,
            stat: env.DRIFT_FILE && existsSync(env.DRIFT_FILE) ? readFileSync(env.DRIFT_FILE, "utf8") : "",
          }
        : undefined,
    }),
  );
}
