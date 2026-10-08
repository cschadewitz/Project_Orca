/** Cache invalidation uses actual dependency bytes; synthetic image mutations stay fixture-local. */
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compiledSourceFixture } from "./compiled-source-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-compiled-source-"));
  roots.push(root);
  await writeFile(join(root, "tsconfig.json"), "{}");
  await writeFile(join(root, "control.json"), "{}");
  await writeFile(join(root, "entry.ts"), 'export { value } from "./dependency.js";');
  await writeFile(join(root, "dependency.ts"), 'export const value = "first";');
  return { root, get: compiledSourceFixture(root, "entry.ts", ["tsconfig.json", "control.json"]) };
}

it("reuses only immutable compiled bytes while callers write independent images", async () => {
  const { root, get } = await fixture();
  const compiled = get();
  expect(get()).toBe(compiled);
  expect(Object.isFrozen(compiled)).toBe(true);
  await writeFile(join(root, "first.mjs"), compiled.source);
  await writeFile(join(root, "second.mjs"), get().source);
  await writeFile(join(root, "first.mjs"), "tampered");
  expect(await readFile(join(root, "second.mjs"), "utf8")).toBe(compiled.source);
  expect(get()).toBe(compiled);
});

it("invalidates changed transitive bytes even with unchanged size and restored mtime", async () => {
  const { root, get } = await fixture();
  const before = get();
  const path = join(root, "dependency.ts");
  const original = await stat(path);
  await writeFile(path, 'export const value = "later";');
  await utimes(path, original.atime, original.mtime);
  expect(() => before.assertCurrent()).toThrow("Synthetic source changed");
  const after = get();
  expect(after.digest).not.toBe(before.digest);
  expect(after.source).toContain("later");
  expect(get()).toBe(after);
});

it("invalidates build controls and fails closed when a dependency disappears", async () => {
  const { root, get } = await fixture();
  const before = get();
  await writeFile(join(root, "control.json"), '{"changed":true}');
  const after = get();
  expect(after).not.toBe(before);
  expect(() => before.assertCurrent()).toThrow("Synthetic source changed");
  await rm(join(root, "dependency.ts"));
  expect(() => after.assertCurrent()).toThrow();
  expect(get).toThrow();
  await writeFile(join(root, "dependency.ts"), 'export const value = "fixed";');
  expect(get().source).toContain("fixed");
});
