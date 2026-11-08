#!/usr/bin/env node
// `prettier --check` over every tracked file, split across processes. Prettier is single
// threaded, so one `prettier --check .` took ~13 s of wall time on a 32-core runner while
// the other cores idled; chunks run side by side finish in a fraction of that. It checks
// exactly what `prettier --check .` checks in a clean checkout (.prettierignore still
// applies to explicitly named files), and exits non-zero if any chunk does.
import { execFileSync, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\0")
  .filter(Boolean);

const jobs = Math.max(1, Math.min(8, availableParallelism() - 1, Math.ceil(files.length / 100)));
const chunks = Array.from({ length: jobs }, () => []);
files.forEach((file, i) => chunks[i % jobs].push(file));

const prettier = resolve(root, "node_modules/.bin/prettier");
const codes = await Promise.all(
  chunks.map(
    (chunk) =>
      new Promise((done) => {
        const child = spawn(prettier, ["--check", "--ignore-unknown", "--log-level", "warn", ...chunk], {
          cwd: root,
          stdio: "inherit",
        });
        child.on("error", () => done(2));
        child.on("close", (code) => done(code ?? 2));
      }),
  ),
);
const failed = Math.max(0, ...codes);
console.log(failed === 0 ? `All ${files.length} tracked files use Prettier code style.` : "Prettier check failed.");
process.exit(failed);
