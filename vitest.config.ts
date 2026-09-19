/** Vitest setup: `@orca/*` resolves to package sources, so tests never depend on a build. */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
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
    include: ["packages/*/test/**/*.test.ts", "packages/app/renderer/test/**/*.test.tsx"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      // Every source file, not just the ones a test happened to import: a module nobody
      // covers shows up as 0%, rather than being missing from the report.
      include: ["packages/*/src/**/*.ts"],
      // Barrels re-export and nothing else. `testing` (the scripted agent) is test
      // infrastructure, and the e2e tests drive it as a real subprocess - v8 coverage
      // collected in this process cannot see any of it, so its number would be fiction.
      // The app's main and preload processes only run inside Electron; its daemon client
      // is plain Node and is covered. The design package's src is generated tokens and a
      // documentation-only .d.ts; its tests check the JSON sources, not the output.
      exclude: [
        "packages/*/src/index.ts",
        "**/main.ts",
        "packages/testing/**",
        "packages/app/src/main/**",
        "packages/app/src/preload/**",
        "packages/design/src/**",
      ],
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      // A ratchet, set just under what the suite covers today (79.0 / 66.2 / 81.5 / 81.9).
      // Raise these as coverage improves; never lower them to make a red CI go green.
      thresholds: { statements: 78, branches: 65, functions: 80, lines: 81 },
    },
  },
});
