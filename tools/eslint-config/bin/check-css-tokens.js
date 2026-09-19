#!/usr/bin/env node
// The runner behind `pnpm run lint:css`: checks every stylesheet named on the command line
// with ../css-tokens.js and prints violations in the `file:line:col message` shape editors
// already know how to jump to.
//
// Arguments are files or directories, not globs, so that it needs no glob dependency and no
// shell expansion — `pnpm run lint` has to behave the same on every platform CI runs on.
// `--colours-only` applies to every target after it: colours and stacking order are checked,
// literal lengths are not. See the note on `checkCss` for why components.css needs that.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkCss } from "../css-tokens.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: check-css-tokens.js [--colours-only] <file|dir…>");
  process.exit(2);
}

/** Every `.css` file under `root`, ignoring build output and dependencies. */
function stylesheets(root) {
  if (!statSync(root).isDirectory()) return [root];
  const skip = new Set(["node_modules", "dist", "coverage"]);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".css"))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !f.split(/[\\/]/).some((part) => skip.has(part)));
}

let lengths = true;
let total = 0;
for (const arg of args) {
  if (arg === "--colours-only") {
    lengths = false;
    continue;
  }
  for (const file of stylesheets(arg)) {
    const label = relative(process.cwd(), file);
    for (const v of checkCss(readFileSync(file, "utf8"), label, { lengths })) {
      console.error(`${v.file}:${v.line}:${v.column}  ${v.message}`);
      total += 1;
    }
  }
}

if (total > 0) {
  console.error(`\n${total} literal value${total === 1 ? "" : "s"} — see docs/design/RULES.md rule 1.`);
  process.exit(1);
}
