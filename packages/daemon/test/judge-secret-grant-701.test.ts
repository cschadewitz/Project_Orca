/**
 * #701: a secret grant for review-judge use is separate from a grant for delivery to an agent.
 * Neither covers the other; only `*` covers both.
 */
import { describe, expect, it } from "vitest";
import { grantCovers, SecretGrantSchema } from "../src/auth/principal.js";

const binding = `h1:${"0".repeat(32)}`;
const base = { secret: "judge-key", provider: "env", host: "local", binding } as const;
const agentUse = { secret: "judge-key", provider: "env", hostId: "local", hostBinding: binding };
const judgeUse = { ...agentUse, purpose: "review-judge" as const, destination: "https://judge.invalid/v0" };

describe("#701 review-judge secret grants", () => {
  it("covers a judge use only with the same purpose and destination", () => {
    const judge = SecretGrantSchema.parse([{ ...base, purpose: "review-judge", destination: judgeUse.destination }]);
    expect(grantCovers(judge, judgeUse)).toBe(true);
    expect(grantCovers(judge, { ...judgeUse, destination: "https://other.invalid/v0" })).toBe(false);
    expect(grantCovers(judge, agentUse)).toBe(false);
  });

  it("never lets an agent grant cover a judge use", () => {
    const agent = SecretGrantSchema.parse([base]);
    expect(grantCovers(agent, agentUse)).toBe(true);
    expect(grantCovers(agent, judgeUse)).toBe(false);
  });

  it("covers both with '*'", () => {
    expect(grantCovers("*", judgeUse)).toBe(true);
    expect(grantCovers("*", agentUse)).toBe(true);
  });

  it("refuses a purpose without a destination and a destination without a purpose", () => {
    expect(SecretGrantSchema.safeParse([{ ...base, purpose: "review-judge" }]).success).toBe(false);
    expect(SecretGrantSchema.safeParse([{ ...base, destination: "https://judge.invalid/v0" }]).success).toBe(false);
    expect(SecretGrantSchema.safeParse([{ ...base, purpose: "agent", destination: "x" }]).success).toBe(false);
  });
});
