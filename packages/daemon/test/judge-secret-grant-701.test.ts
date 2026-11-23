/**
 * #701: a secret grant for review-judge use is separate from a grant for delivery to an agent.
 * Neither covers the other; only `*` covers both.
 */
import { describe, expect, it } from "vitest";
import { grantCovers, SecretGrantSchema, type SecretGrant } from "../src/auth/principal.js";
import { bindSecretUse, LOCAL_PRINCIPAL } from "../src/auth/index.js";

const binding = `h1:${"0".repeat(32)}`;
const base = { secret: "judge-key", provider: "env", host: "local", binding } as const;
const agentUse = { secret: "judge-key", provider: "env", hostId: "local", hostBinding: binding };
const source = `s1:${"a".repeat(32)}`;
const judgeUse = {
  ...agentUse,
  purpose: "review-judge" as const,
  destination: "https://judge.invalid/v0",
  sourceBinding: source,
};
const judgeEntry = { ...base, purpose: "review-judge", destination: judgeUse.destination, source };

describe("#701 review-judge secret grants", () => {
  it("covers a judge use only with the same purpose and destination", () => {
    const judge = SecretGrantSchema.parse([judgeEntry]);
    expect(grantCovers(judge, judgeUse)).toBe(true);
    // Rotating the value at the granted source needs nothing; pointing the id at another source is not covered.
    expect(grantCovers(judge, { ...judgeUse, sourceBinding: `s1:${"b".repeat(32)}` })).toBe(false);
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
    expect(
      SecretGrantSchema.safeParse([{ ...base, purpose: "review-judge", destination: judgeUse.destination }]).success,
    ).toBe(false);
    expect(SecretGrantSchema.safeParse([{ ...base, source }]).success).toBe(false);
    expect(SecretGrantSchema.safeParse([{ ...base, destination: "https://judge.invalid/v0" }]).success).toBe(false);
    expect(SecretGrantSchema.safeParse([{ ...base, purpose: "agent", destination: "x" }]).success).toBe(false);
  });
});

describe("#701 bindSecretUse: a synchronous decision for the judge's dispatch boundary", () => {
  const judgeGrant = SecretGrantSchema.parse([judgeEntry]);
  const principal = (secrets: SecretGrant | undefined) => ({
    ...LOCAL_PRINCIPAL,
    id: "ci-bot",
    kind: "credential" as const,
    secrets,
  });
  const use = { ...judgeUse, provider: "env" as const, agentId: "a" };

  it("answers from the owner's credentials as they are at each call", async () => {
    let current = [principal(judgeGrant)];
    const check = await bindSecretUse(
      {
        root: async (runId) => ({ rootRunId: runId, workflowId: "w" }),
        owner: () => "ci-bot",
        verifyOwner: async () => {},
        principals: () => current,
      },
      "run-1",
    );
    expect(check([use])).toBe(true);
    current = [];
    expect(check([use])).toBe(false);
    current = [principal(SecretGrantSchema.parse([base]))];
    expect(check([use])).toBe(false);
  });

  it("refuses to bind a run with no durable owner", async () => {
    await expect(
      bindSecretUse(
        {
          root: async (runId) => ({ rootRunId: runId, workflowId: "w" }),
          owner: () => "ci-bot",
          verifyOwner: async () => {
            throw new Error("pending");
          },
          principals: () => [principal("*")],
        },
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", details: { reason: "unauthorized" } });
    await expect(
      bindSecretUse(
        { root: async () => undefined, owner: () => "ci-bot", verifyOwner: async () => {}, principals: () => [] },
        "run-1",
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
