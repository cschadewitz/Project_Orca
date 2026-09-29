import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { releaseAssets } from "../src/bootstrap.js";
it("pins shipped assets to the same concrete release as code while preserving custom paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-assets-"));
  try {
    const old = join(dir, "old");
    const next = join(dir, "next");
    const current = join(dir, "current");
    await mkdir(old);
    await mkdir(next);
    await symlink(old, current, "junction");
    vi.stubEnv("ORCA_RELEASE", current);
    const config = {
      workflows: ["${ORCA_RELEASE}/workflows/*.yaml", "/custom/workflow.yaml"],
      templates: ["${ORCA_RELEASE}/templates/*.md"],
    };
    const assets = await releaseAssets(config);
    await rm(current);
    await symlink(next, current, "junction");
    expect(assets.workflows).toEqual([`${await realpath(old)}/workflows/*.yaml`, "/custom/workflow.yaml"]);
    expect((await releaseAssets(config)).templates).toEqual([`${await realpath(next)}/templates/*.md`]);
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
