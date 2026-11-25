/** The main process adopts pre-rename environment names before any other module runs. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("imports legacy-env first in the main entry, ahead of every module that reads the environment", () => {
  const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import\s.*?["']([^"']+)["'];?$/gms)].map((m) => m[1]);
  expect(imports[0]).toBe("./legacy-env.js");
  const module = readFileSync(new URL("../src/main/legacy-env.ts", import.meta.url), "utf8");
  expect(module).toMatch(/^adoptLegacyEnv\(\);$/m);
});
