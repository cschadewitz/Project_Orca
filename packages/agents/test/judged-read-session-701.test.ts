/**
 * Where a plain-language rule may allow a read (#701 activation review): only a read ORCA performs itself
 * (`fs/read_text_file`), of the file it verified and then reads. The same read asked for by the agent in its own
 * permission request, which the agent carries out itself, goes to the person and the judge is not asked. A real ACP
 * agent over stdio, with a fake judge standing in for #701's.
 */
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type JudgedDecision } from "@orca/core";
import { LocalHost, openAcpSession, type PermissionRuleRecord } from "@orca/agents";
import type { JudgePermission, PlainRuleJudgeOutcome } from "../src/review-judge/plain-rule.js";

/** Reads each file in `READS` through ORCA, then asks permission for `ASK` (a read the agent would do itself). */
const readingAgent = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "reader", version: "0" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    const results = [];
    for (const path of JSON.parse(process.env.READS))
      results.push(await request("fs/read_text_file", { sessionId: "s1", path }));
    if (process.env.ASK)
      results.push(await request("session/request_permission", {
        sessionId: "s1",
        toolCall: { toolCallId: "t1", title: "Read " + process.env.ASK, kind: "read", locations: [{ path: process.env.ASK }] },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
      }));
    require("node:fs").writeFileSync(process.env.RESULT_LOG, JSON.stringify(results));
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve(m.error ? { error: m.error.data } : { result: m.result });
  }
});
setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function fakeJudge(answer?: Partial<PlainRuleJudgeOutcome>) {
  return vi.fn<JudgePermission>(async (input) => ({
    outcome: "allow",
    verdict: "covered",
    ruleId: input.rules[0]!.ruleId,
    ruleRevision: input.rules[0]!.ruleRevision,
    reasonCode: "matches-criterion",
    verdicts: [],
    judgeConfigRef: "judge-ref",
    ...answer,
  }));
}

const READ_RULE = { match: { kind: "read", scope: "workspace" }, judge: { criterion: "Reading the docs." } };

/** A dummy secret value for the session: never a real credential. */
const DUMMY_SECRET = "dummy-s3cret-701";

async function turn(opts: {
  judge?: JudgePermission;
  reads?: string[];
  ask?: string;
  answer?: string;
  /** Give the session a secret whose value is `DUMMY_SECRET`. */
  secret?: boolean;
  /** While the judge decides, put a different file (a new identity) at `docs/a.md`. */
  swapWhileJudging?: boolean;
  /** After the decision, before the I/O (while it is recorded): change the file the judge allowed. */
  beforeIo?: (dir: string) => Promise<void>;
}) {
  const dir = await temp("orca-judged-read-");
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs", "a.md"), "hello\n");
  await writeFile(join(dir, "docs", `${DUMMY_SECRET}.md`), "hello\n");
  const secretFile = join(await temp("orca-judged-read-secret-"), "token");
  await writeFile(secretFile, DUMMY_SECRET);
  const log = join(await temp("orca-judged-read-log-"), "results.json");
  const path = (p: string) => join(dir, p);
  const agent = AgentSpecSchema.parse({
    id: "reader",
    command: process.execPath,
    args: ["-e", readingAgent],
    env: {
      READS: JSON.stringify((opts.reads ?? []).map(path)),
      ...(opts.ask ? { ASK: path(opts.ask) } : {}),
      RESULT_LOG: log,
      ...(opts.secret ? { DUMMY_TOKEN: { secret: "dummy" } } : {}),
    },
    permissions: { default: "ask", rules: [READ_RULE] },
  });
  const decisions: string[] = [];
  const rules: (PermissionRuleRecord | undefined)[] = [];
  const asked: { request: acp.RequestPermissionRequest; judged?: JudgedDecision }[] = [];
  const session = await openAcpSession({
    host: new LocalHost({ id: "local", type: "local" }),
    agent,
    cwd: dir,
    protectedPaths: { readOnly: [], noAccess: [] },
    ...(opts.secret
      ? {
          secrets: { dummy: { host: "local", provider: "file" as const, path: secretFile } },
          authorizeSecretUse: async () => undefined,
        }
      : {}),
    ...(opts.judge
      ? {
          judgePermission: opts.swapWhileJudging
            ? async (input, signal) => {
                const answer = await opts.judge!(input, signal);
                await writeFile(join(dir, "docs", "other.md"), "swapped\n");
                await rename(join(dir, "docs", "other.md"), join(dir, "docs", "a.md"));
                return answer;
              }
            : opts.judge,
        }
      : {}),
    ...(opts.beforeIo
      ? {
          recordFsOperation: async () => {
            await opts.beforeIo!(dir);
            return async () => undefined;
          },
        }
      : {}),
    onPermission: (info) => {
      decisions.push(info.decision);
      rules.push(info.rule);
    },
    askPermission: async (request, _invocation, judged) => {
      asked.push({ request, ...(judged ? { judged } : {}) });
      return opts.answer;
    },
  });
  try {
    await session.prompt("go");
  } finally {
    await session.close();
  }
  const outcomes = JSON.parse(await readFile(log, "utf8")) as { result?: unknown; error?: unknown }[];
  return { outcomes, decisions, rules, asked };
}

