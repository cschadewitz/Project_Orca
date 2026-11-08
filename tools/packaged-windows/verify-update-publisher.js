/** Require every packaged Windows app-update.yml to pin exactly the approved signing publisher. */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { parse } = createRequire(new URL("../../packages/app/package.json", import.meta.url))("yaml");

/**
 * The updater accepts a signature matching *any* listed publisher, so an extra entry is a
 * weaker policy, not a harmless one: the field must name the approved CN and nothing else.
 */
export function verifyUpdatePublisher(text, expected) {
  if (typeof expected !== "string" || !expected.trim()) throw new Error("An expected publisher is required");
  const config = parse(text);
  if (!config || typeof config !== "object") throw new Error("app-update.yml is not a mapping");
  const names = config.publisherName;
  const list = typeof names === "string" ? [names] : names;
  if (!Array.isArray(list) || list.length === 0) throw new Error("app-update.yml has no publisherName");
  if (list.length !== 1 || list[0] !== expected)
    throw new Error(
      `app-update.yml publisherName is ${JSON.stringify(list)}, expected exactly ${JSON.stringify([expected])}`,
    );
}

function findUpdateConfigs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findUpdateConfigs(path));
    else if (entry.isFile() && entry.name === "app-update.yml") found.push(path);
  }
  return found;
}

export function verifyPackagedUpdatePublishers(root, expected) {
  const configs = findUpdateConfigs(root);
  if (!configs.length) throw new Error(`No packaged app-update.yml under ${root}`);
  for (const path of configs) {
    try {
      verifyUpdatePublisher(readFileSync(path, "utf8"), expected);
    } catch (error) {
      throw new Error(`${path}: ${error.message}`, { cause: error });
    }
  }
  return configs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: "string" }, publisher: { type: "string" } } });
  if (!values.root) throw new Error("--root is required");
  for (const path of verifyPackagedUpdatePublishers(values.root, values.publisher))
    console.log(`app-update.yml names exactly the approved publisher: ${path}`);
}
