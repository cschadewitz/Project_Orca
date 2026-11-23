/**
 * #701 item 3a: the daemon prepares a plain-rule judge per session from the judge config, the run
 * owner's key and disclosure grant, and the qualified budget, and hands nothing to a session while
 * the judge is inactive. No network: preparation reads no key and sends nothing.
 */
import { describe, expect, it } from "vitest";
import { plainRuleDisclosureQuery } from "@orca/agents/review-judge";
import type { SessionFactory } from "@orca/engine";
import { CredentialStore } from "../src/auth/credentials.js";
import { OwnershipStore } from "../src/auth/ownership.js";
import type { QualifiedJudgeBudget } from "../src/judge-budget.js";
import {
  PLAIN_RULE_JUDGE_ACTIVE,
  plainRuleJudgeSource,
  withPlainRuleJudge,
  type PlainRuleJudgeSourceOptions,
} from "../src/plain-rule-judge.js";

const destination = "https://judge.invalid/v1/messages";
const judge = { provider: { kind: "anthropic" }, destination, credential: "judge-key" };
const secrets = { "judge-key": { host: "local", provider: "env" as const, name: "JUDGE_KEY", destination } };
const local = { id: "local", spec: { id: "local", type: "local" as const } };
const remote = { id: "box", spec: { id: "box", type: "ssh", host: "box.invalid" } } as unknown as typeof local;
const signal = new AbortController().signal;
const durable: QualifiedJudgeBudget = Object.freeze({
  status: "durable",
  budget: Object.freeze({
    durable: true as const,
    reserve: async () => true,
    initialize: async () => ({ status: "initialized" as const, day: "2026-11-23" }),
    replace: async () => ({ status: "initialized" as const, day: "2026-11-23" }),
  }),
  storeDir: "/s",
  anchorDir: "/a",
});

async function setup(
  over: Partial<PlainRuleJudgeSourceOptions> & {
    grant?: boolean;
    owned?: boolean;
    /** Extra classes granted beyond reads (#701 per-kind switches). */
    kindGrants?: ("edit" | "mcp" | "command")[];
  } = {},
) {
  const credentials = new CredentialStore();
  const ownership = new OwnershipStore();
  if (over.owned !== false) ownership.record("run-1", "casey");
  await credentials.issue({
    principal: "casey",
    preset: "owner",
    ...(over.grant === false
      ? {}
      : {
          disclosures: [
            plainRuleDisclosureQuery(judge)!,
            ...(over.kindGrants ?? []).map((k) => plainRuleDisclosureQuery(judge, k)!),
          ],
        }),
  });
  const source = plainRuleJudgeSource({
    config: () => ({ review: { plainRules: { judge } } }),
    budget: async () => durable,
    resolver: {
      run: async (id) => (id === "run-1" ? { workflowId: "w" } : undefined),
      inputRun: async () => undefined,
      artifactRun: async () => undefined,
      claimRun: async () => undefined,
      workflowExists: () => true,
    },
    ownership,
    credentials,
    ...over,
  });
  const session = { runId: "run-1", agentId: "a", host: local, secrets };
  return { source, session };
}

describe("#701 daemon plain-rule judge wiring", () => {
  it("prepares a judge from the config, the owner's grant and a durable budget", async () => {
    const { source, session } = await setup();
    const prepared = await source.prepare(session, signal);
    expect(prepared).toMatchObject({ status: "prepared", durableBudget: true });
  });

  it("gives no judge without a config, off the local host, or without a durable budget", async () => {
    let { source, session } = await setup({ config: () => ({}) });
    expect(await source.prepare(session, signal)).toEqual({ status: "unavailable", reason: "not-configured" });
    ({ source, session } = await setup());
    expect(await source.prepare({ ...session, host: remote }, signal)).toMatchObject({ reason: "not-local" });
    ({ source, session } = await setup({
      budget: async () => ({ status: "unavailable", reason: "platform" }),
    }));
    expect(await source.prepare(session, signal)).toMatchObject({ reason: "budget-unavailable" });
    ({ source, session } = await setup({
      budget: async () =>
        ({ ...durable, budget: { ...(durable as { budget: object }).budget, durable: false } }) as QualifiedJudgeBudget,
    }));
    expect(await source.prepare(session, signal)).toMatchObject({ reason: "budget-not-durable" });
  });

  it("gives no judge without the owner's disclosure grant or a durable run owner", async () => {
    let { source, session } = await setup({ grant: false });
    expect(await source.prepare(session, signal)).toMatchObject({ reason: "disclosure-grant-missing" });
    ({ source, session } = await setup({ owned: false }));
    expect(await source.prepare(session, signal)).toMatchObject({ reason: "run-not-authorized" });
    ({ source, session } = await setup());
    expect(await source.prepare({ ...session, runId: "unknown" }, signal)).toMatchObject({
      reason: "run-not-authorized",
    });
  });

  it("never throws, even when a piece does", async () => {
    const { source, session } = await setup({
      budget: async () => {
        throw new Error("boom");
      },
    });
    expect(await source.prepare(session, signal)).toMatchObject({ status: "unavailable" });
  });

  it("is inactive: the session factory is passed through untouched and nothing is prepared", async () => {
    expect(PLAIN_RULE_JUDGE_ACTIVE).toBe(false);
    let prepared = 0;
    const open: SessionFactory = async () => {
      throw new Error("not opened in this test");
    };
    const wrapped = withPlainRuleJudge(open, {
      prepare: async () => {
        prepared++;
        return { status: "unavailable", reason: "not-configured" };
      },
    });
    expect(wrapped).toBe(open);
    expect(prepared).toBe(0);
  });

  it("prepares only the experimental kinds the config turns on, each needing its own grant", async () => {
    const kinds = { edits: true, mcpCalls: true, commands: false };
    let { source, session } = await setup({ kindGrants: ["edit", "mcp", "command"] });
    let prepared = await source.prepare(session, signal);
    expect(prepared).toMatchObject({ status: "prepared", kindsUnavailable: [] });
    expect(prepared.status === "prepared" && Object.keys(prepared.kinds)).toEqual([]);

    const config = () => ({ review: { plainRules: { judge, experimental: { kinds } } } });
    ({ source, session } = await setup({ config, kindGrants: ["edit", "mcp", "command"] }));
    prepared = await source.prepare(session, signal);
    expect(prepared.status === "prepared" && Object.keys(prepared.kinds).sort()).toEqual(["edit", "mcp"]);

    // A kind turned on without its grant is left out; the read judge still stands.
    ({ source, session } = await setup({ config, kindGrants: ["mcp"] }));
    prepared = await source.prepare(session, signal);
    expect(prepared).toMatchObject({
      status: "prepared",
      kindsUnavailable: [{ kind: "edits", reason: "disclosure-grant-missing" }],
    });
    expect(prepared.status === "prepared" && Object.keys(prepared.kinds)).toEqual(["mcp"]);
  });
});
