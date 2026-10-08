import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killAtBoundary, withSyntheticProfile } from "./crash-harness.js";

describe("disposable crash harness (not storage acceptance)", () => {
  it("kills a synthetic child after its IPC boundary and cleans the profile", async () => {
    let profilePath = "";
    await withSyntheticProfile(async (profile) => {
      profilePath = profile;
      const child = join(profile, "child.mjs");
      await writeFile(
        child,
        `import { writeFile } from "node:fs/promises";
         import { join } from "node:path";
         await writeFile(join(process.argv[2], "marker"), "synthetic checkpoint marker");
         process.send?.({ type: "boundary", name: "after-write" });
         setInterval(() => {}, 1_000);`,
      );
      const outcome = await killAtBoundary({ entry: child, profile, boundary: "after-write" });
      expect(outcome.signal !== null || outcome.code !== 0).toBe(true);
    });
    await expect(access(profilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a child that exits without reaching the requested boundary", async () => {
    await withSyntheticProfile(async (profile) => {
      const child = join(profile, "child.mjs");
      await writeFile(child, "process.exit(0);");
      await expect(killAtBoundary({ entry: child, profile, boundary: "after-write" })).rejects.toThrow(
        "Child exited before boundary after-write",
      );
    });
  });
});
