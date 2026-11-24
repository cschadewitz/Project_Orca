/**
 * The judged lane (#702): a plain-language rule may allow one call once, only inside the hard
 * boundaries checked in code before any judge is asked, and only if the rule is still there
 * when the answer goes out. A fake judge stands in for #701's.
 */
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  AgentSpecSchema,
  OrcaEventSchema,
  PermissionPolicySchema,
  type PermissionPolicy,
  type PermissionRule,
} from "@orca/core";
import {
  decidePermission,
  judgedLane,
  loadEffectivePermissionPolicy,
  resolvePermission,
  type JudgedLane,
  type PermissionEvalContext,
} from "@orca/agents";
import type { JudgePermission, PlainRuleJudgeOutcome } from "../src/review-judge/plain-rule.js";

let ws: string;
let ctx: PermissionEvalContext;
beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), "orca-judged-")));
  await mkdir(join(ws, "src"));
  await writeFile(join(ws, "src", "a.ts"), "export {};\n");
  await writeFile(join(ws, "orca.config.yaml"), "agents: []\n");
  ctx = { workspaceCwd: ws, protectedPaths: { readOnly: [join(ws, "orca.config.yaml")], noAccess: [] } };
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const READ_RULE = {
  match: { kind: "read" as const, scope: "workspace" as const },
  judge: { criterion: "Reading source." },
};

/** The evaluated policy for an agent whose config has `rules`, with `default: ask`. */
async function policyOf(rules: unknown[], extra: Record<string, unknown> = {}): Promise<PermissionPolicy> {
  const agent = AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask", rules, ...extra } });
  return loadEffectivePermissionPolicy(agent, []);
}

const call = (kind: string, ...paths: string[]): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: {
    toolCallId: "t",
    kind: kind as acp.ToolKind,
    title: `${kind} ${paths.join(" ")}`,
    locations: paths.map((path) => ({ path })),
  },
  options: [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
});

/** A judge that answers `covered` for the first rule sent, or whatever `answer` says. */
function fakeJudge(answer?: (input: Parameters<JudgePermission>[0]) => Partial<PlainRuleJudgeOutcome>) {
  return vi.fn<JudgePermission>(async (input) => ({
    outcome: "allow",
    verdict: "covered",
    ruleId: input.rules[0]!.ruleId,
    ruleRevision: input.rules[0]!.ruleRevision,
    reasonCode: "matches-criterion",
    verdicts: [],
    judgeConfigRef: "judge-ref",
    ...(answer ? answer(input) : {}),
  }));
}

const signal = () => new AbortController().signal;

