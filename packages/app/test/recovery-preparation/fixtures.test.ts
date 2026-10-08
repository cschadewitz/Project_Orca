import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withSyntheticProfile } from "./crash-harness.js";
import { filesContainingSyntheticBytes, flippedCopy, truncatedCopies } from "./fixtures.js";

describe("synthetic recovery fixture helpers (not storage acceptance)", () => {
  it("makes truncated and one-bit damaged copies without changing the valid source", () => {
    const source = Uint8Array.of(1, 2, 3, 4, 5);
    expect(truncatedCopies(source).map((bytes) => bytes.length)).toEqual([0, 1, 2, 4]);
    expect([...flippedCopy(source, 3)]).toEqual([1, 2, 3, 5, 5]);
    expect([...source]).toEqual([1, 2, 3, 4, 5]);
  });

  it("finds synthetic plaintext in a disposable profile", async () => {
    await withSyntheticProfile(async (profile) => {
      const canary = Buffer.from("SYNTHETIC_PRIVATE_CONTENT_CANARY");
      await writeFile(join(profile, "checkpoint"), Buffer.concat([Buffer.from("header"), canary]));
      expect(await filesContainingSyntheticBytes(profile, [canary], 128)).toEqual(["checkpoint"]);
    });
  });

  it.skipIf(process.platform === "win32")("rejects a link in the synthetic profile", async () => {
    await withSyntheticProfile(async (profile) => {
      const canary = Buffer.from("SYNTHETIC_PRIVATE_CONTENT_CANARY");
      await writeFile(join(profile, "checkpoint"), canary);
      await symlink(join(profile, "checkpoint"), join(profile, "linked"));
      await expect(filesContainingSyntheticBytes(profile, [canary], 128)).rejects.toThrow("symbolic link");
    });
  });

  it("fails closed when the synthetic tree exceeds the explicit scan limit", async () => {
    await withSyntheticProfile(async (profile) => {
      await writeFile(join(profile, "checkpoint"), Buffer.alloc(4));
      await expect(filesContainingSyntheticBytes(profile, [Buffer.from("canary")], 3)).rejects.toThrow(
        "exceeds scan limit",
      );
    });
  });
});
