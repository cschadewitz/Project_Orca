/** The fence refuses any store volume that is not a local, persistent one. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const statfs = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  statfsSync: statfs,
}));

import { assertFenceVolume } from "../src/first-run-fence.js";

// Linux statfs f_type magics (linux/magic.h)
const EXT = 0xef53;
const XFS = 0x58465342;
const BTRFS = 0x9123683e;
const OVERLAY = 0x794c7630;
const TMPFS = 0x01021994;
const RAMFS = 0x858458f6;
const NFS = 0x6969;
const FUSE = 0x65735546;

const linux = process.platform === "linux";

describe.skipIf(!linux)("assertFenceVolume on Linux", () => {
  beforeEach(() => statfs.mockReset());

  it.each([
    ["ext2/3/4", EXT],
    ["XFS", XFS],
    ["Btrfs", BTRFS],
    ["local overlay (reference-container upper storage)", OVERLAY],
  ])("accepts %s", (_name, type) => {
    statfs.mockReturnValue({ type });
    expect(() => assertFenceVolume("/store")).not.toThrow();
    expect(statfs).toHaveBeenCalledWith("/store");
  });

  it.each([
    ["tmpfs", TMPFS],
    ["ramfs", RAMFS],
    ["NFS", NFS],
    ["FUSE", FUSE],
    ["an unknown type", 0],
  ])("refuses %s", (_name, type) => {
    statfs.mockReturnValue({ type });
    expect(() => assertFenceVolume("/store")).toThrow("First-run fence volume unavailable");
  });
});
