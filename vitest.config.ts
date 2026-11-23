/** Vitest setup: `@orca/*` resolves to package sources, so tests never depend on a build. */
import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const src = (name: string, module: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/${module}.ts`, import.meta.url));
const pkg = (name: string) => src(name, "index");

export default defineConfig({
  resolve: {
    // A string alias is a prefix match, so the `@orca/core/schemas` subpath has to come
    // before `@orca/core` or it would be rewritten to `…/src/index.ts/schemas`.
    alias: {
      "@orca/core/schemas": src("core", "schemas"),
      "@orca/core": pkg("core"),
      "@orca/store": pkg("store"),
      "@orca/agents/judge-budget": src("agents", "review-judge/judge-budget"),
      "@orca/agents": pkg("agents"),
      "@orca/engine": pkg("engine"),
      "@orca/testing/child-bundle": src("testing", "child-bundle"),
      "@orca/testing/two-daemons": src("testing", "two-daemons"),
      "@orca/testing/two-machines": src("testing", "two-machines"),
      "@orca/testing": pkg("testing"),
      "@orca/integrations/mcp": src("integrations", "mcp/index"),
      "@orca/integrations": pkg("integrations"),
      "@orca/protocol/update-window": src("protocol", "update-window"),
      "@orca/protocol/first-run-fence": src("protocol", "first-run-fence"),
      "@orca/protocol/update-handoff": src("protocol", "update-handoff"),
      "@orca/protocol/remote-access": src("protocol", "remote-access"),
      "@orca/protocol/server-setup": src("protocol", "server-setup"),
      "@orca/protocol": pkg("protocol"),
      "@orca/daemon": pkg("daemon"),
      "@orca/design": pkg("design"),
    },
  },
  test: {
    // The renderer is its own TypeScript project (DOM lib, bundler resolution), so its
    // tests live next to it rather than in packages/app/test. `tools/` is plain JavaScript
    // with no build step — scripts CI and the release workflows run directly — so its tests
    // are JavaScript too, and stay out of the workspace's tsconfig like the scripts do.
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/app/renderer/test/**/*.test.{ts,tsx}",
      "tools/test/**/*.test.js",
    ],
    // One directory per run that test child processes are prebuilt into, instead of each
    // launch transpiling its TypeScript through tsx (packages/testing/src/child-bundle.ts).
    globalSetup: ["./vitest.global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Vitest's default is one worker per core less one, so the suite's memory footprint is a
    // property of whatever machine it lands on and nothing bounds what two concurrent runs
    // cost. On 2026-09-20 two agents ran the suite at once on an 8-core box and the kernel
    // OOM-killed both of them mid-run, losing uncommitted work. Measured there: 8 workers is
    // 45s at 3,249 MB peak, 4 is 50s at 2,217 MB — 11% slower for a third less memory,
    // because the suite is startup- and I/O-bound well before it is CPU-bound.
    //
    // `min` with the default, not a bare 4, and that distinction is load-bearing: a plain 4
    // RAISES the worker count on a 2- or 4-core CI runner, where the default is 1 or 3. The
    // first cut of this did exactly that and reddened CI with two timeout-shaped flakes it
    // had made more likely. This can only ever reduce concurrency, never add to it.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? Math.min(4, Math.max(1, availableParallelism() - 1))),
    coverage: {
      provider: "v8",
      // Every source file, not just the ones a test happened to import: a module nobody
      // covers shows up as 0%, rather than being missing from the report.
      include: ["packages/*/src/**/*.ts", "packages/app/renderer/src/**/*.{ts,tsx}"],
      // Barrels re-export and nothing else. `testing` (the scripted agent) is test
      // infrastructure, and the e2e tests drive it as a real subprocess - v8 coverage
      // collected in this process cannot see any of it, so its number would be fiction.
      // The app's main and preload processes only run inside Electron; its daemon client
      // and preferences are plain Node and are covered. The design package's src is
      // generated tokens and a documentation-only .d.ts; its tests check the JSON sources,
      // not the output.
      //
      // The renderer is in the include as of #154, with its own thresholds below. Two of
      // its modules are not: `renderer/src/main.tsx` is the entry point, which only ever
      // runs inside a real Electron window (the smoke test is what exercises it), and
      // `renderer/src/preview` is the dev-build `#preview` route - a gallery of the
      // primitives, not app code, and the thing a person looks at rather than a test.
      exclude: [
        "packages/*/src/index.ts",
        "**/main.ts",
        "packages/testing/**",
        "packages/app/src/main/**",
        "packages/app/src/preload/**",
        "packages/design/src/**",
        "packages/app/renderer/src/main.tsx",
        "packages/app/renderer/src/preview/**",
      ],
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      // Ratchets, each set just under what the suite covers today. Raise them as coverage
      // improves; never lower one to make a red CI go green.
      //
      // The bare numbers are the whole report; the glob keys are *extra* checks on a
      // subset, not a partition of it (a file under a glob is still counted globally
      // too). packages/app gets its own so it cannot coast on the engine's coverage, and
      // its two halves are separate entries because they are tested in different
      // environments - the renderer in happy-dom, the Node side as plain modules - and
      // regress independently.
      thresholds: {
        // The whole report: 89.3 / 78.3 / 90.0 / 92.1 today. These sat at 78/65/80/81 until
        // v0.3.0 - written for a suite that covered 79/66/81.5/82 and never raised as it
        // grew, which left roughly ten points of slack a regression could have landed in.
        statements: 88,
        branches: 77,
        functions: 89,
        lines: 91,
        // The renderer: 87.2 / 86.0 / 84.5 / 89.5.
        "**/packages/app/renderer/src/**": { statements: 86, branches: 85, functions: 83, lines: 88 },
        // The app's Node half - daemon client, preferences, connection: 100 / 92.9 / 100 / 100.
        "**/packages/app/src/**": { statements: 95, branches: 92, functions: 95, lines: 99 },
      },
    },
  },
});
