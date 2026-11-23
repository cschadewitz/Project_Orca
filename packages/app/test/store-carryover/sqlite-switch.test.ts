/**
 * The desktop app's switch of its own store to SQLite (#339), in place, under a real first-run
 * journal and kernel-lifetime writer fence: the daemon the app launched switches only while it
 * holds the fence, and a lost fence undoes everything.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { enterFirstRunWriter } from "@orca/protocol/first-run-fence";
import { recordedStoreBackend, SQLITE_SWITCH_DIR, StoreFormatError } from "@orca/store";
import { desktopSqliteSwitch } from "../../../cli/src/desktop-sqlite-switch.js";
import { OWNERSHIP_DIRECTORY, reserveFirstRunOwnership } from "../../src/main/first-run/ownership.js";
import {
  contents,
  expectFenced,
  expectReadsOnSqlite,
  populated,
} from "../../../store/test/fixtures/sqlite-store-fixture.js";
import { launch, selected } from "../first-run-compaction/fixture.js";

const nextAttempt = (path: string) => {
  const last = readdirSync(join(path, OWNERSHIP_DIRECTORY))
    .filter((name) => /^[0-9]{6}$/.test(name))
    .sort()
    .at(-1)!;
  return String(Number(last) + 1).padStart(6, "0");
};

/** The claim the daemon the app stopped for the switch wrote: the one this launch follows. */
const after = (hold: { previous: string | null }) => hold.previous!;

/** The app's workspace with a populated store on files, and its daemon entered as the writer. */
async function appWorkspace() {
  const path = await selected();
  launch(path); // An earlier daemon ran, and its exit was observed.
  const store = await populated(join(path, ".orca"));
  const owner = reserveFirstRunOwnership(path);
  const hold = await enterFirstRunWriter(path, store, owner.launchToken!());
  expect(hold?.check()).toBe(true);
  return { path, store, hold: hold! };
}

it.runIf(process.platform !== "win32")(
  "switches the app's own store in place while its daemon holds the fence",
  async () => {
    const { store, hold } = await appWorkspace();
    expect(await desktopSqliteSwitch(store, hold, "0.8.0", after(hold))).toEqual({ status: "switched" });
    expect(recordedStoreBackend(store)).toBe("sqlite");
    await expectFenced(store);
    await expectReadsOnSqlite(store);
    // Asked again: nothing to do.
    expect(await desktopSqliteSwitch(store, hold, "0.8.0", after(hold))).toEqual({ status: "current" });
  },
  30000,
);

const reserveAgain = (path: string) => mkdirSync(join(path, OWNERSHIP_DIRECTORY, nextAttempt(path)), { mode: 0o700 });

it.runIf(process.platform !== "win32")(
  "undoes everything and aborts the launch when the fence is lost before the marker",
  async () => {
    const { path, store, hold } = await appWorkspace();
    const before = await contents(store);
    // Another launch reserves the workspace while the legacy fence is in: this writer is no
    // longer the journal's latest, so it must neither publish the switch nor open the store.
    await expect(
      desktopSqliteSwitch(store, hold, "0.8.0", after(hold), { beforeMarker: async () => reserveAgain(path) }),
    ).rejects.toMatchObject({ code: "STORE_FORMAT", details: expect.objectContaining({ reason: "FENCE_LOST" }) });
    expect(hold.check()).toBe(false);
    expect(await contents(store)).toEqual(before);
    expect(recordedStoreBackend(store)).toBe("file");
    expect(await readdir(store)).not.toContain(SQLITE_SWITCH_DIR);
  },
  30000,
);

it.runIf(process.platform !== "win32")(
  "starts on files after a refusal only while the launch still holds the fence",
  async () => {
    const busy = () => {
      throw new StoreFormatError("BUSY", "a write landed", "x");
    };
    // Still the writer: the refusal is an outcome, and the daemon goes on on files.
    const kept = await appWorkspace();
    expect(
      await desktopSqliteSwitch(kept.store, kept.hold, "0.8.0", after(kept.hold), { beforeMarker: async () => busy() }),
    ).toMatchObject({ status: "refused", reason: "BUSY" });
    expect(recordedStoreBackend(kept.store)).toBe("file");
    // No longer the writer when refused: rolled back, and the launch is aborted.
    const lost = await appWorkspace();
    const before = await contents(lost.store);
    await expect(
      desktopSqliteSwitch(lost.store, lost.hold, "0.8.0", after(lost.hold), {
        afterFenceStep: async () => {
          reserveAgain(lost.path);
          busy();
        },
      }),
    ).rejects.toMatchObject({ details: expect.objectContaining({ reason: "FENCE_LOST" }) });
    expect(await contents(lost.store)).toEqual(before);
    expect(recordedStoreBackend(lost.store)).toBe("file");
  },
  30000,
);

it.runIf(process.platform !== "win32")(
  "refuses a request that does not name the claim this launch follows while the fence holds, changing nothing",
  async () => {
    const { store, hold } = await appWorkspace();
    expect(hold.previous).toMatch(/^[a-f0-9]{64}$/);
    const before = await contents(store);
    expect(await desktopSqliteSwitch(store, hold, "0.8.0", "c".repeat(64))).toMatchObject({
      status: "refused",
      reason: "SWITCH_REFUSED",
    });
    expect(await contents(store)).toEqual(before);
    expect(recordedStoreBackend(store)).toBe("file");
  },
  30000,
);

it.runIf(process.platform !== "win32")(
  "aborts the launch, changing nothing, when the fence is already lost at entry",
  async () => {
    const { path, store, hold } = await appWorkspace();
    reserveAgain(path);
    expect(hold.check()).toBe(false);
    const before = await contents(store);
    // Even with the right claim, and with a wrong one: a stale launch is never told to go on.
    for (const named of [after(hold), "c".repeat(64)])
      await expect(desktopSqliteSwitch(store, hold, "0.8.0", named)).rejects.toMatchObject({
        code: "STORE_FORMAT",
        details: expect.objectContaining({ reason: "FENCE_LOST" }),
      });
    expect(await contents(store)).toEqual(before);
    expect(recordedStoreBackend(store)).toBe("file");
    expect(await readdir(store)).not.toContain(SQLITE_SWITCH_DIR);
  },
  30000,
);

it("refuses, changing nothing, without the app's fence or on Windows", async () => {
  const plain = await populated();
  const before = await contents(plain);
  expect(await desktopSqliteSwitch(plain, undefined, "0.8.0", "a".repeat(64))).toMatchObject({
    status: "refused",
    reason: "SWITCH_REFUSED",
    message: expect.stringContaining("orca store sqlite convert"),
  });
  expect(await contents(plain)).toEqual(before);

  const windows = await populated();
  expect(
    await desktopSqliteSwitch(
      windows,
      { check: () => true, previous: "a".repeat(64) } as never,
      "0.8.0",
      "a".repeat(64),
      { platform: "win32" },
    ),
  ).toMatchObject({ status: "refused", reason: "UNDURABLE" });
  expect(recordedStoreBackend(windows)).toBe("file");
});
