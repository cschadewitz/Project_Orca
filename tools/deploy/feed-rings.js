#!/usr/bin/env node
/**
 * Apply one ring transition to a local copy of the feed's rings.json, for the release jobs:
 *
 *   node tools/deploy/feed-rings.js FILE publish VERSION
 *   node tools/deploy/feed-rings.js FILE promote RING VERSION PERCENT
 *   node tools/deploy/feed-rings.js FILE publish-server VERSION
 *   node tools/deploy/feed-rings.js FILE promote-server RING VERSION PERCENT
 *   node tools/deploy/feed-rings.js FILE stop-servers | resume-servers
 *   node tools/deploy/feed-rings.js FILE show
 *
 * `publish` and `promote` move the desktop channel, the `-server` forms the server bundle
 * channel (#877); both live in the same rings.json. `stop-servers` sets the servers' stop
 * switch (#878) and `resume-servers` lifts it. `show` prints FILE's ring state, validated,
 * on one line without changing it (the empty state when FILE is missing or empty).
 * A missing or empty FILE starts from no rings. The file is rewritten only on success, and the
 * outcome is printed for the job summary. The rules live in feed-worker/rings.js.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyRings, promote, publish, resumeServers, stopServers, validateRings } from "./feed-worker/rings.js";

export function run(argv) {
  const [file, action, ...rest] = argv;
  const usage =
    "usage: feed-rings.js FILE publish VERSION | promote RING VERSION PERCENT | publish-server VERSION | promote-server RING VERSION PERCENT | stop-servers | resume-servers | show";
  if (!file) throw new Error(usage);
  const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  const rings = text ? validateRings(JSON.parse(text)) : emptyRings();
  let result;
  if (action === "show" && rest.length === 0) return JSON.stringify(rings);
  if (action === "stop-servers" && rest.length === 0) result = stopServers(rings);
  else if (action === "resume-servers" && rest.length === 0) result = resumeServers(rings);
  if (result) {
    writeFileSync(file, `${JSON.stringify(result.rings, null, 2)}\n`);
    return result.message;
  }
  const channel = action?.endsWith("-server") ? "server" : "desktop";
  const verb = action?.replace(/-server$/, "");
  if (verb === "publish" && rest.length === 1) result = publish(rings, rest[0], channel);
  else if (verb === "promote" && rest.length === 3 && /^\d+$/.test(rest[2]))
    result = promote(rings, rest[0], rest[1], Number(rest[2]), channel);
  else throw new Error(usage);
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
