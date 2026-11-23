/** Crash ordering of a carryover: what is durable before the backup is published and before the marker (#897). */
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const events: string[] = [];
let crashAt: string | undefined;
const note = (event: string) => {
  events.push(event);
  if (crashAt && event.startsWith(crashAt)) throw new Error(`crash at ${event}`);
};
vi.mock("../src/durable-file.js", async (original) => {
  const real = await original<typeof import("../src/durable-file.js")>();
  return {
    createCopy: async (source: string, target: string) => {
      await real.createCopy(source, target);
      note(`copy ${basename(target)}`);
    },
    createDurable: async (path: string, text: string) => {
      await real.createDurable(path, text);
      note(`durable ${basename(path).startsWith("store-format.json") ? "marker-tmp" : basename(path)}`);
    },
    syncDirectory: async (path: string) => {
      await real.syncDirectory(path);
      const name = basename(path);
      note(
        `sync-dir ${name === ".orca" ? "store" : name === "format-backups" ? "backups" : name.startsWith(".partial") ? "partial" : name}`,
      );
    },
    syncFile: real.syncFile,
  };
});
const { carryStoreForward, readStoreFormat, STORE_FORMAT_BACKUP_DIR } = await import("../src/index.js");

const legacy = async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "orca-store-durable-")), ".orca");
  await mkdir(join(dir, "runs"), { recursive: true });
  await writeFile(join(dir, "runs", "run_old.jsonl"), "");
  await writeFile(join(dir, ".workspace-identified"), "1\n");
  return dir;
};

describe("carryover crash ordering (#897)", () => {
  it("flushes the copy, then its manifest, publishes it durably, and only then writes the marker durably", async () => {
    events.length = 0;
    crashAt = undefined;
    const dir = await legacy();
    await carryStoreForward(dir, { appVersion: "0.8.0" });
    const at = (event: string) => {
      const index = events.indexOf(event);
      expect(index, event).toBeGreaterThanOrEqual(0);
      return index;
    };
    // The backup's own copy (the first), its manifest, the staging folder, then publication.
    const firstCopy = at("copy run_old.jsonl");
    expect(firstCopy).toBeLessThan(at("durable format-backup.json"));
    const manifest = at("durable format-backup.json");
    expect(events.indexOf("sync-dir partial", manifest)).toBeGreaterThan(manifest);
    const published = events.lastIndexOf("sync-dir backups");
    expect(events.lastIndexOf("durable format-backup.json")).toBeLessThan(published);
    // The marker is written and flushed after the published backup, and its rename flushed last.
    expect(published).toBeLessThan(at("durable marker-tmp"));
    expect(events.at(-1)).toBe("sync-dir store");
  });

  it.each(["durable format-backup.json", "sync-dir backups", "durable marker-tmp"])(
    "leaves the prior format in charge when the process dies at %s",
    async (point) => {
      events.length = 0;
      crashAt = point;
      const dir = await legacy();
      await expect(carryStoreForward(dir, { appVersion: "0.8.0" })).rejects.toThrow(`crash at ${point}`);
      expect(await readStoreFormat(dir)).toBeUndefined();
      crashAt = undefined;
      // The next start carries it forward and clears any scratch the crash left.
      expect((await carryStoreForward(dir, { appVersion: "0.8.0" })).status).toBe("carried");
      expect((await readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).filter((n) => n.startsWith("."))).toEqual([]);
    },
  );
});
