/**
 * #701 item 3a: the daemon prepares a plain-rule judge per session from the judge config, the run
 * owner's key and disclosure grant, and the qualified budget, and hands nothing to a session while
 * the judge is inactive. No network: preparation reads no key and sends nothing.
 */
import { describe, expect, it } from "vitest";
import type { OpenSessionOptions } from "@orca/agents";
import { plainRuleDisclosureQuery } from "@orca/agents/review-judge";
import type { SessionFactory } from "@orca/engine";
import { CredentialStore } from "../src/auth/credentials.js";
import { OwnershipStore } from "../src/auth/ownership.js";
import type { QualifiedJudgeBudget } from "../src/judge-budget.js";
import { judgedSessionFactory } from "../src/plain-rule-judge-session.js";
import * as daemonIndex from "../src/index.js";
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
  const config = over.config ?? (() => ({ review: { plainRules: { enabled: true, judge } } }));
  const source = plainRuleJudgeSource({
    config,
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
  // A run pinned to a generation with the same settings as the active one.
  const session = { runId: "run-1", agentId: "a", host: local, secrets, pinned: { review: config()?.review } };
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

  it("gives no judge, and reads nothing, until the owner opts in with enabled: true (#701 activation review)", async () => {
    let budgetReads = 0;
    for (const enabled of [undefined, false]) {
      const config = () => ({ review: { plainRules: { judge, ...(enabled === undefined ? {} : { enabled }) } } });
      const { source, session } = await setup({
        config,
        budget: async () => {
          budgetReads++;
          return durable;
        },
      });
      expect(await source.prepare(session, signal)).toEqual({ status: "unavailable", reason: "not-enabled" });
    }
    expect(budgetReads).toBe(0);
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

  it("is active: every session the factory opens is offered to the judge source first", async () => {
    expect(PLAIN_RULE_JUDGE_ACTIVE).toBe(true);
    let prepared = 0;
    const opened: OpenSessionOptions[] = [];
    const open: SessionFactory = async (options) => {
      opened.push(options);
      return { id: "s" } as never;
    };
    const wrapped = withPlainRuleJudge(open, {
      prepare: async () => {
        prepared++;
        return { status: "unavailable", reason: "not-configured" };
      },
    });
    expect(wrapped).not.toBe(open);
    const options = {
      agent: { id: "a" },
      host: local,
      secrets,
      origin: { runId: "r" },
    } as unknown as OpenSessionOptions;
    await wrapped(options);
    expect(prepared).toBe(1);
    // No judge: the very options asked for, nothing added or replaced.
    expect(opened).toEqual([options]);
  });

  it("prepares only the experimental kinds the config turns on, each needing its own grant", async () => {
    const kinds = { edits: true, mcpCalls: true, commands: false };
    let { source, session } = await setup({ kindGrants: ["edit", "mcp", "command"] });
    let prepared = await source.prepare(session, signal);
    expect(prepared).toMatchObject({ status: "prepared", kindsUnavailable: [] });
    expect(prepared.status === "prepared" && Object.keys(prepared.kinds)).toEqual([]);

    const config = () => ({ review: { plainRules: { enabled: true, judge, experimental: { kinds } } } });
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

  it("reads the run's pinned judge settings, and none when the active generation now says otherwise", async () => {
    let { source, session } = await setup();
    // A run bound to no generation has nothing pinned to read.
    expect(await source.prepare({ ...session, pinned: undefined }, signal)).toEqual({
      status: "unavailable",
      reason: "config-not-pinned",
    });
    // Its generation configured no judge.
    expect(await source.prepare({ ...session, pinned: { review: undefined } }, signal)).toMatchObject({
      reason: "not-configured",
    });
    // The active generation has another judge, or another switch: neither set is used.
    const other = { ...judge, credential: "other-key" };
    expect(
      await source.prepare({ ...session, pinned: { review: { plainRules: { enabled: true, judge: other } } } }, signal),
    ).toMatchObject({ reason: "config-changed" });
    const kinds = { review: { plainRules: { enabled: true, judge, experimental: { kinds: { mcpCalls: true } } } } };
    expect(await source.prepare({ ...session, pinned: kinds }, signal)).toMatchObject({ reason: "config-changed" });
    // Not configured anywhere: nothing to say.
    ({ source, session } = await setup({ config: () => ({}) }));
    expect(await source.prepare({ ...session, pinned: undefined }, signal)).toMatchObject({ reason: "not-configured" });
  });

  it("stops when the run is cancelled or the deadline passes, even mid-read", async () => {
    let { source, session } = await setup();
    const done = new AbortController();
    done.abort();
    expect(await source.prepare(session, done.signal)).toMatchObject({ reason: "cancelled" });
    // A budget read that never settles is not waited for past the abort.
    const stop = new AbortController();
    ({ source, session } = await setup({ budget: () => new Promise(() => undefined) }));
    const pending = source.prepare(session, stop.signal);
    stop.abort();
    expect(await pending).toMatchObject({ status: "unavailable", reason: "cancelled" });
  });
});

describe("#701 the judged session factory, once active", () => {
  const prepared = { status: "prepared", judge: async () => ({ outcome: "not-fit" }), kinds: {}, kindsUnavailable: [] };
  function harness(prepare: (s: unknown, signal: AbortSignal) => Promise<unknown>, prepareMs = 1_000) {
    const opened: unknown[] = [];
    const seen: { session: unknown; signal: AbortSignal }[] = [];
    const unavailable: unknown[] = [];
    const open: SessionFactory = async (options) => {
      opened.push(options);
      return { id: "s" } as never;
    };
    const factory = judgedSessionFactory(
      open,
      {
        prepare: (async (session: unknown, signal: AbortSignal) => {
          seen.push({ session, signal });
          return prepare(session, signal);
        }) as never,
      },
      (info) => unavailable.push(info),
      prepareMs,
    );
    return { factory, opened, seen, unavailable };
  }
  const options = (origin: object | undefined, extra: object = {}) =>
    ({
      agent: { id: "a" },
      host: local,
      secrets,
      ...(origin ? { origin } : {}),
      ...extra,
    }) as unknown as OpenSessionOptions & { origin?: { runId: string } };

  it("is not exported from the package: only withPlainRuleJudge reaches it", () => {
    expect(daemonIndex).not.toHaveProperty("judgedSessionFactory");
    expect(daemonIndex).toHaveProperty("withPlainRuleJudge");
  });

  it("hands the prepared judge to the session, from the run's pinned settings", async () => {
    const review = { plainRules: { judge } };
    const h = harness(async () => prepared);
    await h.factory(options({ runId: "run-1", generationId: "g", review }));
    expect(h.seen[0]!.session).toMatchObject({ runId: "run-1", pinned: { review } });
    expect(h.opened[0]).toMatchObject({ judgePermission: prepared.judge, judgeKinds: {} });
    // No generation: nothing pinned.
    await h.factory(options({ runId: "run-1" }));
    expect(h.seen[1]!.session).toMatchObject({ pinned: undefined });
  });

  it("falls back to exactly the session asked for, so every typed rule and the human ask stand", async () => {
    const h = harness(async () => ({ status: "unavailable", reason: "config-changed" }));
    const asked = options({ runId: "run-1", generationId: "g" });
    await h.factory(asked);
    expect(h.opened).toEqual([asked]);
    expect(h.opened[0]).toBe(asked);
    expect(h.opened[0]).not.toHaveProperty("judgePermission");
    expect(h.opened[0]).not.toHaveProperty("judgeKinds");
    expect(h.unavailable).toEqual([{ runId: "run-1", agentId: "a", reason: "config-changed" }]);
  });

  it("never replaces a judge the session already carries", async () => {
    const h = harness(async () => prepared);
    const own = async () => ({ outcome: "fit" });
    const asked = options({ runId: "run-1", generationId: "g" }, { judgePermission: own });
    await h.factory(asked);
    expect(h.seen).toEqual([]);
    expect(h.opened[0]).toBe(asked);
  });

  it("opens without a judge when preparation runs past the deadline", async () => {
    const h = harness(
      (_s, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ status: "unavailable", reason: "cancelled" })),
        ),
      20,
    );
    const asked = options({ runId: "run-1", generationId: "g", signal: new AbortController().signal });
    await h.factory(asked);
    expect(h.opened[0]).toBe(asked);
    expect(h.unavailable).toEqual([{ runId: "run-1", agentId: "a", reason: "prepare-deadline" }]);
  });

  it("opens nothing when the run is cancelled while the judge is prepared", async () => {
    const run = new AbortController();
    const h = harness(
      (_s, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "unavailable", reason: "cancelled" }));
          run.abort("stop");
        }),
    );
    await expect(h.factory(options({ runId: "run-1", generationId: "g", signal: run.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(h.seen[0]!.signal.aborted).toBe(true);
    expect(h.opened).toEqual([]);
    // Even a judge that was ready by then is not handed to a cancelled run.
    const late = new AbortController();
    const g = harness(async () => {
      late.abort();
      return prepared;
    });
    await expect(g.factory(options({ runId: "run-1", generationId: "g", signal: late.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(g.opened).toEqual([]);
  });

  it("checks the run's cancellation before passing a session that already has a judge through", async () => {
    const run = new AbortController();
    run.abort("stop");
    const h = harness(async () => prepared);
    const own = async () => ({ outcome: "fit" });
    await expect(
      h.factory(options({ runId: "run-1", generationId: "g", signal: run.signal }, { judgePermission: own })),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(h.factory(options({ runId: "run-1", generationId: "g", signal: run.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(h.seen).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("bounds its own wait: a source that ignores the signal cannot hold the session or hand over a late judge", async () => {
    // Never settles, and never looks at the signal.
    let h = harness(() => new Promise(() => undefined), 20);
    let asked = options({ runId: "run-1", generationId: "g", signal: new AbortController().signal });
    await h.factory(asked);
    expect(h.opened).toEqual([asked]);
    expect(h.unavailable).toEqual([{ runId: "run-1", agentId: "a", reason: "prepare-deadline" }]);

    // Answers `prepared` well after the deadline, ignoring the signal: that judge is not used.
    let late!: () => void;
    h = harness(
      () =>
        new Promise((resolve) => {
          late = () => resolve(prepared);
        }),
      20,
    );
    asked = options({ runId: "run-1", generationId: "g", signal: new AbortController().signal });
    await h.factory(asked);
    late();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.opened).toEqual([asked]);
    expect(h.opened[0]).not.toHaveProperty("judgePermission");

    // Stalled, then the run is cancelled: the factory stops at once and opens nothing.
    const run = new AbortController();
    h = harness(() => new Promise(() => undefined), 60_000);
    const pending = h.factory(options({ runId: "run-1", generationId: "g", signal: run.signal }));
    run.abort("stop");
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.opened).toEqual([]);

    // A source that throws gives no judge.
    h = harness(() => {
      throw new Error("boom");
    });
    asked = options({ runId: "run-1", generationId: "g" });
    await h.factory(asked);
    expect(h.opened).toEqual([asked]);
    expect(h.unavailable).toEqual([{ runId: "run-1", agentId: "a", reason: "run-not-authorized" }]);
  });
});
