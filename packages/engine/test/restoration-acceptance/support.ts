/** Shared setup for the #396 restoration acceptance tests: one process harness, fixture tracking and the common assertions.
 * Importing this module registers the afterEach that disposes them. */
import { rm } from "node:fs/promises";
import { afterEach, expect } from "vitest";
import { ProcessHarness, protectedDigests } from "./harness.js";
import { makeFixture, type Fixture, type Report } from "./fixture.js";

export const harness = new ProcessHarness();
const fixtures: Fixture[] = [];
export const fixture = async (kind: Fixture["kind"] = "builtin") => {
  const f = await makeFixture(kind);
  fixtures.push(f);
  return f;
};
afterEach(async () => {
  await harness.dispose();
  await Promise.all(fixtures.splice(0).map((f) => rm(f.root, { recursive: true, force: true })));
});

export function noLeaks(report: Report) {
  expect([report.publicLeak, report.logLeak, report.errorLeak]).toEqual([false, false, false]);
}
export function refused(report: Report, code = "RUN_STATE") {
  expect(report.outcome).toBe("refused");
  expect(report.code).toBe(code);
  expect(report.provisioned).toBe(0);
  expect(report.providerCalls).toBe(0);
  expect(report.permissionDelivered).toBe(0);
  expect(report.consentWrites).toBe(0);
  noLeaks(report);
}
export function differentProcess(before: Report, after: Report) {
  expect(after.pid).not.toBe(before.pid);
  expect(after.pid).not.toBe(process.pid);
  expect(after.bootId).not.toBe(before.bootId);
  expect(after.runtimeSha256).toBe(before.runtimeSha256);
  expect(after.nodeVersion).toBe(process.version);
}
export async function preserveOriginal(f: Fixture, before: Record<string, string>) {
  const after = await protectedDigests(f);
  for (const [path, hash] of Object.entries(before)) expect(after[path], path).toBe(hash);
}
