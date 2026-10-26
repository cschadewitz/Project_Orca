/** Build a NEW isolated test image. No runtime source loader, package mount or installation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = process.argv[2];
assert.ok(target && target === resolve(target), "new absolute test image directory required");
// Exclusive directory creation refuses replacing an existing tree.
fs.mkdirSync(target, { mode: 0o700 });
const require = createRequire(join(repo, "package.json"));
const { buildSync } = createRequire(require.resolve("tsx/package.json"))("esbuild");
const result = buildSync({
  absWorkingDir: repo,
  entryPoints: ["packages/cli/test/controlled-owned-read-producer.ts"],
  outfile: join(target, "controlled-producer.mjs"),
  bundle: true,
  splitting: false,
  platform: "node",
  format: "esm",
  target: "node24",
  keepNames: true,
  metafile: true,
  tsconfig: join(repo, "tsconfig.json"),
  banner: {
    js: "import { createRequire as __orcaCreateRequire } from 'node:module'; const require = __orcaCreateRequire(import.meta.url);",
  },
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "silent",
});
fs.copyFileSync(
  join(repo, "tools/owned-read-proof/controlled-child.mjs"),
  join(target, "controlled-child.mjs"),
  fs.constants.COPYFILE_EXCL,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = Object.fromEntries(
  Object.keys(result.metafile.inputs)
    .sort()
    .map((path) => [path, hash(fs.readFileSync(join(repo, path)))]),
);
fs.writeFileSync(
  join(target, "controlled-build.json"),
  JSON.stringify({
    version: 1,
    entry: "controlled-child.mjs",
    profileRef: "orca-owned-file-read-v1",
    sources,
    producerSha256: hash(fs.readFileSync(join(target, "controlled-producer.mjs"))),
    childSha256: hash(fs.readFileSync(join(target, "controlled-child.mjs"))),
  }) + "\n",
  { flag: "wx", mode: 0o400 },
);
process.stdout.write(
  JSON.stringify({
    image: target,
    files: ["controlled-build.json", "controlled-producer.mjs", "controlled-child.mjs"],
  }) + "\n",
);
