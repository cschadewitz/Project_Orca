#!/usr/bin/env node
/**
 * The automatic promotion schedule for the desktop feed, for feed-r2.sh schedule:
 *
 *   node tools/deploy/feed-schedule.js RINGS_FILE VERSION AGE_HOURS HALTED
 *
 * VERSION is what `internal` offers, AGE_HOURS how long ago its snapshot completed, HALTED 1
 * when someone halted one of its rollouts. Prints one `RING VERSION PERCENT` line per promotion
 * still due, in order; nothing when it is on schedule, halted, or overtaken by a newer version.
 * Each line is applied with the ordinary promotion rules (rings.js), so the schedule can only
 * move rings forward.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, emptyRings, isPrerelease, isVersion, promote, validateRings } from "./feed-worker/rings.js";

/** Hours after the snapshot completed. A release candidate never goes past preview. */
export const SCHEDULE = Object.freeze([
  { ring: "preview", percent: 100, after: 24 },
  { ring: "stable", percent: 20, after: 48 },
  { ring: "stable", percent: 100, after: 96 },
]);

const atLeast = (have, want) => have !== undefined && compareVersions(have, want) >= 0;

/** Whether `ring` already offers `version` to at least `percent`%, or has moved past it. */
function reached(rings, ring, version, percent) {
  const entry = rings.rings[ring] ?? {};
  if (atLeast(entry.version, version)) return true;
  const rollout = entry.rollout;
  if (!rollout) return false;
  const order = compareVersions(rollout.version, version);
  return order > 0 || (order === 0 && rollout.percent >= percent);
}

export function due(rings, version, ageHours, halted) {
  if (!isVersion(version)) throw new Error(`Invalid version: ${version}`);
  if (!Number.isFinite(ageHours) || ageHours < 0) throw new Error("age must be a number of hours");
  if (halted) return [];
  let state = validateRings(JSON.parse(JSON.stringify(rings)));
  const steps = [];
  for (const stage of SCHEDULE) {
    if (ageHours < stage.after) break;
    if (stage.ring === "stable" && isPrerelease(version)) break;
    if (reached(state, stage.ring, version, stage.percent)) continue;
    state = promote(state, stage.ring, version, stage.percent).rings;
    steps.push([stage.ring, version, stage.percent]);
  }
  return steps;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, version, age, halted] = process.argv.slice(2);
    if (!file || !version || age === undefined || !["0", "1"].includes(halted))
      throw new Error("usage: feed-schedule.js RINGS_FILE VERSION AGE_HOURS HALTED(0|1)");
    const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    const rings = text ? JSON.parse(text) : emptyRings();
    for (const step of due(rings, version, Number(age), halted === "1")) console.log(step.join(" "));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
