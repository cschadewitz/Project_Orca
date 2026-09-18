// Renders coverage/coverage-summary.json as a markdown table, per package plus a total.
// CI appends it to $GITHUB_STEP_SUMMARY so a PR shows its coverage without downloading
// the HTML report; run it by hand after `pnpm run test:coverage` to see the same thing.
//
// Usage: node tools/coverage-summary.js [path/to/coverage-summary.json]
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const file = process.argv[2] ?? "coverage/coverage-summary.json";
const root = process.cwd();

/** @type {Record<string, Record<string, { total: number; covered: number; pct: number }>>} */
let summary;
try {
  summary = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`coverage summary not found at ${file} - run \`pnpm run test:coverage\` first (${String(e)})`);
  process.exit(1);
}

const METRICS = ["statements", "branches", "functions", "lines"];
const empty = () => Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }]));

// packages/<name>/src/... -> <name>; anything else is grouped under its first path segment.
const groups = new Map();
for (const [path, entry] of Object.entries(summary)) {
  if (path === "total") continue;
  const parts = relative(root, path).split("/");
  const name = parts[0] === "packages" ? parts[1] : parts[0];
  const group = groups.get(name) ?? empty();
  for (const m of METRICS) {
    group[m].total += entry[m].total;
    group[m].covered += entry[m].covered;
  }
  groups.set(name, group);
}

const pct = (m) => (m.total === 0 ? "-" : `${((m.covered / m.total) * 100).toFixed(1)}%`);
const row = (name, g) => `| ${name} | ${METRICS.map((m) => pct(g[m])).join(" | ")} |`;

const lines = [
  "### Coverage",
  "",
  `| package | ${METRICS.join(" | ")} |`,
  `| --- | ${METRICS.map(() => "---:").join(" | ")} |`,
  ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, g]) => row(name, g)),
  row("**total**", summary.total),
  "",
];
console.log(lines.join("\n"));
