/**
 * The Attention surface's arithmetic, with no DOM: which option gets which digit, what an
 * "always" answer may promise, what order the waits come in, and what the main process is
 * told about them.
 *
 * Two of these are safety properties rather than presentation — the destructive option's
 * digit, and what a card is allowed to say after writing a standing permission rule — which
 * is exactly why they are plain functions with a plain test rather than branches inside a
 * component.
 */
import { describe, expect, it } from "vitest";
import type { InputsAnswerResult, OpenInputView } from "@orca/protocol";
import {
  alwaysOutcome,
  artifactsReady,
  bindOptions,
  defaultSelection,
  isFreeText,
  permissionSubject,
  waitedLabel,
} from "../src/attention/card-model.js";
import { alertItems, mergeInput, orderWaits, tierOf } from "../src/attention/items.js";
import { DESTRUCTIVE_GATE, FIVE_GATES, PERMISSION_ASK, UNLOADED_GATE } from "./fixtures-inputs.js";
import { RUNS } from "./fixtures.js";

describe("binding options to digits", () => {
  it("never puts the destructive option on 1, and never selects it", () => {
    const bound = bindOptions(DESTRUCTIVE_GATE.options);
    // The wire offered the destructive one first; the card does not.
    expect(bound.map((b) => [b.digit, b.option.id])).toEqual([
      [1, "retry"],
      [2, "roll_back"],
    ]);
    expect(defaultSelection(DESTRUCTIVE_GATE.options)).toBe("retry");
  });

  it("selects nothing when every way out is destructive", () => {
    const options = [
      { id: "abort", label: "Abort", destructive: true },
      { id: "rollback", label: "Roll back", destructive: true },
    ];
    expect(defaultSelection(options)).toBeUndefined();
    // They still get digits: the card has to be answerable, just not by accident.
    expect(bindOptions(options).map((b) => b.digit)).toEqual([1, 2]);
  });

  it("keeps the offered order otherwise, and runs out of digits after nine", () => {
    const options = Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const bound = bindOptions(options);
    expect(bound.map((b) => b.option.id).join()).toBe(options.map((o) => o.id).join());
    expect(bound.slice(0, 9).map((b) => b.digit)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bound.slice(9).every((b) => b.digit === undefined)).toBe(true);
  });

  it("calls an empty option list free text", () => {
    expect(isFreeText([])).toBe(true);
    expect(isFreeText(FIVE_GATES[0]!.options)).toBe(false);
  });
});

describe("what an always answer may promise", () => {
  const rule = { match: { kind: "execute" as const, path: "scripts/deploy.sh" }, decision: "allow" as const };
  const record = (over: Partial<NonNullable<InputsAnswerResult["permission"]>>) => ({
    file: "/work/orca/orca.permissions.json",
    agentId: "claude",
    rules: [rule],
    added: [],
    alreadyPresent: [],
    ...over,
  });

  it("says nothing at all when no rule was asked for", () => {
    expect(alwaysOutcome(undefined)).toBeUndefined();
  });

  it("promises only when something was written", () => {
    expect(alwaysOutcome(record({ added: [rule] }))).toContain("ORCA will not ask again");
    expect(alwaysOutcome(record({ added: [rule, rule] }))).toContain("2 rules");
  });

  it("does not promise when the rule was already there, and says where it is", () => {
    const message = alwaysOutcome(record({ alreadyPresent: [rule] }));
    expect(message).toContain("already had this rule");
    expect(message).toContain("orca.permissions.json");
  });

  it("says ORCA will ask again when the rule was refused", () => {
    const message = alwaysOutcome(
      record({ refused: { reason: "nothing to derive a rule from", detail: "the ask named no tool" } }),
    );
    expect(message).toContain("ORCA will ask again");
    expect(message).toContain("held once");
  });

  it("claims nothing when the daemon added nothing and refused nothing", () => {
    expect(alwaysOutcome(record({}))).toBe("This answer held once; no standing rule was written.");
  });
});

