/**
 * Once per test run: the directory test child processes are prebuilt into
 * (`packages/testing/src/child-bundle.ts`). Workers and the processes they start inherit it
 * through the environment; the bundles themselves are built lazily, on first use, and the
 * directory goes when the run ends, so no bundle outlives the sources it was built from.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_BUNDLE_DIR_ENV } from "./packages/testing/src/child-bundle.js";

export default function setup(): () => void {
  // An outer run (a test that starts Vitest itself) keeps its own directory, and
  // ORCA_TEST_BUNDLES=0 runs every child from its TypeScript sources through tsx.
  if (process.env[CHILD_BUNDLE_DIR_ENV] || process.env.ORCA_TEST_BUNDLES === "0") return () => {};
  const dir = mkdtempSync(join(tmpdir(), "orca-test-bundles-"));
  process.env[CHILD_BUNDLE_DIR_ENV] = dir;
  return () => {
    delete process.env[CHILD_BUNDLE_DIR_ENV];
    rmSync(dir, { recursive: true, force: true });
  };
}