describe("a plain-language rule allows a read ORCA performs itself (#701)", () => {
  it("allows ORCA's own read of a verified file once, with nobody asked", async () => {
    const judge = fakeJudge();
    const out = await turn({ judge, reads: ["docs/a.md"] });
    expect(out.asked).toHaveLength(0);
    expect(out.outcomes).toEqual([{ result: { content: "hello\n" } }]);
    expect(out.decisions).toEqual(["fs:judged"]);
    expect(out.rules[0]).toMatchObject({ basis: "judged", judge: { verdict: "covered", ruleId: "config:0" } });
    expect(judge.mock.calls[0]![0].action).toMatchObject({
      kind: "read",
      locations: ["docs/a.md"],
      targetsVerified: true,
    });
  });

  it("asks the person, with the judge's reason, when the judge does not allow it", async () => {
    const judge = fakeJudge({ outcome: "no-match", verdict: "not-covered", reasonCode: "outside-criterion" });
    const out = await turn({ judge, reads: ["docs/a.md"], answer: "reject" });
    expect(out.asked).toHaveLength(1);
    expect(out.asked[0]!.judged).toMatchObject({ verdict: "not-covered", reasonCode: "outside-criterion" });
    expect(out.outcomes[0]).toHaveProperty("error");
  });

  it("asks the person, and never the judge, for a read the agent asks to do itself", async () => {
    const judge = fakeJudge();
    const out = await turn({ judge, ask: "docs/a.md", answer: "no" });
    expect(judge).not.toHaveBeenCalled();
    expect(out.asked).toHaveLength(1);
    expect(out.asked[0]!.judged).toBeUndefined();
    expect(out.decisions).toEqual(["ask:reject_once"]);
  });

  it("sends ORCA's own label for the read, never the agent's wording", async () => {
    const judge = fakeJudge();
    await turn({ judge, reads: ["docs/a.md"] });
    expect(judge.mock.calls[0]![0].action.title).toBe("Read docs/a.md");
  });

  it("asks the person, without contacting the judge, when the description would carry a session secret", async () => {
    const judge = fakeJudge();
    const out = await turn({ judge, reads: [`docs/${DUMMY_SECRET}.md`], answer: "reject", secret: true });
    expect(judge).not.toHaveBeenCalled();
    expect(out.asked).toHaveLength(1);
    expect(out.asked[0]!.judged).toMatchObject({ verdict: "outside-envelope" });
    // The same session's read of a file whose description holds no secret still reaches the judge.
    const clean = fakeJudge();
    const ok = await turn({ judge: clean, reads: ["docs/a.md"], secret: true });
    expect(clean).toHaveBeenCalledTimes(1);
    expect(ok.asked).toHaveLength(0);
  });

  it("reads only the very file the judge was shown: one replaced while it decided goes to the person", async () => {
    const judge = fakeJudge();
    const out = await turn({ judge, reads: ["docs/a.md"], answer: "reject", swapWhileJudging: true });
    expect(judge).toHaveBeenCalledTimes(1);
    // The allow was for the file the I/O was bound to; the one now there is another, so a person is asked.
    expect(out.asked).toHaveLength(1);
    expect(out.asked[0]!.judged).toMatchObject({ verdict: "changed-since" });
    expect(out.outcomes[0]).toHaveProperty("error");
    expect(JSON.stringify(out.outcomes)).not.toContain("swapped");
  });

  it("does not read a judged file that stopped being eligible after the decision, before the I/O", async () => {
    // A second name outside the workspace: the single-link rule the judge relied on no longer holds.
    const outside = await temp("orca-judged-read-outside-");
    const linked = await turn({
      judge: fakeJudge(),
      reads: ["docs/a.md"],
      beforeIo: (dir) => link(join(dir, "docs", "a.md"), join(outside, "a.md")),
    });
    expect(linked.decisions).toEqual(["fs:judged"]);
    expect(linked.outcomes[0]).toHaveProperty("error");
    expect(JSON.stringify(linked.outcomes)).not.toContain("hello");
    // The allowed file moved away and another put at its name: not the file bound, so not read.
    const moved = await turn({
      judge: fakeJudge(),
      reads: ["docs/a.md"],
      beforeIo: async (dir) => {
        await rename(join(dir, "docs", "a.md"), join(dir, "docs", "moved.md"));
        await writeFile(join(dir, "docs", "a.md"), "other\n");
      },
    });
    expect(moved.outcomes[0]).toHaveProperty("error");
    expect(JSON.stringify(moved.outcomes)).not.toContain("other");
  });

  it("asks without a judge, as before", async () => {
    const out = await turn({ reads: ["docs/a.md"], answer: "allow" });
    expect(out.asked).toHaveLength(1);
    expect(out.outcomes).toEqual([{ result: { content: "hello\n" } }]);
  });
});
