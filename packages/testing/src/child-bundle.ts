/**
 * Test child processes as one prebuilt JavaScript file instead of TypeScript through tsx.
 *
 * A child launched with tsx transpiles its whole import graph on every start - the scripted
 * agent, a restoration worker, a crash script - which costs about a second a launch, and CI
 * launches hundreds. `childBundle` builds an entry once per test run with esbuild and hands
 * back the file to run with plain `node`, so every launch is still a fresh, real process.
 *
 * The run directory comes from `ORCA_TEST_BUNDLE_DIR`, which the root Vitest `globalSetup`
 * creates for each run and removes after it, so a bundle is never older than the run using
 * it. Without that variable (a test started some other way, or production) `childBundle`
 * returns `undefined` and the caller keeps launching through tsx. Builds are lazy: a run
 * pays only for the bundles its files ask for, once, whichever worker asks first.
 *
 * What a bundle changes for the code in it: `import.meta.url` is the bundle's, not the
 * source file's, so an entry that finds files relative to itself must take their paths as
 * arguments. Native addons cannot be bundled. Everything else - `@orca/*` through the repo
 * tsconfig's paths, and npm dependencies - is inlined, because the bundle lives outside the
 * repository and could not resolve them.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The run's bundle directory, set by the root Vitest `globalSetup`. */
export const CHILD_BUNDLE_DIR_ENV = "ORCA_TEST_BUNDLE_DIR";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface ChildBundleOptions {
  /** Output name → entry source path, absolute or relative to the repository root. */
  entries: Record<string, string>;
  /**
   * Share modules between entries in common chunks, for entries that load each other at run
   * time and must see one copy of a module (one `@orca/core`, so `instanceof` holds).
   */
  splitting?: boolean;
  /** Modules left to Node's resolution at run time. */
  external?: string[];
}

interface Compiler {
  buildSync(options: Record<string, unknown>): { errors: unknown[] };
}

const built = new Map<string, Record<string, string>>();

/**
 * Build `options.entries` once for this test run under `name`, and return each entry's
 * output file; `undefined` when no run directory is set. Synchronous, so a sync spec
 * builder such as `scriptedAgentSpec` can use it.
 */
export function childBundle(name: string, options: ChildBundleOptions): Record<string, string> | undefined {
  const runDir = process.env[CHILD_BUNDLE_DIR_ENV];
  if (!runDir) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid child bundle name: ${name}`);
  const key = `${runDir}\0${name}`;
  const cached = built.get(key);
  if (cached) return cached;
  const outdir = join(runDir, name);
  const files = Object.fromEntries(Object.keys(options.entries).map((entry) => [entry, join(outdir, `${entry}.mjs`)]));
  if (!existsSync(outdir)) build(outdir, options);
  built.set(key, files);
  return files;
}

function build(outdir: string, options: ChildBundleOptions): void {
  // Resolve esbuild through the already-declared tsx tool, as the compiled retry worker does,
  // rather than through a phantom root dependency.
  const require = createRequire(join(repoRoot, "package.json"));
  const compiler = createRequire(require.resolve("tsx/package.json"))("esbuild") as Compiler;
  // Another worker may be building the same bundle: each builds into its own directory and
  // the first rename wins; a loser drops its copy and uses the winner's identical one.
  const staging = `${outdir}.${process.pid}.${Date.now()}`;
  mkdirSync(staging, { recursive: true });
  try {
    compiler.buildSync({
      absWorkingDir: repoRoot,
      entryPoints: Object.fromEntries(
        Object.entries(options.entries).map(([entry, source]) => [entry, resolve(repoRoot, source)]),
      ),
      outdir: staging,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      splitting: options.splitting ?? false,
      platform: "node",
      format: "esm",
      target: `node${process.versions.node}`,
      keepNames: true,
      tsconfig: join(repoRoot, "tsconfig.json"),
      // CommonJS dependencies inlined into ESM still call `require`.
      banner: {
        js: "import { createRequire as __orcaCreateRequire } from 'node:module'; const require = __orcaCreateRequire(import.meta.url);",
      },
      external: ["bufferutil", "utf-8-validate", ...(options.external ?? [])],
      logLevel: "silent",
    });
    try {
      renameSync(staging, outdir);
    } catch (error) {
      if (!existsSync(outdir)) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`could not build the ${basename(outdir)} test child bundle: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
