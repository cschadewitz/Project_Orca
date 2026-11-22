/**
 * Automatic store carryover after a desktop update, end to end on a real first-run journal and a
 * real kernel-lifetime writer fence (#897): the updater's handoff, the next start's claim, the
 * daemon's carryover under the fence.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { enterFirstRunWriter } from "@orca/protocol/first-run-fence";
import { readUpdateHandoff, UPDATE_HANDOFF_FILE, writeUpdateHandoff } from "@orca/protocol/update-handoff";
import { enterStoreFormat, readStoreFormat, STORE_FORMAT_EPOCH, STORE_UPDATE_HANDOFF_FILE } from "@orca/store";
import { desktopCarryover } from "../../../cli/src/desktop-carryover.js";
import { handOffStoreForUpdate, withdrawUpdateHandoff } from "../../src/main/first-run/update-handoff.js";
import {
  OWNERSHIP_DIRECTORY,
  inspectFirstRunOwnership,
  reserveFirstRunOwnership,
} from "../../src/main/first-run/ownership.js";
import { launch, selected } from "../first-run-compaction/fixture.js";

/** An unmarked store from before the marker, without 0.7 evidence: ordinary startup refuses it. */
const legacy = async (store: string) => {
  await mkdir(join(store, "runs"), { recursive: true });
  await writeFile(
    join(store, "runs", "run_old.jsonl"),
    JSON.stringify({
      id: "evt_0",
      seq: 0,
      runId: "run_old",
      at: "2026-01-02T03:04:00.000Z",
      type: "run.created",
      payload: { workflowId: "review", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    }) + "\n",
  );
};
const nextAttempt = (path: string) => {
  const last = readdirSync(join(path, OWNERSHIP_DIRECTORY))
    .filter((name) => /^[0-9]{6}$/.test(name))
    .sort()
    .at(-1)!;
  return String(Number(last) + 1).padStart(6, "0");
};
const open = (store: string, version: string, carryover: ReturnType<typeof desktopCarryover>) =>
  enterStoreFormat(store, { appVersion: version, mode: "write", carryover: () => Promise.resolve(carryover) });

it("the store module skips exactly the record the updater writes", () => {
  expect(STORE_UPDATE_HANDOFF_FILE).toBe(UPDATE_HANDOFF_FILE);
});

it("carries the store forward on the first start after the update, under the new daemon's fence", async () => {
  const path = await selected();
  launch(path); // The 0.8.0 daemon ran, was stopped for the update, and its exit was observed.
  const store = join(path, ".orca");
  await legacy(store);
  handOffStoreForUpdate(path, "0.8.0", "0.9.0");
  expect(readUpdateHandoff(store)).toMatchObject({ from: "0.8.0", to: "0.9.0", attempts: 0 });
  // The installed app's first start: a new reservation, then its daemon enters as the writer.
  const owner = reserveFirstRunOwnership(path);
  const hold = await enterFirstRunWriter(path, store, owner.launchToken!());
  expect(hold?.check()).toBe(true);
  const authority = desktopCarryover(hold, "0.9.0");
  expect(authority).toBeDefined();
  expect(await open(store, "0.9.0", authority)).toMatchObject({ status: "carried", from: "unmarked" });
  expect(await readStoreFormat(store)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, writtenBy: "0.9.0" });
  // Spent once carried; the backup never holds it.
  expect(readUpdateHandoff(store)).toBeUndefined();
  expect(await readdir(join(store, "format-backups"))).toHaveLength(1);
  // Moving the store away is a lost fence for anything still relying on it.
  await rename(store, `${store}-moved`);
  await mkdir(store, { mode: 0o700 });
  expect(hold!.check()).toBe(false);
}, 30000);