describe("a judged rule in the config", () => {
  it("parses with a criterion in place of a decision, and is refused with both, or with none", () => {
    expect(PermissionPolicySchema.safeParse({ rules: [READ_RULE] }).success).toBe(true);
    expect(PermissionPolicySchema.safeParse({ rules: [{ ...READ_RULE, decision: "allow" }] }).success).toBe(false);
    expect(PermissionPolicySchema.safeParse({ rules: [{ match: {}, judge: { criterion: "  " } }] }).success).toBe(
      false,
    );
    expect(
      PermissionPolicySchema.safeParse({
        rules: [{ match: { kind: "execute", command: "git *" }, judge: { criterion: "x" } }],
      }).success,
    ).toBe(false);
  });

  it("is carried apart from the typed rules, named by its place as written", async () => {
    const policy = await policyOf([{ match: { kind: "fetch" }, decision: "deny" }, READ_RULE]);
    expect(policy.rules[0]).toEqual({ match: { kind: "fetch" }, decision: "deny" });
    expect(policy.rules).toHaveLength(1);
    expect(policy.origins).toEqual([{ layer: "config", index: 0 }]);
    expect(policy.judged).toEqual([
      {
        match: READ_RULE.match,
        criterion: "Reading source.",
        ruleId: "config:1",
        ruleRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    // Synchronous decisions never consult a judged rule: this is ask, as without it.
    expect(decidePermission(policy, call("read", join(ws, "src", "a.ts")), ctx)).toBe("ask");
  });

  it("is left out when a sidecar could not be read: it might have held the restriction", async () => {
    const agent = AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask", rules: [READ_RULE] } });
    const bad = join(ws, "bad.json");
    await writeFile(bad, "{not json");
    const policy = await loadEffectivePermissionPolicy(agent, [bad], () => undefined);
    expect(policy.judged).toBeUndefined();
  });
});

describe("the judged lane", () => {
  const file = () => join(ws, "src", "a.ts");
  const lane = (judge: JudgePermission, reload: () => Promise<PermissionPolicy>): JudgedLane =>
    judgedLane({ judge, reload, localHost: true });

  it("allows once by the rule the judge said covers the call, after reading the policy again", async () => {
    const policy = await policyOf([READ_RULE]);
    const judge = fakeJudge();
    const reload = vi.fn(async () => policy);
    const explained = await lane(judge, reload)(policy, call("read", file()), ctx, signal());
    expect(explained).toEqual({
      decision: "allow",
      basis: "judged",
      judged: {
        verdict: "covered",
        reasonCode: "matches-criterion",
        judgeConfigRef: "judge-ref",
        ruleId: "config:0",
        ruleRevision: policy.judged![0]!.ruleRevision,
      },
    });
    expect(reload).toHaveBeenCalledOnce();
    // The judge saw ORCA's verified, workspace-relative location, and no restriction.
    expect(judge.mock.calls[0]![0]).toMatchObject({
      rules: [{ ruleId: "config:0", criterion: "Reading source." }],
      restrictions: { deny: false, ask: false },
      action: { kind: "read", locations: ["src/a.ts"], inWorkspace: true, targetsVerified: true },
    });
  });

  it("does not ask the judge when a typed rule already allows, or for ORCA's own files", async () => {
    const judge = fakeJudge();
    const allowing = await policyOf([{ match: { kind: "read" }, decision: "allow" }, READ_RULE]);
    expect((await lane(judge, async () => allowing)(allowing, call("read", file()), ctx, signal())).basis).toBe("rule");
    const policy = await policyOf([{ match: { kind: "read" }, judge: { criterion: "anything" } }]);
    const own = await lane(judge, async () => policy)(
      policy,
      call("read", join(ws, "orca.config.yaml")),
      {
        ...ctx,
        protectedPaths: { readOnly: [], noAccess: [join(ws, "orca.config.yaml")] },
      },
      signal(),
    );
    expect(own).toEqual({ decision: "deny", basis: "protected" });
    expect(judge).not.toHaveBeenCalled();
  });

  it.each<[string, PermissionRule]>([
    ["a deny", { match: { kind: "read", pathPrefix: "src" }, decision: "deny" }],
    ["an ask", { match: { kind: "read", path: "src/a.ts" }, decision: "ask" }],
  ])("is closed by %s rule that matches anywhere, even after the judged rule", async (_, restriction) => {
    const policy = await policyOf([READ_RULE, restriction]);
    const judge = fakeJudge();
    const explained = await lane(judge, async () => policy)(policy, call("read", file()), ctx, signal());
    expect(explained).toMatchObject({
      decision: restriction.decision,
      basis: "rule",
      judged: { verdict: "hard-boundary" },
    });
    expect(judge).not.toHaveBeenCalled();
  });

  it("is closed outside the envelope: writes, commands, missing or outside files, directories", async () => {
    const judge = fakeJudge();
    const wide = await policyOf([{ match: {}, judge: { criterion: "anything" } }]);
    const run = (request: acp.RequestPermissionRequest) => lane(judge, async () => wide)(wide, request, ctx, signal());
    expect((await run(call("edit", file()))).judged).toEqual({ verdict: "outside-envelope" });
    const command = call("read", file());
    command.toolCall.rawInput = { command: "cat src/a.ts" };
    expect((await run(command)).judged).toEqual({ verdict: "outside-envelope" });
    expect((await run(call("read", join(ws, "src", "missing.ts")))).judged).toEqual({ verdict: "outside-envelope" });
    expect((await run(call("read", join(ws, "src")))).judged).toEqual({ verdict: "outside-envelope" });
    expect((await run(call("read"))).judged).toEqual({ verdict: "outside-envelope" });
    // A call claiming an MCP tool ORCA cannot verify is never allowed (#1021).
    const claimed = call("read", file());
    claimed.toolCall._meta = { "gemini-cli": { mcp: { server_name: "fs", tool_name: "read" } } };
    expect((await run(claimed)).judged).toEqual({ verdict: "outside-envelope" });
    expect(judge).not.toHaveBeenCalled();
  });

  it("leaves the typed answer on any other verdict, a throw, or an allow for a rule it was not sent", async () => {
    const policy = await policyOf([READ_RULE]);
    const notCovered = fakeJudge(() => ({
      outcome: "no-match",
      verdict: "not-covered",
      reasonCode: "outside-criterion",
    }));
    expect(await lane(notCovered, async () => policy)(policy, call("read", file()), ctx, signal())).toEqual({
      decision: "ask",
      basis: "default",
      judged: { verdict: "not-covered", reasonCode: "outside-criterion", judgeConfigRef: "judge-ref" },
    });
    const throwing = vi.fn<JudgePermission>(async () => {
      throw new Error("boom");
    });
    expect((await lane(throwing, async () => policy)(policy, call("read", file()), ctx, signal())).judged).toEqual({
      verdict: "unavailable",
    });
    const stranger = fakeJudge(() => ({ ruleId: "config:9" }));
    expect(await lane(stranger, async () => policy)(policy, call("read", file()), ctx, signal())).toMatchObject({
      decision: "ask",
      judged: { verdict: "malformed" },
    });
  });

  it("does not honour a rule edited, removed or newly restricted while the judge was thinking", async () => {
    const policy = await policyOf([READ_RULE]);
    const edited = await policyOf([{ ...READ_RULE, judge: { criterion: "Reading tests only." } }]);
    const denied = await policyOf([READ_RULE, { match: { kind: "read" }, decision: "deny" }]);
    const judge = fakeJudge();
    expect(await lane(judge, async () => edited)(policy, call("read", file()), ctx, signal())).toMatchObject({
      decision: "ask",
      judged: { verdict: "changed-since" },
    });
    expect(await lane(judge, async () => denied)(policy, call("read", file()), ctx, signal())).toMatchObject({
      decision: "deny",
      judged: { verdict: "changed-since" },
    });
  });

  it("allows only the very file the judge was shown, not a file that took its place (#702 review)", async () => {
    const policy = await policyOf([READ_RULE]);
    // Replaced while the judge was thinking: same name, still eligible, another file.
    const replaced = fakeJudge();
    replaced.mockImplementationOnce(async (input) => {
      await writeFile(join(ws, "src", "next.ts"), "other\n");
      await rename(join(ws, "src", "next.ts"), file());
      return {
        outcome: "allow",
        verdict: "covered",
        ruleId: input.rules[0]!.ruleId,
        ruleRevision: input.rules[0]!.ruleRevision,
        verdicts: [],
        judgeConfigRef: "judge-ref",
      };
    });
    expect(await lane(replaced, async () => policy)(policy, call("read", file()), ctx, signal())).toMatchObject({
      decision: "ask",
      judged: { verdict: "changed-since" },
    });
  });

  it("stays closed for a session whose files are not on the daemon's own machine", async () => {
    const policy = await policyOf([READ_RULE]);
    const judge = fakeJudge();
    const remote = judgedLane({ judge, reload: async () => policy, localHost: false });
    expect(await remote(policy, call("read", file()), ctx, signal())).toEqual({
      decision: "ask",
      basis: "default",
      judged: { verdict: "outside-envelope" },
    });
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("answering with the judged lane", () => {
  it("answers allow once, never allow always, and records the rule by its id without its revision", async () => {
    const policy = await policyOf([READ_RULE]);
    const judged = judgedLane({ judge: fakeJudge(), reload: async () => policy, localHost: true });
    const answered = await resolvePermission(policy, {
      request: call("read", join(ws, "src", "a.ts")),
      scope: ctx,
      judged,
    });
    expect(answered).toEqual({
      response: { outcome: { outcome: "selected", optionId: "once" } },
      decision: "allow",
      rule: {
        basis: "judged",
        judge: { verdict: "covered", ruleId: "config:0", reasonCode: "matches-criterion", judgeConfigRef: "judge-ref" },
      },
    });
  });

  it("hands the judge's no to the person's ask, so the card can say why it came to them (#701)", async () => {
    const policy = await policyOf([READ_RULE]);
    const ask = vi.fn(async () => "once");
    const answered = await resolvePermission(policy, {
      request: call("read", join(ws, "src", "a.ts")),
      scope: ctx,
      ask,
      judged: judgedLane({
        judge: fakeJudge(() => ({ outcome: "no-match", verdict: "not-covered", reasonCode: "outside-criterion" })),
        reload: async () => policy,
        localHost: true,
      }),
    });
    expect(answered.decision).toBe("ask:allow_once");
    expect(ask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ verdict: "not-covered", reasonCode: "outside-criterion" }),
    );
  });

  it("answers a turn that ended while the judge was thinking as expired, not allowed", async () => {
    const policy = await policyOf([READ_RULE]);
    const controller = new AbortController();
    const judge = fakeJudge();
    judge.mockImplementationOnce(async (input) => {
      controller.abort();
      return {
        outcome: "allow",
        verdict: "covered",
        ruleId: input.rules[0]!.ruleId,
        ruleRevision: input.rules[0]!.ruleRevision,
        verdicts: [],
        judgeConfigRef: "judge-ref",
      };
    });
    const answered = await resolvePermission(policy, {
      request: call("read", join(ws, "src", "a.ts")),
      scope: ctx,
      signal: controller.signal,
      judged: judgedLane({ judge, reload: async () => policy, localHost: true }),
    });
    expect(answered.decision).toBe("ask:expired");
    expect(answered.response).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("keeps the rule's revision out of the public event", () => {
    const e = OrcaEventSchema.parse({
      id: "evt_0",
      seq: 0,
      runId: "run_1",
      at: "2026-01-01T00:00:00.000Z",
      type: "agent.permission",
      payload: {
        stepRunId: "s",
        sessionId: "x",
        title: "read",
        decision: "allow",
        rule: { basis: "judged", judge: { verdict: "covered", ruleId: "config:0", ruleRevision: "ab".repeat(32) } },
      },
    });
    if (e.type !== "agent.permission") throw new Error("wrong type");
    expect(e.payload.rule).toEqual({ basis: "judged", judge: { verdict: "covered", ruleId: "config:0" } });
  });
});
