/** Vitest setup: `@orca/*` resolves to package sources, so tests never depend on a build. */
import { defineConfig } from "vitest/config";
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
      "@orca/agents": pkg("agents"),
      "@orca/engine": pkg("engine"),
      "@orca/testing": pkg("testing"),
      "@orca/integrations": pkg("integrations"),
      "@orca/protocol": pkg("protocol"),
      "@orca/daemon": pkg("daemon"),
      "@orca/design": pkg("design"),
    },
  },
  test: {
    // The renderer is its own TypeScript project (DOM lib, bundler resolution), so its
    // tests live next to it rather than in packages/app/test.
    include: ["packages/*/test/**/*.test.ts", "packages/app/renderer/test/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
        // The whole report: 88.7 / 77.9 / 88.6 / 91.4 today.
        statements: 78,
        branches: 65,
        functions: 80,
        lines: 81,
        // The renderer: 87.2 / 86.0 / 84.5 / 89.5.
        "**/packages/app/renderer/src/**": { statements: 86, branches: 85, functions: 83, lines: 88 },
        // The app's Node half - daemon client, preferences, connection: 100 / 92.9 / 100 / 100.
        "**/packages/app/src/**": { statements: 99, branches: 92, functions: 99, lines: 99 },
      },
    },
  },
});
