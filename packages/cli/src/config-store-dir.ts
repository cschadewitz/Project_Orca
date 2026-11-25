/**
 * Name another store in a workspace's existing config (`storeDir`), durably: how `orca store
 * sqlite convert` (#339) puts a converted store in use. The rename of the rewritten file is the
 * one step that makes every ORCA started afterwards, released ones included, open the new store.
 *
 * YAML is edited as a document, so comments and layout around `storeDir` stay as they were; JSON
 * is rewritten with two-space indentation. The result must parse as a config naming exactly
 * `value`, or nothing is written. The write is conditional (`expected`), under the same lock and
 * revision rule as the daemon's `config.set`, so it never undoes an edit made while the store was
 * being converted. A config is never created here: a new one would be published before it could
 * be checked against the other names a config may have, and could not be taken back.
 */
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { OrcaError, parseOrcaConfig } from "@orca/core";
import { CONFIG_FILE_LOCK, withFileLock } from "@orca/store";
import { CONFIG_FILENAMES, LEGACY_CONFIG_FILENAMES } from "./bootstrap.js";

/** What a config held when it was read: its bytes' hash. */
export type ConfigRevision = string;

export const configRevision = (text: string): ConfigRevision => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Write `storeDir: value` into `file`, under the config writer's lock (`<file>.lock`, the one
 * `config.set` takes), and only if the file is still the revision it was read at (`expected`) and
 * still names `source` as the store: otherwise `CONFIG_STALE`, and nothing is written. Returns
 * the file written.
 */
export async function writeConfigStoreDir(
  file: string,
  configDir: string,
  value: string,
  expected: { revision: ConfigRevision; source: string },
): Promise<string> {
  return withFileLock(
    `${file}.lock`,
    async () => {
      const stale = (why: string) =>
        new OrcaError(
          "CONFIG_STALE",
          `${file} ${why} since the conversion began, so it was not changed. The converted store was left in place; run the conversion again to put it in use.`,
          { file },
        );
      const saved = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw stale("was removed");
        throw error;
      });
      if (configRevision(saved) !== expected.revision) throw stale("changed");
      const others = await otherConfigs(file);
      if (others.length) throw stale(`has ${others[0]} beside it`);
      const current = file.endsWith(".json") ? JSON.parse(saved) : parseYaml(saved);
      if (resolve(configDir, parseOrcaConfig(current).storeDir) !== expected.source)
        throw stale(`names another store than ${expected.source}`);
      return writeLocked(file, saved, value);
    },
    CONFIG_FILE_LOCK,
  );
}

/**
 * The other names a config may have that are present beside `file`. With more than one, which
 * config an ORCA opens depends on how it was started, so none is changed.
 */
export async function otherConfigs(file: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of new Set([...CONFIG_FILENAMES, ...LEGACY_CONFIG_FILENAMES])) {
    if (name === basename(file)) continue;
    try {
      await stat(join(dirname(file), name));
      present.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return present;
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

async function writeLocked(file: string, saved: string, value: string): Promise<string> {
  const mode = (await stat(file)).mode & 0o777;
  let text: string;
  if (file.endsWith(".json")) {
    const raw = JSON.parse(saved) as Record<string, unknown>;
    text = JSON.stringify({ ...raw, storeDir: value }, null, 2) + "\n";
  } else {
    const doc = parseDocument(saved);
    if (doc.errors.length) throw new OrcaError("CONFIG_INVALID", `${file}: ${doc.errors[0]!.message}`);
    doc.set("storeDir", value);
    text = doc.toString();
  }
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
