/** A real ACP process keeps its prompt open at permission asks; lifecycle ends invalidate those callbacks. */
import { afterEach, expect, it, vi } from "vitest";
import { AgentSpecSchema, OrcaError } from "@orca/core";
import { LocalHost, type AgentSession } from "@orca/agents";
import {
  openAcpSession,
  type OpenSessionOptions,
  type PermissionInvocation,
  type SessionContinuity,
} from "../src/acp-session.js";

const source = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...m})+'\\n');
let prompt, session, generation = 0;
rl.on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'initialize') send({id:m.id,result:{protocolVersion:m.params.protocolVersion,agentCapabilities:{loadSession:process.env.LOAD === '1'}}});
 else if(m.method === 'session/new') { session = 'fresh'; send({id:m.id,result:{sessionId:session}}); }
 else if(m.method === 'session/load') {
   if(process.env.FAIL_LOAD) send({id:m.id,error:{code:-32602,message:'unavailable'}});
   else {session=m.params.sessionId; send({id:m.id,result:{}});}
 }
 else if(m.method === 'session/prompt') {
   prompt = m.id;
   generation++;
   send({id:'ask-'+generation,method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'same-tool',title:'Execute?',kind:'execute'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Deny',kind:'reject_once'}]}});
   if(process.env.DIE) setTimeout(()=>process.exit(1), 100);
 } else if(m.method === 'session/cancel') { if(prompt !== undefined) { send({id:prompt,result:{stopReason:'cancelled'}}); prompt = undefined; } }
 else if(typeof m.id === 'string' && m.id.startsWith('ask-') && m.result && prompt !== undefined) {
   send({method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}}}});
   send({id:prompt,result:{stopReason:'end_turn'}}); prompt=undefined;
 }
});
`;
const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

async function open(extra: Partial<OpenSessionOptions> = {}, env: Record<string, string> = {}) {
  const host = new LocalHost({ id: "local", type: "local" });
  const agent = AgentSpecSchema.parse({
    id: "live",
    command: process.execPath,
    args: ["-e", source],
    env,
    permissions: { default: "ask" },
  });
  const session = await openAcpSession({ host, agent, cwd: process.cwd(), ...extra });
  sessions.push(session);
  return session;
}

it("delivers an explicit answer to the same prompt and mints a new invocation even for the same tool id", async () => {
  const invocations: PermissionInvocation[] = [];
  let answer!: (value: string) => void;
  const session = await open({
    askPermission: (_req, invocation) => {
      invocations.push(invocation!);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  const output: string[] = [];
  session.onUpdate((e) => {
    if (e.summary.text) output.push(e.summary.text);
  });
  let ended = false;
  const turn = session.prompt("go").then((r) => {
    ended = true;
    return r;
  });
  await vi.waitFor(() => expect(invocations).toHaveLength(1));
  expect(ended).toBe(false);
  expect(invocations[0]!.signal.aborted).toBe(false);
  answer("yes");
  expect(await turn).toMatchObject({ stopReason: "end_turn" });
  expect(output.join("")).toContain('"optionId":"yes"');
  expect(invocations[0]!.signal.aborted).toBe(true);
  const second = session.prompt("again");
  await vi.waitFor(() => expect(invocations).toHaveLength(2));
  expect(invocations[1]!.sessionId).toBe(invocations[0]!.sessionId);
  expect(invocations[1]!.turnId).not.toBe(invocations[0]!.turnId);
  expect(invocations[1]!.invocationId).not.toBe(invocations[0]!.invocationId);
  answer("no");
  await second;
});

it.each(["cancel", "timeout", "close"] as const)(
  "expires a pending callback on %s even if the host never answers",
  async (action) => {
    let invocation: PermissionInvocation | undefined;
    const session = await open({
      askPermission: (_req, live) => {
        invocation = live;
        return new Promise(() => {});
      },
    });
    const turn = session.prompt("go", action === "timeout" ? { timeoutMs: 100 } : {});
    void turn.catch(() => undefined);
    await vi.waitFor(() => expect(invocation).toBeDefined());
    if (action === "cancel") await session.cancel();
    if (action === "close") await session.close();
    await vi.waitFor(() => expect(invocation!.signal.aborted).toBe(true));
    await turn.catch(() => undefined);
  },
);

it("propagates a host parking error to the original prompt without translating it to AGENT_PROTOCOL", async () => {
  const parked = new OrcaError("HUMAN_INPUT_PENDING", "standing write failed");
  const session = await open({
    askPermission: async () => {
      throw parked;
    },
  });
  await expect(session.prompt("go")).rejects.toBe(parked);
});

it.each([
  [{}, "fresh", "load-unsupported"],
  [{ LOAD: "1" }, "loaded", "load-supported"],
  [{ LOAD: "1", FAIL_LOAD: "1" }, "fresh", "load-failed"],
] as const)("checks session/load capability and reports an honest fallback (%j)", async (env, mode, reason) => {
  let continuity: SessionContinuity | undefined;
  const session = await open(
    {
      resumeSessionId: "previous",
      onSessionContinuity: (s) => {
        continuity = s;
      },
    },
    env,
  );
  expect(continuity).toEqual({ mode, reason });
  expect(session.acpSessionId).toBe(mode === "loaded" ? "previous" : "fresh");
});

it("agent death expires the callback without waiting for a UI response", async () => {
  let live: PermissionInvocation | undefined;
  const session = await open(
    {
      askPermission: (_req, invocation) => {
        live = invocation;
        return new Promise(() => {});
      },
    },
    { DIE: "1" },
  );
  const turn = session.prompt("go");
  void turn.catch(() => undefined);
  await vi.waitFor(() => expect(live).toBeDefined());
  await expect(turn).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
  expect(live!.signal.aborted).toBe(true);
});

it("a rejected host response from a cancelled turn cannot cancel the next turn", async () => {
  const failures: ((error: unknown) => void)[] = [];
  const answers: ((value: string) => void)[] = [];
  const session = await open({
    askPermission: () =>
      new Promise((resolve, reject) => {
        answers.push(resolve);
        failures.push(reject);
      }),
  });
  const first = session.prompt("first");
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  await session.cancel();
  await first;
  const second = session.prompt("second");
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  failures[0]!(new Error("late host failure"));
  await Promise.resolve();
  answers[1]!("yes");
  expect(await second).toMatchObject({ stopReason: "end_turn" });
});
