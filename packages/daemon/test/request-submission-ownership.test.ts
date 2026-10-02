import { mkdtemp, rm } from "node:fs/promises";
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
