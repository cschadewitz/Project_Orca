#!/usr/bin/env node
// `eslint .` with its thread count taken from ESLINT_CONCURRENCY. ESLint reads concurrency
// only from the --concurrency flag, never from the environment or the flat config, so a
// runner could not set it without a code change. Unset means "off", the single-threaded
// default; set it to a positive integer or "auto" (for example in a runner's container
// environment). Extra arguments go to ESLint after the ".". ESLint rejects a bad value.
//
// Each thread builds its own typed-lint TypeScript program, about 3 GiB of memory here, so
// the thread count is bounded by the memory the process may use (its cgroup limit, or the
// machine's): a runner whose limit cannot hold the requested threads had ESLint killed
// mid-run with no output at all.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GIB = 1024 ** 3;
/** Measured peak per ESLint thread on this repository (single thread about 4 GiB in all). */
export const THREAD_BYTES = 3 * GIB;
/** Left for the main thread, the shell and the runner itself. */
export const RESERVE_BYTES = 1 * GIB;

/** The memory this process may use: its cgroup's limit (v2, then v1) when lower than the machine's. */
export function memoryLimit(read = (path) => readFileSync(path, "utf8"), machine = totalmem()) {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const value = Number(read(path).trim());
      if (Number.isSafeInteger(value) && value > 0) return Math.min(value, machine);
    } catch {
      // Not this cgroup version, or not Linux.
    }
  }
  return machine;
}

/**
 * The value for ESLint's --concurrency: "off" unless threads are requested, and never more
 * threads than `memory` holds. A value that is neither "off", "auto" nor a positive integer
 * goes to ESLint unchanged, which rejects it.
 */
export function chooseConcurrency(requested, { cores = availableParallelism(), memory = memoryLimit() } = {}) {
  const value = requested?.trim() || "off";
  let threads;
  if (value === "auto") threads = Math.max(1, Math.floor(cores / 2));
  else if (/^[1-9][0-9]*$/.test(value)) threads = Number(value);
  else return { concurrency: value };
  const fits = Math.max(1, Math.floor((memory - RESERVE_BYTES) / THREAD_BYTES));
  const used = Math.min(threads, fits);
  const concurrency = used > 1 ? String(used) : "off";
  const note =
    used < threads
      ? `lint: ESLINT_CONCURRENCY=${value} asks for ${threads} threads, but ${(memory / GIB).toFixed(1)} GiB of memory fits ${fits}; using ${concurrency}`
      : undefined;
  return { concurrency, note };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const { concurrency, note } = chooseConcurrency(process.env.ESLINT_CONCURRENCY);
  if (note) console.error(note);

  // Run ESLint's own CLI script under this Node. The `.bin` entry is a shell script (a `.cmd`
  // on Windows) that a child process cannot launch without a shell.
  const require = createRequire(import.meta.url);
  const eslintPackage = require.resolve("eslint/package.json");
  const eslintCli = resolve(dirname(eslintPackage), require(eslintPackage).bin.eslint);

  const child = spawn(process.execPath, [eslintCli, ".", "--concurrency", concurrency, ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`lint: could not start ESLint: ${error.message}`);
    process.exit(2);
  });
  child.on("close", (code, signal) => {
    // Killed from outside (the out-of-memory killer sends SIGKILL): say so, since ESLint
    // itself printed nothing.
    if (signal) console.error(`lint: ESLint was killed by ${signal} (--concurrency ${concurrency})`);
    process.exit(code ?? 2);
  });
}
