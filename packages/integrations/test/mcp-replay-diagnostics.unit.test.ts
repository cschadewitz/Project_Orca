/** Focused unit contracts separated from the mixed suite. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ReplayDiagnostics } from "./mcp-replay-diagnostics.js";
import { ProductionFixture } from "./mcp-operator-production-fixture.js";

const dirs: string[] = [];
const temporary = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-replay-diagnostics-"));
  dirs.push(dir);
  return dir;
};

it("drops raw, malformed, oversized and forged child stderr; retains only the last 16 safe observations", async () => {
  const diagnostics = new ReplayDiagnostics();
  const emit = (record: unknown) => diagnostics.capture(Buffer.from(`ORCA_TEST_TRANSPORT ${JSON.stringify(record)}\n`));
  diagnostics.capture(Buffer.from("SECRET_TOKEN\nORCA_TEST_TRANSPORT not-json\n"));
  diagnostics.capture(Buffer.from("X".repeat(3000) + "ORCA_TEST_TRANSPORT {}\n"));
  emit({ request: 1, outcome: "error", elapsedMs: 1, causes: [{ name: "Error", code: "SECRET_CODE" }] });
  emit({ request: 1, outcome: "headers", elapsedMs: 1, status: 503, secret: "SECRET_PATH" });
  for (let request = 1; request <= 20; request++) {
    const line = `ORCA_TEST_TRANSPORT ${JSON.stringify({ request, outcome: "started", elapsedMs: 0 })}\n`;
    diagnostics.capture(Buffer.from(line.slice(0, 10)));
    diagnostics.capture(Buffer.from(line.slice(10)));
  }
  const fixture = new ProductionFixture();
  fixture.dir = await temporary();
  fixture.daemon = { exitCode: null, signalCode: null, pid: process.pid } as ProductionFixture["daemon"];
  const previous = { exitCode: null, signalCode: "SIGKILL", pid: process.pid } as ProductionFixture["daemon"];
  const failure = new Error("SECRET_FAILURE");
  await expect(
    diagnostics.measure("replay", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  const evidence = await diagnostics.evidence(fixture, previous, "retry_synthetic", "run_synthetic");
  expect(evidence.transport).toHaveLength(16);
  expect(evidence.transport[0]?.request).toBe(5);
  expect(evidence.previousDaemon).toEqual({ exitCode: null, signal: "SIGKILL" });
  expect(evidence.currentDaemon).toEqual({ exitCode: null, signal: null });
  expect(evidence.stages).toMatchObject([{ stage: "replay" }]);
  expect(JSON.stringify(evidence)).not.toMatch(/SECRET|retry_synthetic|run_synthetic|orca-replay-diagnostics/);
});
