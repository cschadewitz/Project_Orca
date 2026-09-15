import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

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
  },
});
