/**
 * How an engine test starts a child process of its own: a crash script, a second interpreter
 * contending for a lease. Each one is a small entry file next to the test, and a process the
 * test spawns and judges by its output or exit code, so it stays a real, fresh process.
 */
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { childBundle } from "@orca/testing";

/**
 * The `node` arguments that run the entry file `entry` with `args`. Under Vitest that is the
 * entry prebuilt once for the run, which a plain `node` starts without transpiling its import
 * graph again; with no run directory (`ORCA_TEST_BUNDLES=0`) it is the TypeScript source through
 * tsx, as it was before the bundles.
 */
export function childCommand(entry: URL, args: string[]): string[] {
  const source = fileURLToPath(entry);
  const bundled = childBundle(basename(source, ".ts"), { entries: { main: source } })?.main;
  return bundled ? [bundled, ...args] : ["--import", "tsx", source, ...args];
}
