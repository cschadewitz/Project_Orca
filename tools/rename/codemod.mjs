#!/usr/bin/env node
// The mechanical half of the ORCA -> Orrery rename, driven by map.json.
//
//   node tools/rename/codemod.mjs                 report what would change (the default)
//   node tools/rename/codemod.mjs --apply         rewrite files and `git mv` renamed paths
//   node tools/rename/codemod.mjs --only packages/core --only docs/DEVELOPMENT.md
//   node tools/rename/codemod.mjs --json          machine-readable report
//
// It is idempotent: a second run changes nothing. It is never committed piecemeal; the
// nightly preview and the cutover run it over the whole tree (tools/rename/README.md).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isBinaryPath, isExcluded, loadMap, renamePath, renameText } from "./lib.mjs";

// The repository the command runs in, so convert-branch.sh can run a copy taken from main.
const out = (line) => process.stdout.write(`${line}\n`);
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const json = args.includes("--json");
const only = args.flatMap((a, i) => (a === "--only" ? [args[i + 1].replace(/\/$/, "")] : []));

const map = loadMap();
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 })
  .split("\0")
  .filter(Boolean)
  .filter((f) => only.length === 0 || only.some((o) => f === o || f.startsWith(`${o}/`)));

const edits = [];
const moves = [];
for (const file of files) {
  if (isExcluded(map, file)) continue;
  const abs = resolve(root, file);
  if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
  const to = renamePath(map, file);
  if (to !== file) moves.push({ from: file, to });
  if (isBinaryPath(map, file)) continue;
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) continue;
  const before = buf.toString("utf8");
  const { text, count } = renameText(map, before);
  if (count > 0 && text !== before) edits.push({ file, count, text });
}

const clash = moves.filter((m) => existsSync(resolve(root, m.to)) && !moves.some((n) => n.from === m.to));
if (clash.length) {
  console.error(
    `codemod: ${clash.length} renamed path(s) already exist:\n${clash.map((m) => `  ${m.from} -> ${m.to}`).join("\n")}`,
  );
  process.exit(2);
}

if (apply) {
  for (const e of edits) writeFileSync(resolve(root, e.file), e.text);
  for (const m of moves) {
    mkdirSync(dirname(resolve(root, m.to)), { recursive: true });
    execFileSync("git", ["mv", "-k", m.from, m.to], { cwd: root });
  }
}

const total = edits.reduce((n, e) => n + e.count, 0);
if (json) {
  out(
    JSON.stringify(
      { applied: apply, replacements: total, files: edits.map(({ file, count }) => ({ file, count })), moves },
      null,
      2,
    ),
  );
} else {
  for (const e of edits) out(`${String(e.count).padStart(6)}  ${e.file}`);
  for (const m of moves) out(`  move  ${m.from} -> ${m.to}`);
  out(
    `${apply ? "Applied" : "Would make"} ${total} replacement(s) in ${edits.length} file(s) and ${moves.length} move(s).`,
  );
}
