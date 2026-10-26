/** #706 review guard (#742): the inactive owned-read Save/qualification seams and the
 * controlled test producer stay off every package barrel and production import graph.
 * Their capabilities are callables a trusted test passes in; none is reachable from a
 * barrel, method table, configuration or wire data. A new importer fails here for review.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import * as agents from "@orca/agents";
import * as engine from "@orca/engine";
import * as daemon from "../src/index.js";

const repo = resolve(import.meta.dirname, "../../..");
const at = (path: string) => join(repo, path);
const inactiveOwners = new Set(
  [
    "packages/daemon/src/scoped-permission-bridge.ts",
    "packages/daemon/src/protected-scoped-permission-owner.ts",
    "packages/daemon/src/owned-read-scoped-capture.ts",
  ].map(at),
);
const testServices = new Set(
  [
    "packages/engine/src/owned-file-read-service.ts",
    "packages/engine/src/synthetic-read-fence.ts",
    "packages/engine/src/disposable-file-read.ts",
  ].map(at),
);
const seams = [
  "createOwnedFileReadServiceForTest",
  "createDisposableFileReadForTest",
  "ownedFileCaptureQualifier",
  "SyntheticReadFence",
  "protectedScopedPermissionOwner",
  "scopedPermissionMethods",
  "ownedReadScopedCapture",
  "runControlledOwnedReadTest",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}
const production = readdirSync(at("packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    try {
      return sources(at(`packages/${entry.name}/src`));
    } catch {
      return [];
    }
  });
function imports(file: string) {
  const text = readFileSync(file, "utf8");
  const found: { typeOnly: boolean; target: string }[] = [];
  const pattern =
    /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[3] ?? match[4]!;
    if (!specifier.startsWith(".")) continue;
    found.push({
      typeOnly: !!match[2],
      target: resolve(dirname(file), specifier).replace(/\.(m?js)$/, (_, ext: string) =>
        ext === "mjs" ? ".mts" : ".ts",
      ),
    });
  }
  return found;
}

it("no package barrel exposes the inactive owner, bridge, test services or controlled producer", () => {
  for (const [name, barrel] of Object.entries({ agents, engine, daemon }))
    for (const seam of seams) expect(Object.hasOwn(barrel, seam), `${name}.${seam}`).toBe(false);
});

it("production sources never import the controlled producer, proof tools or inactive seams", () => {
  expect(production.length).toBeGreaterThan(50);
  for (const file of production) {
    const from = relative(repo, file);
    for (const edge of imports(file)) {
      const to = relative(repo, edge.target);
      expect(to.startsWith("packages/cli/test/") || to.startsWith("tools/"), `${from} -> ${to}`).toBe(false);
      if (inactiveOwners.has(edge.target)) expect(inactiveOwners.has(file), `${from} -> ${to}`).toBe(true);
      // Outside the test services themselves, only their types may be referenced.
      if (testServices.has(edge.target) && !testServices.has(file))
        expect(edge.typeOnly, `${from} -> ${to} (value import)`).toBe(true);
    }
  }
});
