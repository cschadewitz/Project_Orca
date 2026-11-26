/**
 * Recovery and resume of the Codex app-server driver (#1158) against scripted app-servers:
 * an app-server that exits fails its turn and is restarted on the same thread by the next
 * prompt, within a crash budget with backoff; a restart is held to the same policy checks as
 * the open; an ask is never answered once its process is gone; and a resumed thread replays its
 * history, or falls back to a new thread unless recovery is required.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, OrcaError as OrcaErrorClass, silentLogger, type OrcaError } from "@orca/core";
import {
  codexHistoryUpdates,
  LocalHost,
  openCodexAppServerSession,
  type AgentHost,
  type AgentProcessHandle,
  type CodexSessionContinuity,
  type SessionUpdateEvent,
} from "../src/index.js";
import {
  CONFIG_ANSWERS,
  configRead,
  WRITE_SANDBOX,
  PINNED_IMAGE,
  VERIFIED_IMAGE,
  HOOKED_CONFIG_ANSWERS,
  HOOK_COMMAND,
} from "./codex-config-fixture.js";

const CWD = process.cwd();
const INIT = { userAgent: "orca/0.171.0 (test)", codexHome: "/h/.codex", platformFamily: "unix", platformOs: "linux" };

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** One scripted app-server process. */
interface Proc {
  received: Msg[];
  say(message: unknown): void;
  /** Codex exits: its stdout ends and the process is gone. */
  crash(): void;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => void>>;
}

type Responder = (msg: Msg, proc: Proc, n: number) => unknown;
const NO_ANSWER = Symbol("no answer");

const thread = (id: string, over: Record<string, unknown> = {}) => ({
  thread: { id },
  model: "gpt-5.5",
  cwd: CWD,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: WRITE_SANDBOX,
  reasoningEffort: null,
  ...over,
});

const BASE: Record<string, Responder> = {
  initialize: () => INIT,
  ...CONFIG_ANSWERS,
  "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }),
  "thread/start": () => thread("thr_1"),
  "thread/resume": (msg) => thread(msg.params!["threadId"] as string),
  "thread/turns/list": () => ({ data: [], nextCursor: null, backwardsCursor: null }),
  "model/list": () => ({ data: [], nextCursor: null }),
  "thread/unsubscribe": () => ({ status: "unsubscribed" }),
  "turn/start": (_msg, proc, n) => {
    const turnId = `turn_${n}`;
    setImmediate(() =>
      proc.say({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: turnId, status: "completed" } } }),
    );
    return { turn: { id: turnId, status: "inProgress" } };
  },
};

/** A host whose every spawn is a new scripted app-server; `answers` sees which process (0, 1, ...) asks. */
/** How a scripted process behaves beyond its answers. */
interface ProcOptions {
  /** Its stdout can end while the process stays alive, and no signal stops it. */
  hang?: boolean;
  stderr?: string;
  secret?: string;
}

function scriptedHost(
  answers: (procIndex: number) => Record<string, Responder>,
  procOptions: (procIndex: number) => ProcOptions = () => ({}),
) {
  const procs: Proc[] = [];
  let turns = 0;
  const spawnAgent = vi.fn(async (_spec: unknown): Promise<AgentProcessHandle> => {
    const index = procs.length;
    const table = answers(index);
    const po = procOptions(index);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let exit!: (e: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => (exit = r));
    const proc: Proc = {
      received: [],
      say: (m) => {
        if (!stdout.writableEnded) stdout.write(JSON.stringify(m) + "\n");
      },
      crash: () => {
        stdout.end();
        if (!po.hang) exit({ code: 1, signal: null });
      },
      kill: vi.fn((_signal?: NodeJS.Signals) => {
        if (po.hang) return;
        if (!stdout.writableEnded) stdout.end();
        exit({ code: null, signal: "SIGTERM" });
      }),
    };
    procs.push(proc);
    let buffer = "";
    stdin.on("data", (d: Buffer) => {
      buffer += d.toString();
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        const msg = JSON.parse(buffer.slice(0, nl)) as Msg;
        buffer = buffer.slice(nl + 1);
        proc.received.push(msg);
        if (msg.method && msg.id !== undefined) {
          const answer = table[msg.method];
          if (!answer) proc.say({ id: msg.id, error: { code: -32600, message: `unknown variant \`${msg.method}\`` } });
          else {
            const result = answer(msg, proc, msg.method === "turn/start" ? ++turns : 0);
            if (result !== NO_ANSWER) proc.say({ id: msg.id, result });
          }
        }
      }
    });
    return {
      get stream(): never {
        throw new Error("no ACP stream");
      },
      stdio: () => ({ stdin, stdout }),
      pid: 4000 + index,
      exited,
      stderrTail: () => po.stderr ?? "",
      kill: proc.kill,
      ...(po.secret ? { secretValues: new Map([["CODEX_TOKEN", po.secret]]) } : {}),
    };
  });
  const host = new LocalHost({ id: "local", type: "local" }) as AgentHost;
  host.spawnAgent = spawnAgent;
  return { host, procs, spawnAgent };
}