describe("what a card can show the basis for", () => {
  it("is ready when the ask names no artifact", () => {
    expect(artifactsReady(FIVE_GATES[0]!)).toBe(true);
  });

  it("is not ready when the question names one the view did not carry", () => {
    expect(artifactsReady(UNLOADED_GATE)).toBe(false);
  });

  it("matches a named artifact by id or by name", () => {
    const held = FIVE_GATES[0]!.artifacts;
    expect(artifactsReady({ context: { artifact: "art-spec-v2" }, artifacts: held })).toBe(true);
    expect(artifactsReady({ context: { artifacts: ["spec"] }, artifacts: held })).toBe(true);
    expect(artifactsReady({ context: { artifactIds: ["spec", "missing"] }, artifacts: held })).toBe(false);
    // A context field that is not a name is not a claim about an artifact.
    expect(artifactsReady({ context: { artifact: 7 }, artifacts: [] })).toBe(true);
  });
});

describe("the words on a card", () => {
  it("says how long it has waited at every scale", () => {
    expect(waitedLabel(4_000)).toBe("waiting 4s");
    expect(waitedLabel(240_000)).toBe("waiting 4m");
    expect(waitedLabel(3 * 3_600_000 + 600_000)).toBe("waiting 3h 10m");
    expect(waitedLabel(50 * 3_600_000)).toBe("waiting 2d 2h");
  });

  it("takes the permission subject verbatim, and gives up rather than summarising", () => {
    expect(permissionSubject(PERMISSION_ASK.context)).toBe("rm -rf build/");
    expect(permissionSubject({ path: "src/index.ts" })).toBe("src/index.ts");
    expect(permissionSubject({ locations: ["a.ts", "b.ts", 3] })).toBe("a.ts\nb.ts");
    expect(permissionSubject({ command: "" })).toBeUndefined();
    expect(permissionSubject({ policy: { deny: true } })).toBeUndefined();
  });
});

describe("the order of what is waiting", () => {
  const gates = FIVE_GATES.slice(0, 2);

  it("puts permission asks above gates and keeps the daemon's order inside a tier", () => {
    const ordered = orderWaits([...gates, PERMISSION_ASK]);
    expect(ordered.map((i) => i.id)).toEqual(["ask-1", "gate-1", "gate-2"]);
    expect(ordered.map(tierOf)).toEqual(["permission", "gate", "gate"]);
  });

  it("replaces an ask rather than duplicating it when it is merged again", () => {
    const reworded: OpenInputView = { ...gates[0]!, question: "Ship it now?" };
    const merged = mergeInput(gates, reworded);
    expect(merged).toHaveLength(2);
    expect(merged.find((i) => i.id === reworded.id)?.question).toBe("Ship it now?");
  });
});

describe("what the main process is told", () => {
  it("names the tier, the run and the moment it was asked", () => {
    const [ask, gate] = alertItems([PERMISSION_ASK, FIVE_GATES[0]!], []);
    expect(ask).toMatchObject({
      id: "ask-1",
      tier: "permission",
      title: "release 1 needs permission",
      body: "Run a shell command?",
      runId: "run-1",
      inputId: "ask-1",
    });
    // The instant it was asked, not the instant this window heard: the 60-second gate delay
    // is measured from there (`src/main/alerts.ts`).
    expect(ask?.since).toBe(PERMISSION_ASK.requestedAt);
    expect(gate).toMatchObject({ tier: "gate", title: "release 1 is waiting" });
  });

  it("carries a failure as its own tier, with what the run said", () => {
    const failed = RUNS.find((r) => r.status === "failed")!;
    const [item] = alertItems([], [failed]);
    expect(item).toMatchObject({ tier: "failure", runId: failed.id, body: "the build never finished" });
    expect(item?.inputId).toBeUndefined();
    // A run that failed with nothing to say still says something.
    const [bare] = alertItems([], [{ ...failed, error: undefined }]);
    expect(bare?.body).toBe("The run will not proceed.");
  });
});
