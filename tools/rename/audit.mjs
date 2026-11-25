#!/usr/bin/env node
// Fails when an ORCA name is left anywhere the rename should have reached.
//
//   node tools/rename/audit.mjs            list leftovers, exit 1 if any
//   node tools/rename/audit.mjs --summary  counts per file only
//
// A leftover is allowed when it is on map.json's keep list, on a line marked `rename-keep`,
// inside a rename-keep-start/end block, in an excluded path, or listed in allowlist.json
// with a reason. Run it after codemod.mjs --apply (the nightly preview and cutover do).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globToRegExp, isBinaryPath, isExcluded, leftovers, loadMap, LEFTOVER } from "./lib.mjs";

// The repository the command runs in, so convert-branch.sh can run a copy taken from main.
const out = (line) => process.stdout.write(`${line}\n`);
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const summary = process.argv.includes("--summary");
const map = loadMap();
const allow = JSON.parse(readFileSync(new URL("./allowlist.json", import.meta.url), "utf8")).entries.map((e) => ({
  ...e,
  re: new RegExp(e.pattern),
  paths: globToRegExp(e.path),
}));

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 })
  .split("\0")
  .filter(Boolean);

const report = [];
for (const file of files) {
  if (isExcluded(map, file)) continue;
  const abs = resolve(root, file);
  if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
  const hits = [];
  if (file.match(LEFTOVER) && !allowed(file, "(path)")) hits.push({ line: 0, column: 0, text: "(path)" });
  if (!isBinaryPath(map, file)) {
    const buf = readFileSync(abs);
    if (!buf.subarray(0, 8000).includes(0)) {
      for (const h of leftovers(map, buf.toString("utf8"))) {
        if (!allowed(file, h.text)) hits.push(h);
      }
    }
  }
  if (hits.length) report.push({ file, hits });
}

function allowed(file, text) {
  return allow.some((a) => a.paths.test(file) && a.re.test(text));
}

const total = report.reduce((n, r) => n + r.hits.length, 0);
for (const r of report) {
  if (summary) out(`${String(r.hits.length).padStart(6)}  ${r.file}`);
  else for (const h of r.hits) out(`${r.file}:${h.line}:${h.column}  ${h.text.slice(0, 160)}`);
}
out(total ? `audit: ${total} leftover ORCA name(s) in ${report.length} file(s).` : "audit: no leftover ORCA names.");
process.exit(total ? 1 : 0);
