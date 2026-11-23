/**
 * Name another store in a workspace's config (`storeDir`), durably: how `orca store sqlite
 * convert` (#339) puts a converted store in use. The rename of the rewritten file is the one
 * step that makes every ORCA started afterwards, released ones included, open the new store.
 *
 * YAML is edited as a document, so comments and layout around `storeDir` stay as they were; JSON
 * is rewritten with two-space indentation. A workspace without a config file gets
 * `orca.config.yaml`, holding just the version and the store. The result must parse as a config
 * naming exactly `value`, or nothing is written. The write is conditional (`expected`), under the
 * same lock and revision rule as the daemon's `config.set`, so it never undoes an edit made while
 * the store was being converted.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { OrcaError, parseOrcaConfig } from "@orca/core";
import { withFileLock } from "@orca/store";
import { CONFIG_FILENAMES } from "./bootstrap.js";

export const NEW_CONFIG_FILENAME = "orca.config.yaml";

/** What a config held when it was read: its bytes' hash, or `null` when there was no file. */
export type ConfigRevision = string | null;

export const configRevision = (text: string | undefined): ConfigRevision =>
  text === undefined ? null : createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Write `storeDir: value` into `configFile` (or a new config in `configDir`), under the config
 * writer's lock (`<file>.lock`, the one `config.set` takes), and only if the file is still the
 * revision it was read at (`expected`) and still names `source` as the store: otherwise
 * `CONFIG_STALE`, and nothing is written. Returns the file written.
 */
export async function writeConfigStoreDir(
  configFile: string | undefined,
  configDir: string,
  value: string,
  expected: { revision: ConfigRevision; source: string },
  /** Tests: runs just before a new config is created, where another writer could get in. */
  hooks: { beforeCreate?: () => Promise<void> } = {},
): Promise<string> {
  const file = configFile ?? join(configDir, NEW_CONFIG_FILENAME);
  return withFileLock(`${file}.lock`, async () => {
    const saved = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const stale = (why: string) =>
      new OrcaError(
        "CONFIG_STALE",
        `${file} ${why} since the conversion began, so it was not changed. The converted store was left in place; run the conversion again to put it in use.`,
        { file },
      );
    if (configRevision(saved) !== expected.revision) throw stale(saved === undefined ? "was removed" : "changed");
    // Without a config, the workspace is the directory with none of the names a config may have.
    if (!configFile) {
      const present = await configsIn(configDir);
      if (present.length) throw stale(`gained ${present[0]}`);
    }
    const current = saved === undefined ? {} : file.endsWith(".json") ? JSON.parse(saved) : parseYaml(saved);
    if (resolve(configDir, parseOrcaConfig(current).storeDir) !== expected.source)
      throw stale(`names another store than ${expected.source}`);
    if (configFile) return writeLocked(file, configFile, saved, value);
    // A new config: created only if absent (a link fails on an existing name, where a rename
    // would replace it), and only while it is the one config the workspace has; otherwise the
    // late arrival wins, ours goes, and nothing is published.
    await hooks.beforeCreate?.();
    await createNew(file, value, () => stale(`was created by someone else`));
    const others = (await configsIn(configDir)).filter((name) => join(configDir, name) !== file);
    if (others.length) {
      await rm(file, { force: true });
      await syncParent(file);
      throw stale(`gained ${others[0]}`);
    }
    return file;
  });
}

/** The config file names present in `dir`; a stat failure other than absence is an error. */
async function configsIn(dir: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of CONFIG_FILENAMES)
    try {
      await stat(join(dir, name));
      present.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  return present;
}

/** Create `file` holding a minimal config, atomically and only if absent. */
async function createNew(file: string, value: string, conflict: () => Error): Promise<void> {
  const text = `version: 1\nstoreDir: ${JSON.stringify(value)}\n`;
  if (parseOrcaConfig(parseYaml(text)).storeDir !== value)
    throw new OrcaError("CONFIG_INVALID", `${file}: the new config does not name ${value} as its store`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", 0o644);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict();
      throw error;
    }
  } finally {
    await rm(tmp, { force: true });
  }
  await syncParent(file);
}

async function syncParent(file: string): Promise<void> {
  if (process.platform === "win32") return;
  const dir = await open(dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function writeLocked(
  file: string,
  configFile: string,
  saved: string | undefined,
  value: string,
): Promise<string> {
  let text: string;
  let mode = 0o644;
  if (saved !== undefined) {
    mode = (await stat(configFile)).mode & 0o777;
    if (configFile.endsWith(".json")) {
      const raw = JSON.parse(saved) as Record<string, unknown>;
      text = JSON.stringify({ ...raw, storeDir: value }, null, 2) + "\n";
    } else {
      const doc = parseDocument(saved);
      if (doc.errors.length) throw new OrcaError("CONFIG_INVALID", `${configFile}: ${doc.errors[0]!.message}`);
      doc.set("storeDir", value);
      text = doc.toString();
    }
  } else text = `version: 1\nstoreDir: ${JSON.stringify(value)}\n`;
  const parsed = parseOrcaConfig(file.endsWith(".json") ? JSON.parse(text) : parseYaml(text));
  if (parsed.storeDir !== value)
    throw new OrcaError("CONFIG_INVALID", `${file}: the rewritten config does not name ${value} as its store`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await syncParent(file);
  return file;
}
