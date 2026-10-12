/**
 * How a restoration worker is started. Parent-side only: `fixture.ts` imports this lazily and
 * `worker.ts` never does, so the worker's own module graph stays free of `@orca/testing`.
 *
 * Every case forks a fresh process, and transpiling the worker's module graph through tsx
 * costs about a second a launch. Under the test runner the worker is built once for the run
 * (`childBundle`) and started with plain `node`; with no run directory it is started from its
 * TypeScript sources through tsx, as before. Either way each launch is a new, real process.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { childBundle } from "@orca/testing/child-bundle";

const workerSource = fileURLToPath(new URL("worker.ts", import.meta.url));
const jevAdapterSource = fileURLToPath(new URL("../../../integrations/src/jev/plugin.ts", import.meta.url));

export interface WorkerLaunch {
  /** The file `fork` runs. */
  script: string;
  execArgv: string[];
  /** The module a generated JEV `plugin.mjs` imports `createRestorableJevEvalPlugin` from. */
  jevAdapter: string;
}

export function workerLaunch(): WorkerLaunch {
  // The worker and the JEV adapter are built together with shared chunks. A generated plugin
  // imports the adapter by file URL, so a separately bundled adapter would carry its own copy
  // of `@orca/core` and the worker's `instanceof OrcaError` checks would stop holding for
  // errors the adapter throws.
  const bundled = childBundle("restoration-worker", {
    entries: { worker: workerSource, "jev-adapter": jevAdapterSource },
    splitting: true,
  });
  if (bundled)
    return { script: bundled.worker!, execArgv: [], jevAdapter: pathToFileURL(bundled["jev-adapter"]!).href };
  return { script: workerSource, execArgv: ["--import", "tsx"], jevAdapter: pathToFileURL(jevAdapterSource).href };
}
