/**
 * Runs the store workloads (#341) for one scale over one or more backends and returns a report.
 * Pure of import paths: the caller supplies `api` ({ store, core }), so run.js measures the
 * compiled packages and the self-test can run the same code against the sources.
 */
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { backends as allBackends } from "./backends.js";
import { SCALES } from "./scales.js";
import { round, timed } from "./stats.js";
import { seedDependencies, seedHistory, WORKLOADS } from "./workloads.js";

export const REPORT_SCHEMA_VERSION = 1;

export async function runBenchmark({
  api,
  backends = ["memory", "file"],
  scale: scaleName,
  seed = 341,
  repeat = 3,
  scratch,
  workloads = Object.keys(WORKLOADS),
  /** Backends beyond backends.js, by name; the self-test injects faulty ones through this. */
  extraBackends = {},
  log = () => {},
}) {
  const scale = SCALES[scaleName];
  if (!scale) throw new Error(`unknown scale ${scaleName}`);
  for (const w of workloads) if (!WORKLOADS[w]) throw new Error(`unknown workload ${w}`);
  const registry = { ...allBackends(api), ...extraBackends };
  await mkdir(scratch, { recursive: true });
  const report = { schemaVersion: REPORT_SCHEMA_VERSION, scale: scaleName, shape: scale, seed, repeat, results: [] };
  for (const name of backends) {
    const backend = registry[name];
    if (!backend) throw new Error(`unknown backend ${name}`);
    if (backend.unavailable) {
      report.results.push({ backend: name, status: "skipped", reason: backend.unavailable });
      continue;
    }
    const root = await mkdtemp(join(scratch, `orca-store-bench-${name}-`));
    try {
      const handle = await backend.create(join(root, "store"));
      const entry = { backend: name, durable: backend.durable, status: "ran", seeding: {}, workloads: {} };
      log(`${name}: seeding ${scaleName}`);
      const deps = await timed(() => seedDependencies({ api, handle, scale, seed }));
      const history = await timed(() => seedHistory({ api, handle, scale }));
      entry.seeding = {
        dependencies: { ...deps.value, ms: round(deps.ms) },
        history: {
          ...history.value,
          ms: round(history.ms),
          appendsPerSecond: round(history.value.events / (history.ms / 1000)),
        },
      };
      for (const w of workloads) {
        log(`${name}: ${w}`);
        const rssBefore = process.memoryUsage().rss;
        const run = await timed(() => WORKLOADS[w]({ api, backend, handle, root, scale, seed, repeat }));
        entry.workloads[w] = {
          ...run.value,
          wallMs: round(run.ms),
          rssDeltaBytes: process.memoryUsage().rss - rssBefore,
        };
      }
      if (backend.durable) entry.storeBytes = await bytesUnder(join(root, "store"));
      entry.checksPassed = allChecks(entry.workloads);
      await handle.dispose();
      report.results.push(entry);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  return report;
}

/** Every `checks` object anywhere in the results must be all true. */
export function allChecks(value) {
  if (!value || typeof value !== "object") return true;
  if (value.checks && Object.values(value.checks).some((ok) => ok !== true)) return false;
  return Object.values(value).every(allChecks);
}

async function bytesUnder(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await bytesUnder(path) : (await stat(path)).size;
  }
  return total;
}
