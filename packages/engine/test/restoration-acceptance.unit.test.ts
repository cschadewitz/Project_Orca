/** Focused unit contracts separated from the mixed suite. */
import { describe, expect, it } from "vitest";
import * as engine from "@orca/engine";
import {
  baselineSha,
  candidatePins,
  implementationPins,
  fixtureReviewStatus,
  exercisedAcceptance,
  unverifiedExternalClaims,
} from "./restoration-acceptance/matrix.js";

describe("#396 provisional contract bindings: acceptance remains INCOMPLETE", () => {
  it("records exact combined pins and separates executed coverage from review and external evidence", () => {
    expect(baselineSha).toMatch(/^[a-f0-9]{40}$/);
    expect(implementationPins).toEqual(candidatePins);
    expect(fixtureReviewStatus).toBe("root-minimal-review-pending");
    expect(candidatePins).toEqual({
      substrate394: "3054319b37ae61ba22b62ba2f519dc50bf3c0ebc",
      jev395: "879bedcf701f4eaad2e8da47bac8feb2444c2d9d",
    });
    expect(exercisedAcceptance).toHaveLength(14);
    expect(unverifiedExternalClaims).toHaveLength(2);
    if (process.env.ORCA_RESTORATION_CANDIDATE) {
      expect(process.env.ORCA_RESTORATION_CANDIDATE).toBe(candidatePins.substrate394);
      expect(Reflect.has(engine, "readPluginRestorationData")).toBe(true);
    }
  });
});
