/** Emit the exact source solution and normalize generated text to pinned LF on every host. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { specification, verifySource } from "./manifest.mjs";
const source = path.resolve(process.argv[2]);
verifySource(source);
const require = createRequire(path.join(source, "package.json"));
const compiler = require.resolve("typescript/package.json");
assert.equal(JSON.parse(fs.readFileSync(compiler, "utf8")).version, specification.compiler);
execFileSync(process.execPath, [path.join(path.dirname(compiler), "bin/tsc"), "-b", "tsconfig.build.json", "--force"], {
  cwd: source,
  stdio: "inherit",
  timeout: 180_000,
});
// TS7 has no legacy solution-builder JS API. Normalize emitted text only, then
// verifyBuild independently compares all executable bytes with reviewed hashes.
function normalize(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) normalize(file);
    else if (/\.(?:js|cjs|mjs|json)$/.test(name)) {
      const before = fs.readFileSync(file, "utf8"),
        after = before.replace(/\r\n/g, "\n");
      if (before !== after) fs.writeFileSync(file, after);
    }
  }
}
for (const name of fs.readdirSync(path.join(source, "packages"))) {
  const directory = path.join(source, "packages", name, "dist");
  if (fs.existsSync(directory)) normalize(directory);
}
