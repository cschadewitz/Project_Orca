/** Workspace policy uses the real command and disk, with a controlled workflow outcome.
 * demo.test.ts retains actual program/ACP execution and reuse of the emitted config. */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState } from "@orca/core";
import { commands } from "../src/commands/index.js";
import { ctx, successfulDemo, announcedDir, exists } from "./demo-fixture.js";

const { submitAndRun, detach } = vi.hoisted(() => ({ submitAndRun: vi.fn(), detach: vi.fn() }));
vi.mock("../src/bootstrap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bootstrap.js")>()),
  bootstrap: async () => ({
    program: { submitAndRun },
    orchestrator: { stores: { workItems: { list: async () => [] } }, subscribe: () => detach },
    plan: { getPlan: async () => undefined },
  }),
}));
const dirs: string[] = [];
beforeEach(() => {
  const state: RunState = {
    run: {
      id: "demo-run",
      workflowId: "program",
      workflowVersion: "1",
      status: "completed",
      outcome: "success",
      workspace: { hostId: "local", cwd: "/synthetic" },
      vars: {},
      createdAt: "2026-10-08T00:00:00Z",
    },
    steps: {},
    stepOrder: [],
    artifacts: {},
    humanInputs: {},
    lastSeq: 0,
  };
  submitAndRun.mockResolvedValue({ request: { id: "demo-request" }, state });
});
afterEach(async () => {
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("orca demo workspace policy", () => {
  it("removes its temp workspace afterwards by default", async () => {
    const c = ctx(tmpdir(), []);
    await successfulDemo(c);
    const dir = announcedDir(c);
    dirs.push(dir);
    expect(dir.startsWith(join(tmpdir(), "orca-demo-"))).toBe(true);
    expect(await exists(dir)).toBe(false);
    expect(c.lines.join("\n")).toMatch(/removing demo workspace/);
    expect(c.lines.join("\n")).not.toMatch(/ready-to-use/);
  });

  it("keeps the temp workspace with --keep and says where it is", async () => {
    const c = ctx(tmpdir(), [], { keep: true });
    await successfulDemo(c);
    const dir = announcedDir(c);
    dirs.push(dir);
    expect(await exists(join(dir, "orca.config.yaml"))).toBe(true);
    expect(c.lines.join("\n")).toMatch(/ready-to-use/);
    expect(c.lines.join("\n")).not.toMatch(/removing demo workspace/);
  });

  it("detaches and removes the temporary workspace when execution throws", async () => {
    submitAndRun.mockRejectedValueOnce(new Error("synthetic execution failure"));
    const c = ctx(tmpdir(), [], { quiet: false });
    await expect(commands.demo!.run(c)).rejects.toThrow("synthetic execution failure");
    const dir = announcedDir(c);
    dirs.push(dir);
    expect(await exists(dir)).toBe(false);
    expect(detach).toHaveBeenCalledTimes(1);
  });
});
