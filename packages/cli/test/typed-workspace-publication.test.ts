/** CI-like umasks are isolated to bounded disposable child processes, never workers. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { childBundle } from "@orca/testing/child-bundle";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.skipIf(process.platform !== "linux").each(["022", "002", "077", "000"])(
  "canonical typed publication remains private through enrollment/create/revoke with child umask %s",
  async (mask) => {
    const root = await mkdtemp(join(tmpdir(), "orca-typed-publication-"));
    roots.push(root);
    const source = fileURLToPath(new URL("./typed-workspace-publication-child.ts", import.meta.url));
    const bundled = childBundle("typed-workspace-publication", { entries: { child: source } })?.child;
    const args = [...(bundled ? [bundled] : ["--import", "tsx", source]), root, mask];
    const parentMask = process.umask();
    const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 10000, maxBuffer: 64 * 1024 });
    const observed = JSON.parse(stdout) as {
      outcome: string;
      temporaryModes: string[];
      phases: {
        phase: string;
        metadata: { mode: string; uidMatches: boolean; nlink: number; size: number; regular: boolean };
      }[];
      identity: { mode: string; uidMatches: boolean; nlink: number; regular: boolean };
      control: { mode: string; uidMatches: boolean; nlink: number; regular: boolean };
      status: string;
      enrolled: string;
      revisionsChanged: boolean;
      externalUnchanged: boolean;
    };
    expect(observed).toMatchObject({
      outcome: "saved",
      status: "revoked",
      enrolled: "enrolled",
      revisionsChanged: true,
      externalUnchanged: true,
    });
    expect(observed.phases.map((phase) => phase.phase)).toEqual(["initialized", "created", "revoked"]);
    expect(observed.temporaryModes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(observed.temporaryModes)).toEqual(new Set(["600"]));
    for (const { metadata } of observed.phases) {
      expect(metadata).toMatchObject({ mode: "600", uidMatches: true, nlink: 1, regular: true });
      expect(metadata.size).toBeGreaterThan(0);
      expect(metadata.size).toBeLessThanOrEqual(64 * 1024);
    }
    for (const metadata of [observed.identity, observed.control])
      expect(metadata).toMatchObject({ mode: "600", uidMatches: true, nlink: 1, regular: true });
    expect(process.umask()).toBe(parentMask);
  },
);
