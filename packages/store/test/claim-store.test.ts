/** The compare-and-set that stops two dispatchers from launching the same work item. */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileClaimStore, InMemoryClaimStore, ownsClaim, type ClaimStore, type WorkItemClaim } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function fileStore(): Promise<{ store: FileClaimStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-claims-"));
  dirs.push(dir);
  return { store: new FileClaimStore(dir), dir };
}

const claim = (workItemId: string, runId: string, branch = "b"): WorkItemClaim => ({
  workItemId,
  runId,
  branch,
  stepRunId: "step_1",
  at: "2026-01-01T00:00:00.000Z",
});

describe("claim stores", () => {
  for (const [name, make] of [
    ["memory", async (): Promise<ClaimStore> => new InMemoryClaimStore()],
    ["file", async (): Promise<ClaimStore> => (await fileStore()).store],
  ] as const) {
    it(`${name}: the first claim wins and later ones see the incumbent`, async () => {
      const store = await make();
      expect(await store.get("wi_1")).toBeUndefined();
      const first = await store.claim(claim("wi_1", "run_a"));
      expect(ownsClaim(first, "run_a", "b")).toBe(true);

      const second = await store.claim(claim("wi_1", "run_z", "other"));
      expect(second.runId).toBe("run_a");
      expect(ownsClaim(second, "run_z", "other")).toBe(false);
      expect(await store.get("wi_1")).toMatchObject({ runId: "run_a", branch: "b" });
      // A different item is unaffected.
      expect(ownsClaim(await store.claim(claim("wi_2", "run_z")), "run_z", "b")).toBe(true);
    });

    it(`${name}: the owner re-claims its own item, a sibling branch of the same run does not`, async () => {
      const store = await make();
      await store.claim(claim("wi_1", "run_a", "api"));
      // Same run, same branch: a re-attempted or resumed step must still own what it launched.
      expect(ownsClaim(await store.claim(claim("wi_1", "run_a", "api")), "run_a", "api")).toBe(true);
      // Same run, second branch bound to the same item: still one launch only.
      expect(ownsClaim(await store.claim(claim("wi_1", "run_a", "ui")), "run_a", "ui")).toBe(false);
    });

    it(`${name}: release only drops the holder's own claim`, async () => {
      const store = await make();
      await store.claim(claim("wi_1", "run_a"));
      await store.release("wi_1", "run_other");
      expect(await store.get("wi_1")).toMatchObject({ runId: "run_a" });
      await store.release("wi_1", "run_a");
      expect(await store.get("wi_1")).toBeUndefined();
      // Released items are claimable again, and releasing an unclaimed item is a no-op.
      await store.release("wi_1", "run_a");
      expect(ownsClaim(await store.claim(claim("wi_1", "run_b")), "run_b", "b")).toBe(true);
    });

    it(`${name}: list shows every held claim and nothing once released`, async () => {
      const store = await make();
      expect(await store.list()).toEqual([]);
      await store.claim(claim("wi_1", "run_a", "api"));
      await store.claim(claim("wi_2", "run_b", "ui"));
      await store.claim(claim("wi_2", "run_c", "ui")); // loses; not a second entry
      const listed = (await store.list()).sort((x, y) => x.workItemId.localeCompare(y.workItemId));
      expect(listed).toEqual([claim("wi_1", "run_a", "api"), claim("wi_2", "run_b", "ui")]);
      await store.release("wi_1", "run_a");
      expect(await store.list()).toEqual([claim("wi_2", "run_b", "ui")]);
    });

    it(`${name}: concurrent claims on one item elect a single owner`, async () => {
      const store = await make();
      const runs = ["run_a", "run_b", "run_c", "run_d", "run_e"];
      const held = await Promise.all(runs.map((r) => store.claim(claim("wi_1", r))));
      expect(new Set(held.map((h) => h.runId)).size).toBe(1);
      expect(runs.filter((r) => ownsClaim(held[runs.indexOf(r)]!, r, "b"))).toHaveLength(1);
      expect((await store.get("wi_1"))!.runId).toBe(held[0]!.runId);
    });
  }

  it("file store leaves no temporary files behind and survives a restart", async () => {
    const { store, dir } = await fileStore();
    await Promise.all([
      store.claim(claim("wi_1", "run_a")),
      store.claim(claim("wi_1", "run_b")),
      store.claim(claim("wi_2", "run_b")),
    ]);
    const files = await readdir(join(dir, "claims"));
    expect(files.sort()).toEqual(["wi_1.json", "wi_2.json"]);
    // A second process over the same directory reads the claims, it does not re-elect.
    const restarted = new FileClaimStore(dir);
    const owner = (await restarted.get("wi_1"))!.runId;
    expect((await restarted.claim(claim("wi_1", "run_c"))).runId).toBe(owner);
  });

  it("file store keeps ids inside the claims directory", async () => {
    const { store, dir } = await fileStore();
    await store.claim(claim("../escape", "run_a"));
    expect(await readdir(join(dir, "claims"))).toEqual(["..%2Fescape.json"]);
    expect(await store.get("../escape")).toMatchObject({ runId: "run_a" });
  });
});