const agent = () => AgentSpecSchema.parse({ id: "codex", command: process.execPath, driver: "codex-app-server" });

const open = (host: AgentHost, more: Partial<Parameters<typeof openCodexAppServerSession>[0]> = {}) =>
  openCodexAppServerSession({
    host,
    agent: agent(),
    cwd: CWD,
    thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    logger: silentLogger,
    ...VERIFIED_IMAGE,
    sleep: async () => {},
    ...more,
  });

/** Let the session see a crash. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** The config checks around a thread's start or resume (#1160). */
const CHECKS = ["config/read", "configRequirements/read", "hooks/list"];

const methods = (p: Proc) => p.received.map((m) => m.method).filter(Boolean);

describe("an app-server that exits", () => {
  it("fails the running turn, and the next prompt restarts it on the same thread with ORCA's policy", async () => {
    const s = scriptedHost((i) => ({
      ...BASE,
      // the first app-server exits during its turn
      ...(i === 0
        ? {
            "turn/start": (_m, proc) => (
              setImmediate(() => proc.crash()),
              { turn: { id: "t0", status: "inProgress" } }
            ),
          }
        : {}),
    }));
    const session = await open(s.host);
    await expect(session.prompt("one")).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
    await expect(session.prompt("two")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
    expect(methods(s.procs[1]!)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      ...CHECKS,
      "thread/resume",
      ...CHECKS,
      "turn/start",
    ]);
    expect(s.procs[1]!.received.find((m) => m.method === "thread/resume")?.params).toEqual({
      threadId: "thr_1",
      cwd: CWD,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      model: "gpt-5.5",
      excludeTurns: true,
    });
    expect(s.procs[1]!.received.find((m) => m.method === "turn/start")?.params).toMatchObject({ threadId: "thr_1" });
    expect(session.acpSessionId).toBe("thr_1");
    await session.close();
    expect(methods(s.procs[1]!).at(-1)).toBe("thread/unsubscribe");
    expect(s.procs[1]!.kill).toHaveBeenCalled();
  });

  it("restarts after an exit between turns too", async () => {
    const s = scriptedHost(() => BASE);
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it("ends a prompt cancelled during the restart as cancelled, starting no turn, and a closed session restarts nothing", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const s = scriptedHost(() => BASE);
    const session = await open(s.host, { sleep: () => held, recovery: { backoffMs: [100] } });
    s.procs[0]!.crash();
    await settle();
    const turn = session.prompt("go");
    await settle();
    await session.cancel();
    release();
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(s.procs.flatMap(methods)).not.toContain("turn/start");

    const t = scriptedHost(() => BASE);
    let wake!: () => void;
    const waiting = new Promise<void>((r) => (wake = r));
    const other = await open(t.host, { sleep: () => waiting, recovery: { backoffMs: [100] } });
    t.procs[0]!.crash();
    await settle();
    const pending = other.prompt("go");
    await settle();
    await other.close();
    wake();
    await expect(pending).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(t.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("does not start a second app-server while the one whose stdout closed cannot be seen gone", async () => {
    const s = scriptedHost(
      () => BASE,
      (i) => ({ hang: i === 0 }),
    );
    const session = await open(s.host, { exitGraceMs: 10 });
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.message).toMatch(/could not be confirmed gone, so ORCA does not start another on its thread/);
    expect(s.procs[0]!.kill.mock.calls.map((c) => c[0])).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("stops the session when a refused replacement cannot be seen gone, starting no third app-server", async () => {
    const s = scriptedHost(
      (i) => ({
        ...BASE,
        ...(i === 1 ? { "thread/resume": () => thread("thr_1", { approvalsReviewer: "auto_review" }) } : {}),
      }),
      (i) => ({ hang: i === 1 }),
    );
    const session = await open(s.host, { exitGraceMs: 10 });
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("AGENT_TRANSPORT");
    expect(error.message).toMatch(/app-server ORCA was starting could not be confirmed gone/);
    expect(s.procs[1]!.kill.mock.calls.map((c) => c[0])).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("stops the session when a replacement cancelled in its resume cannot be seen gone, starting no third app-server", async () => {
    const s = scriptedHost(
      (i) => (i === 1 ? { ...BASE, "thread/resume": () => NO_ANSWER } : BASE),
      (i) => ({ hang: i === 1 }),
    );
    const session = await open(s.host, { requestTimeoutMs: 60_000, exitGraceMs: 10 });
    s.procs[0]!.crash();
    await settle();
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(s.procs[1]?.received.some((m) => m.method === "thread/resume")).toBe(true));
    void session.cancel();
    const error = (await turn.catch((e: unknown) => e)) as OrcaError;
    expect(error.message).toMatch(/app-server ORCA was starting could not be confirmed gone/);
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("stops a replacement stalled in its handshake when the session closes, and terminates once both are gone", async () => {
    const s = scriptedHost((i) => (i === 1 ? { ...BASE, initialize: () => NO_ANSWER } : BASE));
    const session = await open(s.host, { requestTimeoutMs: 60_000 });
    s.procs[0]!.crash();
    await settle();
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(s.procs[1]?.received.some((m) => m.method === "initialize")).toBe(true));
    const at = Date.now();
    await session.close();
    expect(Date.now() - at).toBeLessThan(2_000);
    await expect(turn).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(s.procs[1]!.kill).toHaveBeenCalled();
    await expect(session.terminated).resolves.toBeUndefined();
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("stops a replacement stalled in its resume when the prompt is cancelled, ends it cancelled, and counts no crash", async () => {
    const s = scriptedHost((i) => (i === 1 ? { ...BASE, "thread/resume": () => NO_ANSWER } : BASE));
    const session = await open(s.host, { requestTimeoutMs: 60_000, recovery: { crashLimit: 2 } });
    s.procs[0]!.crash();
    await settle();
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(s.procs[1]?.received.some((m) => m.method === "thread/resume")).toBe(true));
    const at = Date.now();
    await session.cancel();
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(Date.now() - at).toBeLessThan(2_000);
    expect(s.procs[1]!.kill).toHaveBeenCalled();
    expect(s.procs[1]!.received.some((m) => m.method === "turn/start")).toBe(false);
    // one exit so far against a budget of two: the next prompt restarts and runs
    await expect(session.prompt("again")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.spawnAgent).toHaveBeenCalledTimes(3);
    await session.close();
  });

  it("keeps the session's secrets out of what it logs about an exit or a refused resume", async () => {
    const SENTINEL = "sk-orca-1158-sentinel";
    const records: unknown[] = [];
    const logger = {
      log: (...a: unknown[]) => void records.push(a),
      debug: (...a: unknown[]) => void records.push(a),
      info: (...a: unknown[]) => void records.push(a),
      warn: (...a: unknown[]) => void records.push(a),
      error: (...a: unknown[]) => void records.push(a),
      child: () => logger,
    };
    const s = scriptedHost(
      () => ({
        ...BASE,
        "thread/resume": (msg, proc) => {
          proc.say({ id: msg.id, error: { code: -32600, message: `no rollout for ${SENTINEL}` } });
          return NO_ANSWER;
        },
      }),
      () => ({ secret: SENTINEL, stderr: `panicked with token ${SENTINEL}` }),
    );
    const session = await open(s.host, { logger: logger, resumeThreadId: "thr_old" });
    s.procs[0]!.crash();
    await settle();
    await session.close();
    const logged = JSON.stringify(records);
    expect(logged).toContain("Codex could not resume the thread");
    expect(logged).toContain("Codex app-server exited");
    expect(logged).toContain("panicked with token");
    expect(logged).not.toContain(SENTINEL);
  });

  it("hands each app-server's secret values to the run before ORCA sends it anything, a restarted one included", async () => {
    const reported: { values: readonly string[]; sentToNewest: number }[] = [];
    const s = scriptedHost(
      () => BASE,
      (i) => ({ secret: `sk-orca-sentinel-${i}` }),
    );
    const session = await open(s.host, {
      onSecretValues: (values) => reported.push({ values, sentToNewest: s.procs[s.procs.length - 1]!.received.length }),
    });
    s.procs[0]!.crash();
    await settle();
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(reported).toEqual([
      { values: ["sk-orca-sentinel-0"], sentToNewest: 0 },
      { values: ["sk-orca-sentinel-0", "sk-orca-sentinel-1"], sentToNewest: 0 },
    ]);
    await session.close();
  });

  describe("a run that cannot take an app-server's secret values", () => {
    const failing = () => {
      throw new Error("callback broke near sk-orca-callback-sentinel");
    };
    const sanitized = (error: OrcaError) => {
      expect(error.details).toMatchObject({ reason: "codex-secret-redaction" });
      expect(JSON.stringify(error) + error.message + String(error.stack)).not.toContain("sk-orca-callback-sentinel");
    };

    it("refuses the open and stops the process before it is sent anything", async () => {
      const s = scriptedHost(
        () => BASE,
        () => ({ secret: "sk-orca-sentinel-0" }),
      );
      const error = (await open(s.host, { onSecretValues: failing }).catch((e: unknown) => e)) as OrcaError;
      sanitized(error);
      expect(s.procs[0]!.received).toEqual([]);
      expect(s.procs[0]!.kill).toHaveBeenCalled();
    });

    it("stops the session when a replacement's values cannot be taken", async () => {
      let calls = 0;
      const s = scriptedHost(
        () => BASE,
        (i) => ({ secret: `sk-orca-sentinel-${i}` }),
      );
      const session = await open(s.host, { onSecretValues: () => (++calls === 2 ? failing() : undefined) });
      s.procs[0]!.crash();
      await settle();
      const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
      sanitized(error);
      expect(s.procs[1]!.received).toEqual([]);
      expect(s.procs[1]!.kill).toHaveBeenCalled();
      await expect(session.prompt("again")).rejects.toBe(error);
      expect(s.spawnAgent).toHaveBeenCalledTimes(2);
    });
  });

  it("ends the session, without starting it, when the file is another build at a restart (#1162)", async () => {
    const s = scriptedHost(() => BASE);
    let starts = 0;
    const imageFile = vi.fn(async () => (++starts === 1 ? PINNED_IMAGE : { ...PINNED_IMAGE, sha256: "0".repeat(64) }));
    const session = await open(s.host, { imageFile });
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.details).toMatchObject({ reason: "codex-image-unverified" });
    expect(imageFile).toHaveBeenCalledTimes(2);
    // Never started: the host was asked once, for the first process.
    expect(s.spawnAgent).toHaveBeenCalledTimes(1);
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when a restart is cancelled or closed while its file is checked (#1162)", async () => {
    const held = () => {
      let release!: () => void;
      let calls = 0;
      const gate = new Promise<void>((r) => (release = r));
      const imageFile = vi.fn(async () => {
        if (++calls > 1) await gate;
        return PINNED_IMAGE;
      });
      return { imageFile, release: () => release() };
    };

    const a = held();
    const s = scriptedHost(() => BASE);
    const session = await open(s.host, { imageFile: a.imageFile });
    s.procs[0]!.crash();
    await settle();
    const turn = session.prompt("go");
    await settle();
    expect(a.imageFile).toHaveBeenCalledTimes(2);
    const cancelled = session.cancel();
    a.release();
    await cancelled;
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(s.spawnAgent).toHaveBeenCalledTimes(1);

    const b = held();
    const t = scriptedHost(() => BASE);
    const other = await open(t.host, { imageFile: b.imageFile });
    t.procs[0]!.crash();
    await settle();
    const pending = other.prompt("go");
    await settle();
    expect(b.imageFile).toHaveBeenCalledTimes(2);
    const closed = other.close();
    b.release();
    await closed;
    await expect(pending).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(t.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("ends the session when a restarted process does not run the checked file (#1162)", async () => {
    const s = scriptedHost(() => BASE);
    const imageDigest = vi.fn(async (pid: number | undefined) =>
      pid === 4000 ? PINNED_IMAGE : { ...PINNED_IMAGE, ino: PINNED_IMAGE.ino + 1 },
    );
    const session = await open(s.host, { imageDigest });
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.details).toMatchObject({ reason: "codex-image-unverified" });
    expect(imageDigest.mock.calls.map((c) => c[0])).toEqual([4000, 4001]);
    expect(s.procs[1]!.received).toEqual([]);
    expect(s.procs[1]!.kill).toHaveBeenCalled();
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("ends the session when ORCA's hook cannot be admitted on a restarted app-server (#1161)", async () => {
    const s = scriptedHost(() => ({ ...BASE, ...HOOKED_CONFIG_ANSWERS }));
    const admit = vi.fn(async (pid: number | undefined) => {
      if (pid !== 4000) throw new OrcaErrorClass("NOT_SUPPORTED", "the hook did not block a call it must block");
    });
    const session = await open(s.host, { nativeToolHook: { sessionFlags: [], command: HOOK_COMMAND, admit } });
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(admit.mock.calls.map((c) => c[0])).toEqual([4000, 4001]);
    expect(methods(s.procs[1]!)).not.toContain("thread/resume");
    expect(methods(s.procs[1]!)).not.toContain("turn/start");
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("never answers an ask once its process is gone", async () => {
    const s = scriptedHost((i) => ({
      ...BASE,
      ...(i === 0
        ? {
            "turn/start": (_m, proc) => {
              setImmediate(() => {
                proc.say({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "thr_1" } });
                proc.crash();
              });
              return { turn: { id: "t0", status: "inProgress" } };
            },
          }
        : {}),
    }));
    const session = await open(s.host);
    await expect(session.prompt("one")).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.procs[0]!.received.some((m) => m.id === 99)).toBe(false);
    await session.close();
  });

  it("refuses a restart whose resumed thread is not what ORCA asked for, and counts it", async () => {
    const s = scriptedHost((i) => ({
      ...BASE,
      ...(i === 1 ? { "thread/resume": () => thread("thr_1", { approvalsReviewer: "auto_review" }) } : {}),
    }));
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("AGENT_TRANSPORT");
    expect(error.message).toMatch(/could not restart the Codex app-server: .*approvals reviewer "auto_review"/);
    expect(s.procs[1]!.kill).toHaveBeenCalled();
    expect(methods(s.procs[1]!)).not.toContain("turn/start");
    // the next prompt tries again, with a third app-server
    await expect(session.prompt("again")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.spawnAgent).toHaveBeenCalledTimes(3);
    await session.close();
  });

  it("stops the session, rather than retrying, when the replacement's config no longer holds (#1160)", async () => {
    const s = scriptedHost((i) => ({
      ...BASE,
      ...(i === 1 ? { "config/read": () => configRead({ sandbox_mode: "danger-full-access" }) } : {}),
    }));
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain('Codex would run with sandbox_mode = "danger-full-access"');
    expect(methods(s.procs[1]!)).not.toContain("thread/resume");
    expect(s.procs[1]!.kill).toHaveBeenCalled();
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("ends a prompt cancelled during the replacement's config reads as cancelled, and a later prompt restarts", async () => {
    for (const stall of ["config/read", "configRequirements/read", "hooks/list"]) {
      let reads = 0;
      const s = scriptedHost((i) => ({
        ...BASE,
        // the replacement stalls in its first check (before the resume)
        ...(i === 1
          ? { [stall]: () => (reads++ === 0 ? NO_ANSWER : CONFIG_ANSWERS[stall as keyof typeof CONFIG_ANSWERS]()) }
          : {}),
      }));
      const session = await open(s.host, { requestTimeoutMs: 60_000 });
      s.procs[0]!.crash();
      await settle();
      const turn = session.prompt("go");
      await vi.waitFor(() => expect(s.procs[1]?.received.some((m) => m.method === stall)).toBe(true));
      await session.cancel();
      await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(s.procs[1]!.kill).toHaveBeenCalled();
      // not broken: the next prompt starts a third app-server and runs
      await expect(session.prompt("again")).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(s.spawnAgent).toHaveBeenCalledTimes(3);
      await session.close();
    }
  });

  it("stops the session when the resumed thread comes back with another sandbox", async () => {
    const s = scriptedHost((i) => ({
      ...BASE,
      ...(i === 1
        ? {
            "thread/resume": (msg) =>
              thread(msg.params!["threadId"] as string, { sandbox: { type: "readOnly", networkAccess: false } }),
          }
        : {}),
    }));
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toMatch(/resumed the thread with sandbox "readOnly"/);
    expect(s.procs[1]!.kill).toHaveBeenCalled();
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("stops the session when the resumed thread could write a path ORCA protects", async () => {
    const s = scriptedHost(() => BASE);
    const session = await open(s.host, { protectedPaths: ["/tmp/orca-1160-sidecar"] }).catch((e: unknown) => e);
    // the open itself is refused: /tmp is writable in the scripted sandbox
    expect((session as OrcaError).message).toContain("which overlaps ORCA's protected /tmp/orca-1160-sidecar");
    const t = scriptedHost((i) => ({
      ...BASE,
      ...(i === 0
        ? {
            "thread/start": () =>
              thread("thr_1", { sandbox: { ...WRITE_SANDBOX, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }),
          }
        : {}),
    }));
    const opened = await open(t.host, { protectedPaths: ["/tmp/orca-1160-sidecar"] });
    t.procs[0]!.crash();
    await settle();
    const error = (await opened.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.message).toContain("which overlaps ORCA's protected /tmp/orca-1160-sidecar");
    await expect(opened.prompt("again")).rejects.toBe(error);
    expect(t.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("stops the session when the replacement runs on another account (#1164)", async () => {
    const s = scriptedHost((i) => ({
      ...BASE,
      ...(i === 1
        ? {
            "account/read": () => ({
              account: { type: "chatgpt", planType: "pro" },
              userId: "u2",
              requiresOpenaiAuth: true,
            }),
          }
        : {}),
    }));
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.details).toMatchObject({ reason: "codex-account-switched" });
    expect(methods(s.procs[1]!)).not.toContain("thread/resume");
    await expect(session.prompt("again")).rejects.toBe(error);
    expect(s.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it("stops the session when the replacement reports another account while it resumes (#1164)", async () => {
    let switched = false;
    const s = scriptedHost((i) => ({
      ...BASE,
      "account/read": () => ({
        account: { type: "chatgpt", planType: "pro" },
        userId: switched ? "u2" : "u1",
        requiresOpenaiAuth: true,
      }),
      ...(i === 1
        ? {
            "thread/resume": (m: Msg, proc: Proc) => {
              switched = true;
              proc.say({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro", reason: null } });
              return thread(m.params!["threadId"] as string);
            },
          }
        : {}),
    }));
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.details).toMatchObject({ reason: "codex-account-switched" });
    expect(methods(s.procs[1]!)).not.toContain("turn/start");
    await expect(session.prompt("again")).rejects.toBe(error);
  });

  it("reads an account update sent during the replacement's config checks before resuming the thread (#1164)", async () => {
    let switched = false;
    const s = scriptedHost((i) => ({
      ...BASE,
      "account/read": () => ({
        account: { type: "chatgpt", planType: "pro" },
        userId: switched ? "u2" : "u1",
        requiresOpenaiAuth: true,
      }),
      ...(i === 1
        ? {
            "config/read": (m: Msg, proc: Proc, n: number) => {
              if (!switched) {
                switched = true;
                proc.say({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro", reason: null } });
              }
              return BASE["config/read"]!(m, proc, n);
            },
          }
        : {}),
    }));
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.details).toMatchObject({ reason: "codex-account-switched" });
    expect(methods(s.procs[1]!)).toContain("config/read");
    expect(methods(s.procs[1]!)).not.toContain("thread/resume");
  });

  it("reads an account update sent with the last answer before the replacement takes the turn (#1164)", async () => {
    let switched = false;
    const s = scriptedHost((i) => ({
      ...BASE,
      "account/read": () => ({
        account: { type: "chatgpt", planType: "pro" },
        userId: switched ? "u2" : "u1",
        requiresOpenaiAuth: true,
      }),
      ...(i === 1
        ? {
            // the post-resume hooks/list answer and an account update arrive back to back
            "hooks/list": (m: Msg, proc: Proc, n: number) => {
              if (!m.params!["threadId"]) return BASE["hooks/list"]!(m, proc, n);
              switched = true;
              proc.say({ id: m.id, result: BASE["hooks/list"]!(m, proc, n) });
              proc.say({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro", reason: null } });
              return NO_ANSWER;
            },
          }
        : {}),
    }));
    const session = await open(s.host);
    s.procs[0]!.crash();
    await settle();
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.details).toMatchObject({ reason: "codex-account-switched" });
    expect(methods(s.procs[1]!)).toContain("thread/resume");
    expect(methods(s.procs[1]!)).not.toContain("turn/start");
  });

  describe("a replacement Codex connects the thread to another environment (#1154)", () => {
    const foreign = (proc: Proc) =>
      proc.say({ method: "thread/environment/connected", params: { threadId: "thr_1", environmentId: "devbox" } });

    it("while it resumes the thread: no prompt is sent to it", async () => {
      const s = scriptedHost((i) => ({
        ...BASE,
        ...(i === 1
          ? {
              "thread/resume": (m: Msg, proc: Proc) => (foreign(proc), thread(m.params!["threadId"] as string)),
            }
          : {}),
      }));
      const session = await open(s.host);
      s.procs[0]!.crash();
      await settle();
      const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
      expect(error.details).toMatchObject({ reason: "codex-foreign-environment" });
      expect(methods(s.procs[1]!)).toContain("thread/resume");
      expect(methods(s.procs[1]!)).not.toContain("turn/start");
      await expect(session.prompt("again")).rejects.toBe(error);
    });

    it("before it resumes the thread: the thread is not resumed on it", async () => {
      const s = scriptedHost((i) => ({
        ...BASE,
        ...(i === 1
          ? { "account/read": (m: Msg, proc: Proc, n: number) => (foreign(proc), BASE["account/read"]!(m, proc, n)) }
          : {}),
      }));
      const session = await open(s.host);
      s.procs[0]!.crash();
      await settle();
      const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
      expect(error.details).toMatchObject({ reason: "codex-foreign-environment" });
      expect(methods(s.procs[1]!)).not.toContain("thread/resume");
    });

    it("with the last answer before the replacement takes the turn", async () => {
      const s = scriptedHost((i) => ({
        ...BASE,
        ...(i === 1
          ? {
              "hooks/list": (m: Msg, proc: Proc, n: number) => {
                if (!m.params!["threadId"]) return BASE["hooks/list"]!(m, proc, n);
                proc.say({ id: m.id, result: BASE["hooks/list"]!(m, proc, n) });
                foreign(proc);
                return NO_ANSWER;
              },
            }
          : {}),
      }));
      const session = await open(s.host);
      s.procs[0]!.crash();
      await settle();
      const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
      expect(error.details).toMatchObject({ reason: "codex-foreign-environment" });
      expect(methods(s.procs[1]!)).not.toContain("turn/start");
    });
  });

  it("stops the session after the crash budget, waiting the backoff before each restart", async () => {
    const sleep = vi.fn(async () => {});
    // every app-server after the first exits as soon as its thread is resumed
    const s = scriptedHost((i) => ({
      ...BASE,
      ...(i > 0
        ? { "thread/resume": (m, proc) => (setImmediate(() => proc.crash()), thread(m.params!["threadId"] as string)) }
        : {}),
      "turn/start": (_m, proc) => (setImmediate(() => proc.crash()), { turn: { id: "t", status: "inProgress" } }),
    }));
    const session = await open(s.host, { sleep, recovery: { crashLimit: 3, backoffMs: [50, 100, 200] } });
    const failures: string[] = [];
    for (let i = 0; i < 4; i++)
      failures.push(((await session.prompt(`p${i}`).catch((e: unknown) => e)) as OrcaError).message);
    // the third exit fails its turn with the budget, and the session takes nothing more
    expect(failures[0]).toBe("codex app-server connection closed");
    expect(failures[1]).toBe("codex app-server connection closed");
    expect(failures[2]).toMatch(/exited or failed to restart 3 times within 300s; ORCA stops the session/);
    expect(failures[3]).toBe(failures[2]);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([50, 100]);
    const spawned = s.spawnAgent.mock.calls.length;
    await expect(session.prompt("more")).rejects.toThrow(/ORCA stops the session/);
    expect(s.spawnAgent.mock.calls.length).toBe(spawned);
    expect(spawned).toBe(3);
    await session.close();
  });

  it("forgets exits older than the window", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const s = scriptedHost(() => BASE);
    const session = await open(s.host, { clock: clock as never, recovery: { crashLimit: 2, windowMs: 60_000 } });
    for (let i = 0; i < 4; i++) {
      s.procs.at(-1)!.crash();
      await settle();
      now += 61_000;
      await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    }
    expect(s.spawnAgent).toHaveBeenCalledTimes(5);
    await session.close();
  });

  it("ends the session on a protocol error rather than restarting", async () => {
    const s = scriptedHost(() => ({
      ...BASE,
      "turn/start": (_m, proc) => (
        setImmediate(() => proc.say({ method: "turn/plan/updated", params: { threadId: "thr_1", plan: "x" } })),
        { turn: { id: "t", status: "inProgress" } }
      ),
    }));
    const session = await open(s.host);
    await expect(session.prompt("go")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    await expect(session.prompt("again")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    expect(s.spawnAgent).toHaveBeenCalledTimes(1);
    await session.close();
  });
});

describe("resuming a thread", () => {
  const user = (text: string) => ({
    type: "userMessage",
    id: `u-${text}`,
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
  });
  const cmd = {
    type: "commandExecution",
    id: "c1",
    command: "/bin/bash -lc 'ls'",
    cwd: CWD,
    commandActions: [{ type: "unknown", command: "ls" }],
    status: "completed",
    aggregatedOutput: "a\n",
    exitCode: 0,
  };
  const pages: Record<string, unknown> = {
    "": {
      data: [
        {
          id: "t1",
          status: "completed",
          items: [user("first"), { type: "reasoning", id: "r", summary: ["hm"], content: [] }, cmd],
        },
      ],
      nextCursor: "p2",
    },
    p2: {
      data: [
        { id: "t2", status: "completed", items: [{ type: "agentMessage", id: "m", text: "done" }, user("second")] },
      ],
      nextCursor: null,
    },
  };
  const history: Responder = (msg) => pages[(msg.params!["cursor"] as string | undefined) ?? ""];

  it("resumes with ORCA's policy and replays the history, page by page, before the session is returned", async () => {
    const s = scriptedHost(() => ({ ...BASE, "thread/turns/list": history }));
    const events: SessionUpdateEvent[] = [];
    let continuity: CodexSessionContinuity | undefined;
    const session = await open(s.host, {
      resumeThreadId: "thr_old",
      onUpdate: (e) => events.push(e),
      onSessionContinuity: (c) => (continuity = c),
    });
    expect(session.acpSessionId).toBe("thr_old");
    expect(continuity).toEqual({ mode: "loaded", reason: "load-supported" });
    expect(methods(s.procs[0]!)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      ...CHECKS,
      "thread/resume",
      "thread/turns/list",
      "thread/turns/list",
      ...CHECKS,
      "model/list",
    ]);
    expect(s.procs[0]!.received.find((m) => m.method === "thread/resume")?.params).toMatchObject({
      threadId: "thr_old",
      approvalsReviewer: "user",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      excludeTurns: true,
    });
    expect(s.procs[0]!.received.filter((m) => m.method === "thread/turns/list").map((m) => m.params)).toEqual([
      { threadId: "thr_old", sortDirection: "asc", itemsView: "full", limit: 50 },
      { threadId: "thr_old", sortDirection: "asc", itemsView: "full", limit: 50, cursor: "p2" },
    ]);
    expect(events.map((e) => [e.summary.kind, e.summary.status, e.summary.text, e.sessionId])).toEqual([
      ["user_message_chunk", undefined, "first", "thr_old"],
      ["agent_thought_chunk", undefined, "hm", "thr_old"],
      ["tool_call", "in_progress", undefined, "thr_old"],
      ["tool_call_update", "completed", undefined, "thr_old"],
      ["agent_message_chunk", undefined, "done", "thr_old"],
      ["user_message_chunk", undefined, "second", "thr_old"],
    ]);
    await session.close();
  });

  it("starts a new thread when the resume is refused, unless recovery is required", async () => {
    const refused: Responder = (msg, proc) => {
      proc.say({ id: msg.id, error: { code: -32600, message: "no rollout found for thread id thr_old" } });
      return NO_ANSWER;
    };
    const s = scriptedHost(() => ({ ...BASE, "thread/resume": refused }));
    let continuity: CodexSessionContinuity | undefined;
    const session = await open(s.host, { resumeThreadId: "thr_old", onSessionContinuity: (c) => (continuity = c) });
    expect(session.acpSessionId).toBe("thr_1");
    expect(continuity).toEqual({ mode: "fresh", reason: "load-failed" });
    await session.close();

    const required = scriptedHost(() => ({ ...BASE, "thread/resume": refused }));
    const error = (await open(required.host, { resumeThreadId: "thr_old", requireContextRecovery: true }).catch(
      (e: unknown) => e,
    )) as OrcaError;
    expect(error).toMatchObject({ code: "AGENT_PROTOCOL", details: { contextRecoveryReason: "load-failed" } });
    // provider text stays out of the failure
    expect(error.message).not.toContain("rollout");
    expect(methods(required.procs[0]!)).not.toContain("thread/start");
    expect(required.procs[0]!.kill).toHaveBeenCalled();
  });

  it("does not resume a thread whose history is malformed, or one resumed with another policy", async () => {
    const bad = scriptedHost(() => ({
      ...BASE,
      "thread/turns/list": () => ({
        data: [{ id: "t", items: [{ type: "agentMessage", id: "m" }] }],
        nextCursor: null,
      }),
    }));
    await expect(open(bad.host, { resumeThreadId: "thr_old", requireContextRecovery: true })).rejects.toMatchObject({
      details: { contextRecoveryReason: "load-failed" },
    });
    const loop = scriptedHost(() => ({
      ...BASE,
      "thread/turns/list": () => ({ data: [], nextCursor: "same" }),
    }));
    await expect(open(loop.host, { resumeThreadId: "thr_old", requireContextRecovery: true })).rejects.toMatchObject({
      details: { contextRecoveryReason: "load-failed" },
    });
    const other = scriptedHost(() => ({
      ...BASE,
      "thread/resume": () => thread("thr_old", { approvalPolicy: "never" }),
    }));
    await expect(open(other.host, { resumeThreadId: "thr_old", requireContextRecovery: true })).rejects.toMatchObject({
      details: { contextRecoveryReason: "load-failed" },
    });
    // without the requirement, a new thread is started instead
    const fallback = scriptedHost(() => ({
      ...BASE,
      "thread/resume": () => thread("thr_old", { approvalPolicy: "never" }),
    }));
    const session = await open(fallback.host, { resumeThreadId: "thr_old" });
    expect(session.acpSessionId).toBe("thr_1");
    await session.close();
  });

  it("asks for a thread id before starting anything when recovery is required", async () => {
    const s = scriptedHost(() => BASE);
    await expect(open(s.host, { requireContextRecovery: true })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: { contextRecoveryReason: "missing-thread-id" },
    });
    expect(s.spawnAgent).not.toHaveBeenCalled();
  });

  it("maps saved items as a live run reported them", () => {
    expect(codexHistoryUpdates({ type: "agentMessage", id: "m", text: "" } as never)).toEqual([]);
    expect(
      codexHistoryUpdates({
        type: "userMessage",
        id: "u",
        clientId: null,
        content: [{ type: "localImage", path: "/x" }],
      } as never),
    ).toEqual([]);
    expect(codexHistoryUpdates({ type: "contextCompaction", id: "c" } as never)).toEqual([]);
    expect(
      codexHistoryUpdates({ type: "webSearch", id: "w", query: "q" } as never).map((u) => u.sessionUpdate),
    ).toEqual(["tool_call", "tool_call_update"]);
  });
});
