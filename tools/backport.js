// Backport pull requests from a label (docs/RELEASING.md, "Release lines"). A pull request
// merged into `main` with one or more `backport:X.Y` labels gets, for each, a cherry-pick of
// its merge commit into a pull request against `release/X.Y`. That pull request is then held to
// the release line guard like any other: it names the issues the original fixed, which must be
// in that line's milestone.
//
// Usage (in .github/workflows/backport.yml; offline, no dependencies):
//   node tools/backport.js lines <event.json>          -> one `X.Y` per backport label, sorted
//   node tools/backport.js body <event.json> <X.Y>     -> the backport pull request's description
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { referencedIssues } from "./release-line-guard.js";

export const LABEL = /^backport:(\d+)\.(\d+)$/;

/** The lines a pull request's labels ask for: `backport:0.9` -> "0.9"; sorted, once each. */
export function backportLines(labels) {
  const lines = new Set();
  for (const label of labels ?? []) {
    const m = LABEL.exec(typeof label === "string" ? label : (label?.name ?? ""));
    if (m) lines.add(`${Number(m[1])}.${Number(m[2])}`);
  }
  return [...lines].sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    return x[0] - y[0] || x[1] - y[1];
  });
}

/**
 * The backport's description: `Backport of #PR`, then every issue the original named with a
 * linking keyword as `Fixes #N` (what the release line guard reads), then the original title.
 */
export function backportBody(pr, line) {
  const issues = referencedIssues(pr.body).filter((n) => n !== pr.number);
  return [
    `Backport of #${pr.number} to \`release/${line}\`, opened by the backport workflow from its \`backport:${line}\` label.`,
    "",
    ...issues.map((n) => `Fixes #${n}`),
    ...(issues.length ? [""] : []),
    `Original: ${pr.title}`,
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, eventPath, line] = process.argv.slice(2);
  const pr = JSON.parse(readFileSync(eventPath, "utf8")).pull_request;
  if (command === "lines") {
    for (const l of backportLines(pr.labels)) console.log(l);
  } else if (command === "body" && /^\d+\.\d+$/.test(line ?? "")) {
    console.log(backportBody(pr, line));
  } else {
    console.error("usage: node tools/backport.js lines <event.json> | body <event.json> <X.Y>");
    process.exit(1);
  }
}
