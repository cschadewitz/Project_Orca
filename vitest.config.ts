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
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
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
      exclude: ["packages/*/src/index.ts", "**/main.ts", "packages/testing/**"],
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      // A ratchet, set just under what the suite covers today (79.0 / 66.2 / 81.5 / 81.9).
      // Raise these as coverage improves; never lower them to make a red CI go green.
      thresholds: { statements: 78, branches: 65, functions: 80, lines: 81 },
    },
  },
});
