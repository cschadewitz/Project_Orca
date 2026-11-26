/**
 * ORCA's own evidence for the Codex it starts (#1162): the digest of its own child's image,
 * read from the kernel, and the verified builds both Codex routes share.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_HOOK_VERIFIED_PAIRS,
  CODEX_VERIFIED_IMAGES,
  codexImageTarget,
  codexVersionForImage,
  ownChildImageDigest,
} from "../src/index.js";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("verified Codex images", () => {
  it("keeps one digest per version and platform, which the ACP route's pairs read too", () => {
    const pinned = CODEX_VERIFIED_IMAGES["0.171.0"]!["linux-x64"]!;
    expect(pinned).toMatch(/^[0-9a-f]{64}$/);
    expect(codexVersionForImage(pinned, "linux-x64")).toBe("0.171.0");
    expect(codexVersionForImage(pinned, "darwin-arm64")).toBeUndefined();
    expect(codexVersionForImage("0".repeat(64), "linux-x64")).toBeUndefined();
    for (const pair of CODEX_HOOK_VERIFIED_PAIRS) expect(pair.images).toBe(CODEX_VERIFIED_IMAGES[pair.runtime]);
    expect(codexImageTarget("linux", "x64")).toBe("linux-x64");
  });
});

describe.skipIf(process.platform !== "linux")("ownChildImageDigest", () => {
  it("hashes the image the kernel runs for a child ORCA started", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    await new Promise((r) => child.once("spawn", r));
    try {
      expect(await ownChildImageDigest(child.pid)).toEqual({ sha256: sha256(realpathSync(process.execPath)) });
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("refuses a process that is not its own child, and an unknown pid", async () => {
    expect(await ownChildImageDigest(process.pid)).toEqual({
      error: `process ${process.pid} is not running as a child ORCA started`,
    });
    expect(await ownChildImageDigest(1)).toEqual({ error: "its process id is unknown" });
    expect(await ownChildImageDigest(undefined)).toEqual({ error: "its process id is unknown" });
  });

  it("refuses a child that is gone", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => child.once("exit", r));
    expect(await ownChildImageDigest(child.pid)).toMatchObject({ error: expect.stringMatching(/not running/) });
  });
});
