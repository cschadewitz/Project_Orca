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
import { recordedStoreBackend, SQLITE_SWITCH_DIR } from "@orca/store";
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
    expect(await desktopSqliteSwitch(store, hold, "0.8.0")).toEqual({ status: "switched" });
    expect(recordedStoreBackend(store)).toBe("sqlite");
    await expectFenced(store);
    await expectReadsOnSqlite(store);
    // Asked again: nothing to do.
    expect(await desktopSqliteSwitch(store, hold, "0.8.0")).toEqual({ status: "current" });
  },
  30000,
);

it.runIf(process.platform !== "win32")(
  "undoes everything when the fence is lost before the marker",
  async () => {
    const { path, store, hold } = await appWorkspace();
    const before = await contents(store);
    // Another launch reserves the workspace while the legacy fence is in: this writer is no longer
    // the journal's latest, so it must not publish the switch.
    const outcome = await desktopSqliteSwitch(store, hold, "0.8.0", {
      beforeMarker: async () => {
        mkdirSync(join(path, OWNERSHIP_DIRECTORY, nextAttempt(path)), { mode: 0o700 });
      },
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "FENCE_LOST" });
    expect(hold.check()).toBe(false);
    expect(await contents(store)).toEqual(before);
    expect(recordedStoreBackend(store)).toBe("file");
    expect(await readdir(store)).not.toContain(SQLITE_SWITCH_DIR);
  },
  30000,
);

it("refuses, changing nothing, without the app's fence or on Windows", async () => {
  const plain = await populated();
  const before = await contents(plain);
  expect(await desktopSqliteSwitch(plain, undefined, "0.8.0")).toMatchObject({
    status: "refused",
    reason: "SWITCH_REFUSED",
    message: expect.stringContaining("orca store sqlite convert"),
  });
  expect(await contents(plain)).toEqual(before);

  const windows = await populated();
  expect(
    await desktopSqliteSwitch(windows, { check: () => true } as never, "0.8.0", { platform: "win32" }),
  ).toMatchObject({ status: "refused", reason: "UNDURABLE" });
  expect(recordedStoreBackend(windows)).toBe("file");
});
