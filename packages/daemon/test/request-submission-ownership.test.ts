import { writeFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OwnershipStore } from "../src/auth/ownership.js";
it("merges independent ownership writers and preserves the first durable owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-owners-"));
  try {
    const file = join(dir, "ownership.json"),
      a = new OwnershipStore(file),
      b = new OwnershipStore(file);
    a.record("a", "alice");
    b.record("b", "bob");
    await Promise.all([a.flush(), b.flush()]);
    expect(a.lastError).toBeUndefined();
    expect(b.lastError).toBeUndefined();
    expect(a.owner("b")).toBe("bob");
    expect(b.owner("a")).toBe("alice");
    a.record("shared", "alice");
    await a.flush();
    b.record("shared", "bob");
    await b.flush();
    expect(new OwnershipStore(file).owner("shared")).toBe("alice");
    a.forget("a", "alice");
    await a.flush();
    expect(b.owner("a")).toBeUndefined();
    expect(b.owner("b")).toBe("bob");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("retains queued local changes while merging other process writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-owners-"));
  try {
    const file = join(dir, "ownership.json"),
      a = new OwnershipStore(file),
      b = new OwnershipStore(file);
    a.record("a", "alice");
    a.record("b", "alice");
    b.record("c", "bob");
    expect(a.owner("a")).toBe("alice");
    expect(a.owner("b")).toBe("alice");
    await Promise.all([a.flush(), b.flush()]);
    a.forget("a", "alice");
    b.record("d", "bob");
    await Promise.all([a.flush(), b.flush()]);
    expect([a.owner("a"), a.owner("b"), a.owner("c"), a.owner("d")]).toEqual([undefined, "alice", "bob", "bob"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("flushes the exact attribution without treating a later queued write as its failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-owners-concurrent-"));
  try {
    const file = join(dir, "ownership.json");
    const ownership = new OwnershipStore(file);
    ownership.record("a", "alice");
    const first = ownership.flush("a").then(() => {
      expect(ownership.lastError).toBeUndefined();
      expect(new OwnershipStore(file).owner("a")).toBe("alice");
    });
    ownership.record("b", "bob");
    await Promise.all([first, ownership.flush("b")]);
    expect(new OwnershipStore(file).owner("b")).toBe("bob");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps a failed attribution distinct from a later successful write and retries it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-owners-failed-"));
  try {
    const parent = join(dir, "auth");
    const file = join(parent, "ownership.json");
    const ownership = new OwnershipStore(file);
    ownership.record("a", "alice");
    writeFileSync(parent, "blocks directory creation");
    await expect(ownership.flush("a")).rejects.toThrow();
    unlinkSync(parent);
    await mkdir(parent);
    ownership.record("b", "bob");
    await ownership.flush("b");
    expect(new OwnershipStore(file).owner("b")).toBe("bob");
    expect(new OwnershipStore(file).owner("a")).toBeUndefined();
    await expect(ownership.flush("a")).rejects.toThrow();
    ownership.record("a", "alice");
    await ownership.flush("a");
    expect(new OwnershipStore(file).owner("a")).toBe("alice");
    // Cached ownership never masks a subsequent malformed on-disk record.
    writeFileSync(file, "not JSON");
    expect(() => ownership.owner("b")).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
