/**
 * The hook process's only way out (#704). Imported first by `claude-pre-tool-hook.ts`, before
 * any other module runs, so that nothing but the hook's own answer can reach the agent:
 *
 * - A write to stdout from anywhere else (a dependency's `console.log`, a stray debug line)
 *   is kept off stdout and turns the answer into a block. Claude Code reads stdout that is
 *   not JSON, with exit 0, as plain text and lets the call through, so text the hook did not
 *   mean to print must never get there.
 * - Leaving by any other road than `answer` (a `process.exit(0)` somewhere, an uncaught
 *   exception, an unhandled rejection, running out of work) exits 2 with a reason on stderr,
 *   which blocks. An exit 0 with nothing printed is an allow, so it must only ever come from
 *   `answer`; and Codex lets an exit 2 with an empty stderr through, so a block always says why.
 */
import { writeSync } from "node:fs";

const writeStdout = process.stdout.write.bind(process.stdout);
const writeStderr = process.stderr.write.bind(process.stderr);

let stray = false;
let answered = false;

const swallow = ((..._args: unknown[]): boolean => {
  stray = true;
  return true;
}) as typeof process.stdout.write;
process.stdout.write = swallow;
// `console.log` and friends write to stdout; to be sure, they are caught here too.
for (const method of ["log", "info", "debug", "dir", "table", "trace"] as const)
  // eslint-disable-next-line no-console -- replacing them, not calling them
  console[method] = (() => {
    stray = true;
  }) as never;

process.on("exit", () => {
  if (answered) return;
  process.exitCode = 2;
  // Codex lets a call through on an exit 2 with nothing on stderr, so a block always says why.
  try {
    writeSync(2, "Blocked by ORCA: the hook stopped before it answered.\n");
  } catch {
    // Nothing more can be done from here; the exit code still blocks Claude.
  }
});

/** Answer the agent and leave: the one road out that can exit 0. Called once. */
export function answer(result: { exitCode: 0 | 2; stdout: string; stderr: string }): void {
  if (answered) return;
  answered = true;
  if (stray) {
    writeStderr("Blocked by ORCA: the hook printed something besides its answer, so its answer is not trusted.\n");
    process.exitCode = 2;
    return;
  }
  writeStdout(result.stdout);
  writeStderr(result.stderr);
  process.exitCode = result.exitCode;
}
