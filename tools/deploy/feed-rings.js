#!/usr/bin/env node
/**
 * Apply one ring transition to a local copy of the feed's rings.json, for the release jobs:
 *
 *   node tools/deploy/feed-rings.js FILE publish VERSION
 *   node tools/deploy/feed-rings.js FILE promote RING VERSION PERCENT
 *
 * A missing or empty FILE starts from no rings. The file is rewritten only on success, and the
 * outcome is printed for the job summary. The rules live in feed-worker/rings.js.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyRings, promote, publish, validateRings } from "./feed-worker/rings.js";

export function run(argv) {
  const [file, action, ...rest] = argv;
  if (!file) throw new Error("usage: feed-rings.js FILE publish VERSION | promote RING VERSION PERCENT");
  const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  const rings = text ? validateRings(JSON.parse(text)) : emptyRings();
  let result;
  if (action === "publish" && rest.length === 1) result = publish(rings, rest[0]);
  else if (action === "promote" && rest.length === 3 && /^\d+$/.test(rest[2]))
    result = promote(rings, rest[0], rest[1], Number(rest[2]));
  else throw new Error("usage: feed-rings.js FILE publish VERSION | promote RING VERSION PERCENT");
  writeFileSync(file, `${JSON.stringify(result.rings, null, 2)}\n`);
  return result.message;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
