/** Progress evidence preserves original settlement, bounds retained records and excludes hostile inputs. */
import { expect, it } from "vitest";
import { FixtureProgress, rpcStage, toolStage } from "./fixture-progress.js";

it("records a held await and preserves the exact failure without serializing it", async () => {
  const progress = new FixtureProgress();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const error = new Error("PRIVATE_TOKEN_PAYLOAD_PATH");
  Object.defineProperty(error, "stack", {
    get() {
      throw new Error("never read");
    },
  });
  const work = progress.measure("rpc.revision", async () => {
    await held;
    throw error;
  });
  expect(progress.snapshot().active).toEqual([{ stage: "rpc.revision", elapsedMs: expect.any(Number) }]);
  release();
  await expect(work).rejects.toBe(error);
  expect(progress.snapshot().active).toEqual([]);
  expect(progress.snapshot().recent[0]).toMatchObject({ stage: "rpc.revision", outcome: "rejected" });
  expect(JSON.stringify(progress.snapshot())).not.toContain("PRIVATE");
});

it("bounds active and settled records and maps unknown request names to closed stages", async () => {
  const progress = new FixtureProgress();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = Array.from({ length: 64 }, () => progress.measure(rpcStage("PRIVATE_METHOD"), () => held));
  expect(progress.snapshot().active).toHaveLength(16);
  release();
  await Promise.all(calls);
  const snapshot = progress.snapshot();
  expect(snapshot.recent).toHaveLength(16);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.active).toEqual([]);
  expect(toolStage("PRIVATE_TOOL")).toBe("mcp.read");
  expect(rpcStage("__proto__")).toBe("rpc.other");
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  snapshot.recent.length = 0;
  expect(progress.snapshot().recent).toHaveLength(16);
});
