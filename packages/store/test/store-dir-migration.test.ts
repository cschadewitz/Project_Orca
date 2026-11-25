import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptLegacyStoreDir,
  holdStoreWriter,
  LEGACY_STORE_DIR_NAME,
  STORE_DIR_NAME,
  STORE_FORMAT_LOCK,
  STORE_SWITCH_FILE,
  withFileLock,
} from "@orca/store";

/** A workspace from before the rename: its store under the old name. */
function preRenameWorkspace(): { workspace: string; legacy: string; store: string } {
  const workspace = mkdtempSync(join(tmpdir(), "store-dir-migration-"));
  const legacy = join(workspace, ".orca"); // rename-keep: the old store name is the fixture
  mkdirSync(join(legacy, "runs"), { recursive: true });
  writeFileSync(join(legacy, "runs", "r1.jsonl"), '{"type":"run.created"}\n');
  return { workspace, legacy, store: join(workspace, ".orrery") };
}

const quiet = () => {};

describe("moving a store from its name before the rename", () => {
  it("moves it once, under the format lock, and leaves a symlink at the old name", async () => {
    const { legacy, store } = preRenameWorkspace();
    expect(await adoptLegacyStoreDir(store, { legacyDir: legacy, pointer: "symlink", warn: quiet })).toBe(store);
    expect(readFileSync(join(store, "runs", "r1.jsonl"), "utf8")).toBe('{"type":"run.created"}\n');
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readlinkSync(legacy)).toBe(".orrery");
    expect(readFileSync(join(legacy, "runs", "r1.jsonl"), "utf8")).toBe('{"type":"run.created"}\n');
    // Nothing of the move is left behind: no announcement, and the lock is free at once.
    expect(existsSync(join(store, STORE_SWITCH_FILE))).toBe(false);
    expect(existsSync(join(store, STORE_FORMAT_LOCK))).toBe(false);
    await withFileLock(join(store, STORE_FORMAT_LOCK), async () => undefined, { timeoutMs: 100 });
    // A second start finds the store where it is now.
    expect(await adoptLegacyStoreDir(store, { legacyDir: legacy, warn: quiet })).toBe(store);
  });

  it("leaves a marker file instead where a symlink is not made (Windows)", async () => {
    const { legacy, store } = preRenameWorkspace();
    expect(await adoptLegacyStoreDir(store, { legacyDir: legacy, pointer: "marker", warn: quiet })).toBe(store);
    expect(lstatSync(legacy).isFile()).toBe(true);
    expect(readFileSync(legacy, "utf8")).toContain(store);
    expect(existsSync(join(store, STORE_FORMAT_LOCK))).toBe(false);
  });

  it("leaves the old directory untouched and opens it there while a writer has it open", async () => {
    const { legacy, store } = preRenameWorkspace();
    const hold = holdStoreWriter(legacy, { appVersion: "0.8.0", purpose: "daemon" });
    try {
      const warnings: string[] = [];
      expect(await adoptLegacyStoreDir(store, { legacyDir: legacy, warn: (m) => warnings.push(m) })).toBe(legacy);
      expect(warnings.join("\n")).toMatch(/opening it where it is/);
    } finally {
      hold.release();
    }
    expect(existsSync(store)).toBe(false);
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(existsSync(join(legacy, STORE_SWITCH_FILE))).toBe(false);
    expect(existsSync(join(legacy, STORE_FORMAT_LOCK))).toBe(false);
  });

  it("leaves the old directory alone when the new one already exists, and moves nothing it was not asked to", async () => {
    const { workspace, legacy, store } = preRenameWorkspace();
    mkdirSync(store);
    expect(await adoptLegacyStoreDir(store, { legacyDir: legacy, warn: quiet })).toBe(store);
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    // A store the config names otherwise is the user's, wherever an old one sits.
    expect(await adoptLegacyStoreDir(join(workspace, "custom-store"), { warn: quiet })).toBe(
      join(workspace, "custom-store"),
    );
  });

  it("resolves the old name beside a store under the default name", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "store-dir-default-"));
    mkdirSync(join(workspace, LEGACY_STORE_DIR_NAME));
    const store = join(workspace, STORE_DIR_NAME);
    expect(await adoptLegacyStoreDir(store, { warn: quiet })).toBe(store);
    expect(lstatSync(store).isDirectory()).toBe(true);
  });
});
