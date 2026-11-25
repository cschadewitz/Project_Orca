#!/usr/bin/env node
// Pack the demo seed into one folder that runs on a machine with only Node (or an installed
// ORCA) on it: `tools/demo-seed/dist/orca-demo-seed/` holds seed.mjs and its data, the scripted
// ACP agent bundled into a single file, and the repo's workflows and templates as assets.
// Copy that folder to the machine and run `node seed.mjs` there (README.md).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const out = join(here, "dist", "orca-demo-seed");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

// esbuild through tsx, as packages/testing/src/child-bundle.ts finds it, with the same options:
// the repo tsconfig's paths for @orca/*, a `require` for inlined CommonJS, and one zod module.
const require = createRequire(join(repoRoot, "package.json"));
const esbuild = createRequire(require.resolve("tsx/package.json"))("esbuild");
const zodManifest = createRequire(join(repoRoot, "packages", "core", "package.json")).resolve("zod/package.json");
esbuild.buildSync({
  absWorkingDir: repoRoot,
  entryPoints: [join(repoRoot, "packages", "testing", "src", "scripted-agent", "main.ts")],
  outfile: join(out, "scripted-agent.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  // An installed ORCA's Electron, or the Node on a test machine: neither is newer than this.
  target: "node22",
  keepNames: true,
  tsconfig: join(repoRoot, "tsconfig.json"),
  banner: {
    js: "import { createRequire as __orcaCreateRequire } from 'node:module'; const require = __orcaCreateRequire(import.meta.url);",
  },
  external: ["bufferutil", "utf-8-validate"],
  alias: { "zod/v4": join(dirname(zodManifest), "index.js") },
  logLevel: "warning",
});

for (const file of ["seed.mjs", "data.mjs", "workflows.mjs", "README.md"]) cpSync(join(here, file), join(out, file));
cpSync(join(repoRoot, "workflows"), join(out, "assets", "workflows"), { recursive: true });
cpSync(join(repoRoot, "templates"), join(out, "assets", "templates"), { recursive: true });
process.stdout.write(`[demo-seed] packed ${out}\n`);
