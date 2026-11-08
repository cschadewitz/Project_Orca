/** Shared journal helpers for the first-run compaction tests; importing it registers the temp-root cleanup. */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import type { BundledDaemon } from "../src/main/daemon-process.js";
import {
  OWNERSHIP_DIRECTORY,
  inspectFirstRunOwnership,
  reserveFirstRunOwnership,
} from "../src/main/first-run/ownership.js";
import { syntheticFirstRunWriter } from "./fixtures/synthetic-first-run-writer.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
// Under the checkout, like the recovery tests: the lifetime fence refuses tmpfs volumes.
export async function selected() {
  const path = await mkdtemp(join(process.cwd(), ".orca-compaction-test-"));
  roots.push(path);
  await writeFile(join(path, "orca.config.yaml"), "synthetic config\n");
  return path;
}
/** One whole owned launch: reserve, attest the writer, attach, observe the direct child's exit and settle. */
export function launch(path: string) {
  const owner = reserveFirstRunOwnership(path);
  syntheticFirstRunWriter(path, 123);
  let exited = false;
  const daemon: BundledDaemon = {
    url: "http://127.0.0.1:7654",
    pid: 123,
    get exited() {
      return exited;
    },
    stop: async () => {},
  };
  owner.attach(daemon);
  exited = true;
  expect(owner.complete()).toBe(true);
}
export const journal = (path: string) => join(path, OWNERSHIP_DIRECTORY);
export const listing = async (path: string) => (await readdir(journal(path))).sort();
export const refused = (path: string) => expect(() => inspectFirstRunOwnership(path)).toThrow("reconciliation");
