#!/usr/bin/env node
// `eslint .` with its thread count taken from ESLINT_CONCURRENCY. ESLint reads concurrency
// only from the --concurrency flag, never from the environment or the flat config, so a
// runner could not set it without a code change. Unset means "off", the single-threaded
// default; set it to a positive integer or "auto" (for example in a runner's container
// environment). Extra arguments go to ESLint after the ".". ESLint rejects a bad value.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const concurrency = process.env.ESLINT_CONCURRENCY?.trim() || "off";

// Run ESLint's own CLI script under this Node. The `.bin` entry is a shell script (a `.cmd`
// on Windows) that a child process cannot launch without a shell.
const require = createRequire(import.meta.url);
const eslintPackage = require.resolve("eslint/package.json");
const eslintCli = resolve(dirname(eslintPackage), require(eslintPackage).bin.eslint);

const child = spawn(process.execPath, [eslintCli, ".", "--concurrency", concurrency, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
child.on("error", () => process.exit(2));
child.on("close", (code) => process.exit(code ?? 2));
