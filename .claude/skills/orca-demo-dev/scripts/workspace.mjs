// What both launcher scripts agree on: where the repository is, where its demo workspace
// lives, and how to read and write the workspace's YAML without hand-rolled parsing.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts -> orca-demo-dev -> skills -> .claude -> repository root
export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** One workspace per checkout, so two worktrees never share a store. */
export function defaultWorkspace() {
  const id = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 8);
  return join(tmpdir(), `orca-dev-demo-${id}`);
}

/**
 * The `yaml` package, borrowed from the CLI that writes the demo config. pnpm links a
 * package's dependencies under that package only, so it is resolved from there rather than
 * from this script's own location, which has no node_modules of its own.
 */
export const YAML = createRequire(join(repoRoot, "packages", "cli", "package.json"))("yaml");

/** `[label] line` on stdout: these scripts are launchers, and their output is the log. */
export const say = (line) => process.stdout.write(`${line}\n`);
