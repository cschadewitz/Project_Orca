/** Pick where app-smoke's and desktop's Linux jobs run: Tyler's runners when one is idle, else GitHub-hosted. */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TYLER = ["self-hosted", "linux", "x64", "tyler"];
export const HOSTED = "ubuntu-24.04";

/** True for exactly one of the two runner choices above, so a caller can refuse anything else. */
export function isLinuxRunner(value) {
  return value === HOSTED || (Array.isArray(value) && JSON.stringify(value) === JSON.stringify(TYLER));
}

/**
 * The health service reports the repository's idle self-hosted runners as {"Project_Orca": N}.
 * These jobs do not wait on each other the way ci.yml's `check` waits on its shards, so one
 * idle runner is enough; a second job queues behind it instead of deadlocking.
 */
const LEGACY_HEALTH_KEY = "Project_Orca"; // rename-keep: the health service's key before the rename

export function chooseLinuxRunner({ forceHosted = false, body } = {}) {
  if (forceHosted) return { runner: HOSTED, reason: "CI_FORCE_HOSTED is true" };
  // Keyed by repository name: read either side of the Orrery rename until the service follows.
  const idle = body && typeof body === "object" ? (body.Project_Orca ?? body[LEGACY_HEALTH_KEY]) : undefined;
  if (!Number.isInteger(idle) || idle < 0) return { runner: HOSTED, reason: "no usable idle count" };
  if (idle < 1) return { runner: HOSTED, reason: "no idle self-hosted runner" };
  return { runner: TYLER, reason: `${idle} idle self-hosted runner(s)` };
}

/** Ask the health service; any failure (no URL, timeout, non-200, bad JSON) counts as zero idle. */
export async function pickLinuxRunner(env = process.env, fetchImpl = fetch) {
  const forceHosted = env.FORCE_HOSTED === "true";
  let body;
  if (!forceHosted && env.HEALTH_URL) {
    try {
      const response = await fetchImpl(env.HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      if (response.ok) body = await response.json();
    } catch {
      body = undefined;
    }
  }
  return chooseLinuxRunner({ forceHosted, body });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { runner, reason } = await pickLinuxRunner();
  console.log(`Linux runner: ${JSON.stringify(runner)} (${reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `runner=${JSON.stringify(runner)}\n`);
}
