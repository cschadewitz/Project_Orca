/**
 * Naming a converted store in a workspace's config (#339): conditional on the config being the
 * revision it was read at and still naming the source, under the config writer's lock, so an edit
 * made while a store was converted is never undone.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configRevision, writeConfigStoreDir } from "../src/config-store-dir.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-config-store-dir-"));
  dirs.push(dir);
  return dir;
}
const stale = { code: "CONFIG_STALE" };

describe("writeConfigStoreDir", () => {
  it("names the new store, keeping the rest of the file, when nothing changed meanwhile", async () => {
    const dir = await workspace();
    const file = join(dir, "orca.config.yaml");
    const text = "# notes\nversion: 1 # keep\nstoreDir: .orca\n";
    await writeFile(file, text);
    await writeConfigStoreDir(file, dir, ".orca-sqlite", {
      revision: configRevision(text),
      source: join(dir, ".orca"),
    });
    expect(await readFile(file, "utf8")).toBe("# notes\nversion: 1 # keep\nstoreDir: .orca-sqlite\n");
    expect(await readdir(dir)).toEqual(["orca.config.yaml"]);
  });

  it("refuses, writing nothing, when the config was edited after it was read", async () => {
    const dir = await workspace();
    const file = join(dir, "orca.config.yaml");
    const text = "version: 1\n";
    await writeFile(file, text);
    const edited = "version: 1\nagents: []\n";
    await writeFile(file, edited);
    await expect(
      writeConfigStoreDir(file, dir, ".orca-sqlite", { revision: configRevision(text), source: join(dir, ".orca") }),
    ).rejects.toMatchObject(stale);
    expect(await readFile(file, "utf8")).toBe(edited);
  });

  it("refuses when the config names another store than the one converted", async () => {
    const dir = await workspace();
    const file = join(dir, "orca.config.yaml");
    const text = "version: 1\nstoreDir: elsewhere\n";
    await writeFile(file, text);
    await expect(
      writeConfigStoreDir(file, dir, ".orca-sqlite", { revision: configRevision(text), source: join(dir, ".orca") }),
    ).rejects.toMatchObject(stale);
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("creates a config only where there still is none", async () => {
    const dir = await workspace();
    await writeConfigStoreDir(undefined, dir, ".orca-sqlite", { revision: null, source: join(dir, ".orca") });
    expect(await readFile(join(dir, "orca.config.yaml"), "utf8")).toBe('version: 1\nstoreDir: ".orca-sqlite"\n');

    // One appeared meanwhile, under this name or another a config may have.
    for (const name of ["orca.config.yaml", "orca.config.json"]) {
      const other = await workspace();
      const text = name.endsWith(".json") ? '{"version":1}' : "version: 1\n";
      await writeFile(join(other, name), text);
      await expect(
        writeConfigStoreDir(undefined, other, ".orca-sqlite", { revision: null, source: join(other, ".orca") }),
      ).rejects.toMatchObject(stale);
      expect(await readdir(other), name).toEqual([name]);
      expect(await readFile(join(other, name), "utf8")).toBe(text);
    }
  });
});
