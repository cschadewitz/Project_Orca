/**
 * Name another store in a workspace's config (`storeDir`), durably: how `orca store sqlite
 * convert` (#339) puts a converted store in use. The rename of the rewritten file is the one
 * step that makes every ORCA started afterwards, released ones included, open the new store.
 *
 * YAML is edited as a document, so comments and layout around `storeDir` stay as they were; JSON
 * is rewritten with two-space indentation. A workspace without a config file gets
 * `orca.config.yaml`, holding just the version and the store. The result must parse as a config
 * naming exactly `value`, or nothing is written.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { OrcaError, parseOrcaConfig } from "@orca/core";

export const NEW_CONFIG_FILENAME = "orca.config.yaml";

/** Write `storeDir: value` into `configFile` (or a new config in `configDir`); returns the file written. */
export async function writeConfigStoreDir(
  configFile: string | undefined,
  configDir: string,
  value: string,
): Promise<string> {
  const file = configFile ?? join(configDir, NEW_CONFIG_FILENAME);
  let text: string;
  let mode = 0o644;
  if (configFile) {
    const saved = await readFile(configFile, "utf8");
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
  if (process.platform !== "win32") {
    const dir = await open(dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  return file;
}
