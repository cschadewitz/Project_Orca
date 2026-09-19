/**
 * The status fold, tested once and here: every engine run status, every step status and
 * every outcome has to land on one of the eight words the design system draws, and the two
 * lists must not drift apart.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RunStatusSchema, StepStatusSchema } from "@orca/core";
import { DISPLAY_STATUSES, displayStatusForRun, displayStatusForStep, waitKind } from "@orca/protocol";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("DISPLAY_STATUSES", () => {
  it("is the design system's runStatus list, in its order", () => {
    const semantics = JSON.parse(readFileSync(join(repoRoot, "packages", "design", "semantics.json"), "utf8")) as {
      runStatus: Record<string, unknown>;
    };
    expect([...DISPLAY_STATUSES]).toEqual(Object.keys(semantics.runStatus));
  });
});

describe("displayStatusForRun", () => {
  it("covers every engine run status", () => {
    for (const status of RunStatusSchema.options) expect(DISPLAY_STATUSES).toContain(displayStatusForRun({ status }));
  });

  it("reads a finished run's outcome, not its status alone", () => {
    expect(displayStatusForRun({ status: "completed", outcome: "success" })).toBe("succeeded");
    expect(displayStatusForRun({ status: "completed", outcome: "failure" })).toBe("failed");
    expect(displayStatusForRun({ status: "completed", outcome: "cancelled" })).toBe("cancelled");
    expect(displayStatusForRun({ status: "failed", outcome: "failure" })).toBe("failed");
    expect(displayStatusForRun({ status: "cancelled", outcome: "cancelled" })).toBe("cancelled");
  });

  it("splits a wait by what is being waited on", () => {
    expect(displayStatusForRun({ status: "waiting" }, { waitingOn: "human-input" })).toBe("waiting");
    expect(displayStatusForRun({ status: "waiting" }, { waitingOn: "dependencies" })).toBe("blocked");
    expect(displayStatusForRun({ status: "waiting" }, { waitingOn: "plan" })).toBe("blocked");
    expect(displayStatusForRun({ status: "waiting" }, { waitingOn: "agent-turn" })).toBe("running");
    expect(displayStatusForRun({ status: "waiting" }, { waitingOn: "child-run" })).toBe("running");
    // A parked run is parked for a person, whatever its steps say.
    expect(displayStatusForRun({ status: "paused" })).toBe("waiting");
  });

  it("calls a run with no interpreter behind it stale", () => {
    expect(displayStatusForRun({ status: "running" }, { leaseLapsed: true })).toBe("stale");
    expect(displayStatusForRun({ status: "waiting" }, { waitingOn: "human-input", leaseLapsed: true })).toBe("stale");
    expect(displayStatusForRun({ status: "running" }, { leaseLapsed: false })).toBe("running");
    // A finished run holds no lease and is not stale for it.
    expect(displayStatusForRun({ status: "completed", outcome: "success" }, { leaseLapsed: true })).toBe("succeeded");
  });

  it("calls a created run blocked: nothing is wrong and nothing has started", () => {
    expect(displayStatusForRun({ status: "created" })).toBe("blocked");
  });

  it("never produces held, which belongs to the plan", () => {
    const produced = new Set(
      RunStatusSchema.options.flatMap((status) =>
        ["human-input", "dependencies", "agent-turn", undefined].map((waitingOn) =>
          displayStatusForRun({ status }, { waitingOn }),
        ),
      ),
    );
    expect(produced.has("held")).toBe(false);
  });
});

describe("displayStatusForStep", () => {
  it("covers every engine step status", () => {
    for (const status of StepStatusSchema.options) expect(DISPLAY_STATUSES).toContain(displayStatusForStep({ status }));
  });

  it("maps the ones a tree renders differently", () => {
    expect(displayStatusForStep({ status: "scheduled" })).toBe("blocked");
    expect(displayStatusForStep({ status: "completed" })).toBe("succeeded");
    expect(displayStatusForStep({ status: "failed" })).toBe("failed");
    // A branch never taken is not a fault: `cancelled` is the struck-through, neutral word.
    expect(displayStatusForStep({ status: "skipped" })).toBe("cancelled");
    expect(displayStatusForStep({ status: "waiting", waitingOn: "human-input" })).toBe("waiting");
    expect(displayStatusForStep({ status: "waiting", waitingOn: "agent-turn" })).toBe("running");
  });
});

describe("waitKind", () => {
  it("classifies the engine's wait reasons", () => {
    expect(waitKind("human-input")).toBe("human");
    expect(waitKind("dependencies")).toBe("dependency");
    expect(waitKind("plan")).toBe("dependency");
    expect(waitKind("agent-turn")).toBe("work");
    expect(waitKind(undefined)).toBe("work");
  });
});
