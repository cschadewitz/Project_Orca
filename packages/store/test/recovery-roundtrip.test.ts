/** Test-owned copies prove protected readability/public redaction, never permission to recover execution. */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateRecoveryManifest } from "../src/recovery-validation.js";
import { FileExecutionStore } from "../src/execution-store.js";
import { FileWorkflowVersionStore } from "../src/workflow-store.js";
import { JsonlEventStore } from "../src/jsonl-event-store.js";
import {
  CANDIDATE,
  copySyntheticFixture,
  observe,
  readSyntheticStores,
  recoveryFixture,
  sourceDigest,
  type RecoveryFixture,
} from "./recovery-fixture.js";

const fixtures: RecoveryFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
async function fixture() {
  const value = await recoveryFixture();
  fixtures.push(value);
  return value;
}

it("round trips two independent stores plus separate app/config roots without changing sources or starting execution", async () => {
  const f = await fixture(),
    before = await sourceDigest(f),
    original = await observe(f.plan);
  const writes = [
    vi.spyOn(FileExecutionStore.prototype, "putInputs"),
    vi.spyOn(FileExecutionStore.prototype, "putGeneration"),
    vi.spyOn(FileExecutionStore.prototype, "putPayload"),
    vi.spyOn(FileWorkflowVersionStore.prototype, "put"),
    vi.spyOn(JsonlEventStore.prototype, "append"),
  ];
  const copied = await copySyntheticFixture(f),
    observed = await observe(copied);
  const semanticReads = await readSyntheticStores(copied, f.definition);
  expect(semanticReads.map((read) => read.readable)).toEqual([true, true]);
  const result = validateRecoveryManifest(JSON.stringify(original), {
    expectedCandidateRef: CANDIDATE,
    observedJson: JSON.stringify(observed),
    semanticReads,
  });
  expect(result.structuralValidity.status).toBe("passed");
  expect(result.coverage.status).toBe("passed");
  expect(result.integrity.status).toBe("passed");
  // Byte preservation cannot establish Keychain/native app semantic readability.
  expect(result.semanticReadability.status).toBe("unknown");
  expect(result.writerConsistency.reasons).toEqual(["WRITER_COVERAGE_UNKNOWN"]);
  expect(result.recoveryEligibility).toEqual({ status: "unavailable", reasons: ["RECOVERY_DISABLED"] });
  expect((await sourceDigest(f)) === before).toBe(true);
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  expect(JSON.stringify(result).includes(f.base)).toBe(false);
});

it.each([
  "execution-key-missing",
  "workflow-key-missing",
  "truncated-key",
  "swapped-key",
  "corrupt-ciphertext",
  "missing-reference",
  "mixed-era",
])("refuses synthetic %s with distinct byte/readability evidence and unchanged source stores", async (fault) => {
  const f = await fixture(),
    before = await sourceDigest(f),
    original = await observe(f.plan),
    copied = await copySyntheticFixture(f);
  const first = copied.roots[0]!.path,
    second = copied.roots[1]!.path;
  const key = join(first, "private-execution/.execution-key"),
    inputs = join(first, "private-execution/run.inputs.json");
  if (fault === "execution-key-missing") await rm(key);
  if (fault === "workflow-key-missing") await rm(join(first, "private-workflows/.execution-key"));
  if (fault === "truncated-key") await writeFile(key, Buffer.alloc(7));
  if (fault === "swapped-key") await writeFile(key, await readFile(join(first, "private-workflows/.execution-key")));
  if (fault === "corrupt-ciphertext") {
    const envelope = JSON.parse(await readFile(inputs, "utf8")) as { ciphertext: string };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 1;
    envelope.ciphertext = bytes.toString("base64");
    await writeFile(inputs, JSON.stringify(envelope));
  }
  if (fault === "missing-reference") await rm(inputs);
  if (fault === "mixed-era") await writeFile(inputs, await readFile(join(second, "private-execution/run.inputs.json")));
  const observed = await observe(copied),
    semanticReads = await readSyntheticStores(copied, f.definition);
  expect(semanticReads[0]?.readable).toBe(false);
  const result = validateRecoveryManifest(JSON.stringify(original), {
    expectedCandidateRef: CANDIDATE,
    observedJson: JSON.stringify(observed),
    semanticReads,
  });
  expect(result.integrity.status).toBe("failed");
  expect(result.semanticReadability.reasons).toEqual(["SEMANTIC_UNREADABLE"]);
  expect(result.recoveryEligibility.status).toBe("unavailable");
  expect((await sourceDigest(f)) === before).toBe(true);
  expect(JSON.stringify(result).includes(f.base)).toBe(false);
  const current = validateRecoveryManifest(JSON.stringify(observed), { expectedCandidateRef: CANDIDATE });
  if (fault.endsWith("key-missing")) expect(current.integrity.reasons).toContain("KEY_MISSING");
  if (fault === "truncated-key") expect(current.integrity.reasons).toContain("KEY_INVALID");
  if (fault === "missing-reference") expect(current.coverage.reasons).toContain("REFERENCE_MISSING");
});
