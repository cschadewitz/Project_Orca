// Unattended bookkeeping for workstreams (docs/WORKSTREAMS.md, #1239): which milestone a merged
// pull request rides in, and the weekly report of workstreams that went quiet.
//
// Usage (offline; the workflows fetch the inputs with `gh` and pass them as JSON files):
//   node tools/workstreams.js milestone <milestones.json> <lines.json>
//     -> the number of the milestone a pull request merged into main without one rides in:
//        the earliest open minor (`X.Y.0`) whose `release/X.Y` line is not cut yet, or nothing
//   node tools/workstreams.js report <inputs.json>
//     -> the weekly report's Markdown body
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MINOR = /^v?(\d+)\.(\d+)\.0$/;
const DAY = 24 * 60 * 60 * 1000;
export const QUIET_BRANCH_DAYS = 14;
export const QUIET_FLAG_DAYS = 30;

/**
 * The open milestone a merge into main ships in, or undefined when that cannot be established.
 * Main feeds a minor only until its line is cut: once `release/X.Y` exists (cut at rc.1), `X.Y.0`
 * builds from the line and a new main merge rides the next minor instead. So: the earliest open
 * `X.Y.0` whose `release/X.Y` does not exist, and only if every earlier uncut minor is accounted
 * for (an earlier open minor with no line wins). `lines` is the list of existing `release/X.Y`
 * branch names, or undefined when it could not be read, which leaves the milestone unset. Patch
 * milestones (`0.8.1`) ship from their line, not from main, so never.
 */
export function ridingMilestone(milestones, lines) {
  if (!Array.isArray(lines)) return undefined;
  const cut = new Set(lines.map((l) => String(l).replace(/^refs\/heads\//, "")));
  const minors = (milestones ?? [])
    .filter((m) => m.state === "open" && MINOR.test(String(m.title ?? "").trim()))
    .map((m) => {
      const [, major, minor] = MINOR.exec(m.title.trim()).map(Number);
      return { number: m.number, major, minor };
    })
    .sort((a, b) => a.major - b.major || a.minor - b.minor);
  return minors.find((m) => !cut.has(`release/${m.major}.${m.minor}`))?.number;
}

/** Marks the one issue the report workflow manages, so it never edits another. */
export const REPORT_MARKER = "<!-- orca:workstream-report -->";

const age = (now, at) => Math.floor((now - Date.parse(at)) / DAY);

/**
 * The report: feature branches with no commit for QUIET_BRANCH_DAYS, incubating flags whose
 * tracking issue saw no activity for QUIET_FLAG_DAYS, and open sync conflicts.
 * `inputs`: { now, branches: [{ name, committedAt }], flags: [{ name, issue, updatedAt }],
 *   conflicts: [{ number, title }] }.
 */
export function workstreamReport({ now, branches = [], flags = [], conflicts = [] }) {
  const t = Date.parse(now);
  const quietBranches = branches.filter((b) => age(t, b.committedAt) >= QUIET_BRANCH_DAYS);
  const quietFlags = flags.filter((f) => age(t, f.updatedAt) >= QUIET_FLAG_DAYS);
  const lines = [
    REPORT_MARKER,
    `Workstream report for ${now.slice(0, 10)}, written weekly by the Workstream report workflow (docs/WORKSTREAMS.md). Nothing here needs an answer; it is where quiet work shows up.`,
    "",
    `**Feature branches:** ${branches.length}. **Incubating flags:** ${flags.length}.`,
    "",
    `### Feature branches with no commit for ${QUIET_BRANCH_DAYS} days`,
    "",
    ...(quietBranches.length
      ? quietBranches.map((b) => `- \`${b.name}\`: last commit ${age(t, b.committedAt)} days ago`)
      : ["None."]),
    "",
    `### Incubating flags whose tracking issue was quiet for ${QUIET_FLAG_DAYS} days`,
    "",
    ...(quietFlags.length
      ? quietFlags.map((f) => `- \`${f.name}\` (#${f.issue}): last activity ${age(t, f.updatedAt)} days ago`)
      : ["None."]),
    "",
    "### Open sync conflicts",
    "",
    ...(conflicts.length ? conflicts.map((c) => `- #${c.number} ${c.title}`) : ["None."]),
  ];
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  const input = JSON.parse(readFileSync(file, "utf8"));
  if (command === "milestone") {
    const lines = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], "utf8")) : undefined;
    const n = ridingMilestone(input, lines);
    if (n !== undefined) console.log(n);
  } else if (command === "report") {
    console.log(workstreamReport(input));
  } else {
    console.error("usage: node tools/workstreams.js milestone <milestones.json> <lines.json> | report <inputs.json>");
    process.exit(1);
  }
}
