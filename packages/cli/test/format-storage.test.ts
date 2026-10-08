/** Legacy JSONL remains readable and byte-for-byte unchanged after human rendering. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JsonlEventStore, JsonlPlanJournal } from "@orca/store";
import { formatEvent } from "../src/format.js";
import { formatPlanEvent } from "../src/format-plan-event.js";

it("renders legacy run and plan journals without migrating or mutating their payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-format-legacy-"));
  try {
    await mkdir(join(dir, "runs"));
    await mkdir(join(dir, "plans"));
    const at = "2026-01-02T03:04:05.000Z";
    const event = {
      id: "ev_0",
      seq: 0,
      runId: "run_1",
      at,
      type: "human.requested",
      payload: {
        stepRunId: "step_gate",
        requestId: "hi_1",
        kind: "decision",
        question: "Proceed?",
        options: ["ship", "hold"],
      },
    };
    const journal = {
      id: "pe_0",
      seq: 0,
      planId: "plan_1",
      at,
      type: "dependency.resolved",
      origin: { kind: "human", actor: "cli" },
      payload: { dependencyId: "dep_1", status: "waived" },
    };
    const runBytes = JSON.stringify(event) + "\n";
    const planBytes = JSON.stringify(journal) + "\n";
    await writeFile(join(dir, "runs/run_1.jsonl"), runBytes);
    await writeFile(join(dir, "plans/plan_1.jsonl"), planBytes);
    const events = await new JsonlEventStore(dir).read("run_1");
    const entries = await new JsonlPlanJournal(dir).read("plan_1");
    const before = JSON.stringify({ events, entries });
    expect(events.map(formatEvent)).toEqual(["03:04:05     ? Proceed? [ship | hold]"]);
    expect(entries.map((entry) => formatPlanEvent(entry, (id) => id))[0]).toMatch(/dep_1 waived$/);
    expect(JSON.stringify({ events, entries })).toBe(before);
    expect(await readFile(join(dir, "runs/run_1.jsonl"), "utf8")).toBe(runBytes);
    expect(await readFile(join(dir, "plans/plan_1.jsonl"), "utf8")).toBe(planBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
