/**
 * The experimental edit class end to end (#701 per-kind switches): a real ACP agent over stdio asks ORCA to write a
 * file, the typed rules ask, and a judged rule naming `edit` may allow that one write once, with nobody asked. Without
 * the edit judge, or on the judge's no, the person is asked as before. A fake judge stands in for #701's.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema } from "@orca/core";
import { LocalHost, openAcpSession, type PermissionRuleRecord } from "@orca/agents";
import type { JudgePermission, PlainRuleJudgeOutcome } from "../src/review-judge/plain-rule.js";

/** An ACP agent that asks ORCA to write each file in `WRITES` during its turn, and logs what came back. */
const writingAgent = `
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
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "writer", version: "0" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    const results = [];
    for (const path of JSON.parse(process.env.WRITES))
      results.push(await request("fs/write_text_file", { sessionId: "s1", path, content: "written\\n" }));
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

const EDIT_RULE = { match: { kind: "edit", pathPrefix: "docs" }, judge: { criterion: "Editing the docs." } };

async function turn(opts: { edit?: JudgePermission; read?: JudgePermission; answer?: string }) {
  const dir = await temp("orca-judged-edit-");
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs", "a.md"), "before\n");
  const log = join(await temp("orca-judged-edit-log-"), "results.json");
  const agent = AgentSpecSchema.parse({
    id: "writer",
    command: process.execPath,
    args: ["-e", writingAgent],
    env: { WRITES: JSON.stringify([join(dir, "docs", "a.md")]), RESULT_LOG: log },
    permissions: { default: "ask", rules: [EDIT_RULE] },
  });
  const decisions: string[] = [];
  const rules: (PermissionRuleRecord | undefined)[] = [];
  const asked: acp.RequestPermissionRequest[] = [];
  const session = await openAcpSession({
    host: new LocalHost({ id: "local", type: "local" }),
    agent,
    cwd: dir,
    protectedPaths: { readOnly: [], noAccess: [] },
    ...(opts.read ? { judgePermission: opts.read } : {}),
    ...(opts.edit ? { judgeKinds: { edit: opts.edit } } : {}),
    onPermission: (info) => {
      decisions.push(info.decision);
      rules.push(info.rule);
    },
    askPermission: async (request: acp.RequestPermissionRequest) => {
      asked.push(request);
      return opts.answer;
    },
  });
  try {
    await session.prompt("go");
  } finally {
    await session.close();
  }
  const outcomes = JSON.parse(await readFile(log, "utf8")) as { result?: unknown; error?: unknown }[];
  return { outcomes, decisions, rules, asked, content: await readFile(join(dir, "docs", "a.md"), "utf8") };
}

describe("ORCA's own write, judged (#701 edit class)", () => {
  it("is allowed once by a judged edit rule, with nobody asked, and recorded as judged", async () => {
    const edit = fakeJudge();
    const out = await turn({ read: fakeJudge(), edit });
    expect(out.content).toBe("written\n");
    expect(out.asked).toHaveLength(0);
    expect(out.decisions).toEqual(["fs:judged"]);
    expect(out.rules[0]).toMatchObject({ basis: "judged", judge: { kind: "edit", ruleId: "config:0" } });
    expect(edit.mock.calls[0]![0].action).toMatchObject({ kind: "edit", locations: ["docs/a.md"] });
  });

  it("goes to the person without the edit judge, or on the judge's no", async () => {
    const without = await turn({ read: fakeJudge(), answer: "reject" });
    expect(without.asked).toHaveLength(1);
    expect(without.content).toBe("before\n");

    const edit = fakeJudge({ outcome: "no-match", verdict: "not-covered", reasonCode: "outside-criterion" });
    const declined = await turn({ read: fakeJudge(), edit, answer: "reject" });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(declined.asked).toHaveLength(1);
    expect(declined.content).toBe("before\n");
    expect(declined.decisions[0]).toBe("fs:judged:not-allowed");
  });

  it("is not used without the read judge: the experimental classes ride with it", async () => {
    const edit = fakeJudge();
    const out = await turn({ edit, answer: "reject" });
    expect(edit).not.toHaveBeenCalled();
    expect(out.content).toBe("before\n");
  });
});