it("does not write the marker when the real fence is lost at commit time", async () => {
  const path = await selected();
  launch(path);
  const store = join(path, ".orca");
  await legacy(store);
  handOffStoreForUpdate(path, "0.8.0", "0.9.0");
  const owner = reserveFirstRunOwnership(path);
  const hold = await enterFirstRunWriter(path, store, owner.launchToken!());
  const authority = desktopCarryover(hold, "0.9.0")!;
  // Another reservation appears in the journal after the backup is published, just before the
  // marker: the writer is no longer the journal's latest, so its fence no longer holds.
  let checks = 0;
  const fence = {
    check: () => {
      if (++checks === 5) mkdirSync(join(path, OWNERSHIP_DIRECTORY, nextAttempt(path)), { mode: 0o700 });
      return hold!.check();
    },
  };
  await expect(open(store, "0.9.0", { ...authority, fence })).rejects.toMatchObject({ reason: "FENCE_LOST" });
  expect(checks).toBe(5);
  expect(await readStoreFormat(store)).toBeUndefined();
  expect((await readdir(store)).filter((name) => name.startsWith("store-format.json"))).toEqual([]);
  // The refusal's cleanup runs after the fence was lost: it must not touch the store either.
  expect(readUpdateHandoff(store)).toMatchObject({ claimHash: hold!.claimHash, attempts: 1 });
  await authority.settle("refused");
  expect(readUpdateHandoff(store)).toMatchObject({ claimHash: hold!.claimHash, attempts: 1 });
}, 30000);

it("settles only the exact handoff it claimed, and only while its fence holds", async () => {
  const path = await selected();
  launch(path);
  const store = join(path, ".orca");
  await legacy(store);
  handOffStoreForUpdate(path, "0.8.0", "0.9.0");
  const owner = reserveFirstRunOwnership(path);
  const hold = await enterFirstRunWriter(path, store, owner.launchToken!());
  const authority = desktopCarryover(hold, "0.9.0")!;
  // A record other than the one this writer claimed (here: rewritten by someone else) stays.
  const claimed = readUpdateHandoff(store)!;
  writeUpdateHandoff(store, { ...claimed, createdAt: "2026-01-01T00:00:00.000Z" });
  await authority.settle("refused");
  expect(readUpdateHandoff(store)).toMatchObject({ createdAt: "2026-01-01T00:00:00.000Z" });
  // The exact record, while the fence holds, is spent.
  writeUpdateHandoff(store, claimed);
  await authority.settle("refused");
  expect(readUpdateHandoff(store)).toBeUndefined();
  // Once the fence is lost (a later reservation), even the exact record is left alone.
  writeUpdateHandoff(store, claimed);
  mkdirSync(join(path, OWNERSHIP_DIRECTORY, nextAttempt(path)), { mode: 0o700 });
  expect(hold!.check()).toBe(false);
  await authority.settle("carried");
  expect(readUpdateHandoff(store)).toEqual(claimed);
}, 30000);

it("keeps refusing without the proof: another launch in between, or the version that was not installed", async () => {
  const path = await selected();
  launch(path);
  const store = join(path, ".orca");
  await legacy(store);
  handOffStoreForUpdate(path, "0.8.0", "0.9.0");
  // Anything launched after the updater stopped the daemon breaks the chain.
  launch(path);
  const owner = reserveFirstRunOwnership(path);
  const hold = await enterFirstRunWriter(path, store, owner.launchToken!());
  expect(desktopCarryover(hold, "0.9.0")).toBeUndefined();
  expect(desktopCarryover(hold, "0.8.0")).toBeUndefined();
  await expect(open(store, "0.9.0", undefined)).rejects.toMatchObject({ reason: "CARRYOVER_REQUIRED" });
  expect(await readStoreFormat(store)).toBeUndefined();
}, 30000);

it("is written only after an observed exit and withdrawn when nothing was installed", async () => {
  const path = await selected();
  const owner = reserveFirstRunOwnership(path);
  // A reservation with no settled exit is not an updater stop.
  expect(() => handOffStoreForUpdate(path, "0.8.0", "0.9.0")).toThrow("reconciliation");
  expect(inspectFirstRunOwnership(path, true).latest?.settled).toBe(false);
  void owner;
  const other = await selected();
  launch(other);
  handOffStoreForUpdate(other, "0.8.0", "0.9.0");
  withdrawUpdateHandoff(other);
  expect(readUpdateHandoff(join(other, ".orca"))).toBeUndefined();
}, 30000);
