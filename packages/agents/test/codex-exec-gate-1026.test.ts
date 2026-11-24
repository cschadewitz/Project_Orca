/**
 * ORCA's gate in Codex's executor path (#1026), against a stand-in executor: what it decides,
 * what it passes, what it refuses, and that a request it does not allow reaches no executor.
 * The real pair is in `packages/cli/test/codex-exec-gate-acceptance-1026.test.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  codexExecGateBinder,
  codexExecGateBudget,
  codexExecGateDecider,
  codexExecGateHeldBytes,
  codexExecPath,
  codexExecUri,
  newCodexExecGateConnectionState,
  openCodexExecGate,
  permissionPolicyPath,
  planCodexExecRequest,
  spawnCodexExecServer,
  typedInputPolicy,
  type ClaudeHookContext,
  type CodexExecBackend,
  type CodexExecGate,
  type CodexExecGateBinder,
  type CodexExecGateBudget,
  type CodexExecGateCall,
  type CodexExecGateDecision,
  type CodexExecGateRecord,
} from "@orca/agents";

/** A POSIX path as Codex's executor names it. The gate is for Linux, where ORCA guards Codex. */
const uri = (path: string): string => `file://${path}`;
const frameText = (data: RawData): string =>
  (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8");
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** An executor that answers every request with `{ ok: <method> }` and remembers what it was sent. */
class FakeBackend implements CodexExecBackend {
  received: Record<string, unknown>[] = [];
  raw: string[] = [];
  stopped = false;
  private listener: ((message: string) => void) | undefined;
  private exit: ((detail: string) => void) | undefined;
  private gone = false;
  private exited: string | undefined;
  /** Set to keep what is sent "unwritten": the gate goes on holding its bytes. */
  stalled = false;
  /** Set to leave requests unanswered. */
  silent = false;
  /**
   * What `stop` does. `exits`: the executor goes. `lingers`: `stop` returns and the executor
   * is still there, as the real one is after its last wait. `fails`: `stop` rejects, and the
   * executor is still there.
   */
  onStop: "exits" | "lingers" | "fails" = "exits";
  private unflushed: (() => void)[] = [];

  send(message: string, flushed: () => void): void {
    if (this.gone) throw new Error("gone");
    if (this.stalled) this.unflushed.push(flushed);
    else flushed();
    this.raw.push(message);
    const parsed = JSON.parse(message) as Record<string, unknown>;
    this.received.push(parsed);
    if (parsed["id"] === undefined || parsed["method"] === undefined || this.silent) return;
    const result =
      parsed["method"] === "initialize"
        ? { sessionId: "s", environmentInfo: { shell: { name: "fish", path: "/opt/fish" } } }
        : { ok: parsed["method"] };
    queueMicrotask(() => this.emit({ id: parsed["id"], result }));
  }
  emit(message: unknown): void {
    if (this.exited === undefined) this.listener?.(JSON.stringify(message));
  }
  flush(): void {
    for (const flushed of this.unflushed.splice(0)) flushed();
  }
  emitRaw(line: string): void {
    this.listener?.(line);
  }
  onMessage(listener: (message: string) => void): void {
    this.listener = listener;
  }
  onExit(listener: (detail: string) => void): void {
    if (this.exited !== undefined) listener(this.exited);
    else this.exit = listener;
  }
  /** The executor is seen to exit: what it had not written is dropped, and the gate hears of it. */
  die(detail = "exit 1"): void {
    if (this.exited !== undefined) return;
    this.gone = true;
    this.exited = detail;
    this.flush();
    this.exit?.(detail);
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.gone = true;
    if (this.onStop === "fails") return Promise.reject(new Error("the executor would not stop"));
    if (this.onStop === "exits") this.die("exit 0");
    return Promise.resolve();
  }
  methods(): unknown[] {
    return this.received.map((m) => m["method"]);
  }
}

/** A client speaking the executor protocol the way Codex's does: one JSON message per frame. */
class Client {
  private waiting = new Map<number, (message: Record<string, unknown>) => void>();
  private next = 0;
  notifications: Record<string, unknown>[] = [];
  closed: Promise<void>;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(frameText(data)) as Record<string, unknown>;
      const id = message["id"];
      if (typeof id === "number" && message["method"] === undefined) {
        this.waiting.get(id)?.(message);
        this.waiting.delete(id);
      } else this.notifications.push(message);
    });
    this.closed = new Promise((resolve) => ws.once("close", () => resolve()));
  }
  static open(url: string, options?: { headers?: Record<string, string> }): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      ws.once("open", () => resolve(new Client(ws)));
      ws.once("error", reject);
    });
  }
  call(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const id = ++this.next;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Send a frame as written, and wait for the answer to `id`. */
  raw(id: number, frame: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(frame);
    });
  }
  notify(method: string, params: unknown = {}): void {
    this.ws.send(JSON.stringify({ method, params }));
  }
}

const errorOf = (answer: Record<string, unknown>): string =>
  (answer["error"] as { message: string } | undefined)?.message ?? "";

/**
 * A binder over an imagined file system. A path is its own file unless `links` names where it
 * really leads; an empty answer is a path that cannot be resolved or held.
 */
function fakeBinder(links: Record<string, string> = {}) {
  const held: string[] = [];
  const released: string[] = [];
  const real = (path: string): string | undefined => {
    const to = links[path] ?? path;
    return to === "" ? undefined : to;
  };
  const binder: CodexExecGateBinder = {
    target: real,
    entry: real,
    directory(path) {
      const to = real(path);
      if (to === undefined) return undefined;
      held.push(to);
      return { real: to, reach: `/proc/7/fd/${held.length}`, release: () => void released.push(to) };
    },
  };
  return Object.assign(binder, { held, released });
}

let gate: CodexExecGate | undefined;
let clients: Client[] = [];
let backends: FakeBackend[] = [];
let calls: CodexExecGateCall[] = [];
let records: CodexExecGateRecord[] = [];

type Decide = (call: CodexExecGateCall, signal: AbortSignal) => Promise<CodexExecGateDecision>;
const allowAll: Decide = () => Promise.resolve({ allow: true, basis: "test" });
/** A decision that is never made. It gives up, as ORCA's own does, when the gate tells it to stop. */
const hangs =
  (onStop?: () => void): Decide =>
  (_call, signal) =>
    new Promise<CodexExecGateDecision>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          onStop?.();
          reject(new Error("stopped"));
        },
        { once: true },
      );
    });
const soon = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const refuseAll: Decide = () => Promise.resolve({ allow: false, basis: "test", reason: "the test says no" });

interface OpenOptions {
  admit?: boolean;
  admissionWaitMs?: number;
  binder?: CodexExecGateBinder;
  messageLimitBytes?: number;
  connectionBudgetBytes?: number;
  budget?: CodexExecGateBudget;
  maxConnections?: number;
  closeWaitMs?: number;
  backend?: () => FakeBackend;
}

async function open(decide: Decide = allowAll, more: OpenOptions = {}) {
  gate = await openCodexExecGate({
    decide: (call, signal) => {
      calls.push(call);
      return decide(call, signal);
    },
    onRecord: (record) => records.push(record),
    decisionTimeoutMs: 300,
    admissionWaitMs: more.admissionWaitMs ?? 200,
    binder: more.binder ?? fakeBinder(),
    ...(more.messageLimitBytes !== undefined ? { messageLimitBytes: more.messageLimitBytes } : {}),
    ...(more.connectionBudgetBytes !== undefined ? { connectionBudgetBytes: more.connectionBudgetBytes } : {}),
    ...(more.budget !== undefined ? { budget: more.budget } : {}),
    ...(more.maxConnections !== undefined ? { maxConnections: more.maxConnections } : {}),
    ...(more.closeWaitMs !== undefined ? { closeWaitMs: more.closeWaitMs } : {}),
  });
  if (more.admit !== false)
    gate.admit(() => {
      const backend = more.backend?.() ?? new FakeBackend();
      backends.push(backend);
      return backend;
    });
  return gate;
}

async function connected(
  decide: Decide = allowAll,
  more: OpenOptions = {},
): Promise<{ client: Client; backend: FakeBackend }> {
  const g = await open(decide, more);
  const client = await Client.open(g.url);
  clients.push(client);
  const answer = await client.call("initialize", { clientName: "codex-environment", resumeSessionId: null });
  expect(answer["result"]).toBeDefined();
  client.notify("initialized");
  return { client, backend: backends[0]! };
}

const start = (processId: string, argv: string[], more: Record<string, unknown> = {}) => ({
  processId,
  metadata: { threadId: "t", toolCallId: "call_1" },
  argv,
  cwd: uri("/work"),
  env: {},
  tty: false,
  arg0: null,
  ...more,
});

beforeEach(() => {
  clients = [];
  backends = [];
  calls = [];
  records = [];
});

afterEach(async () => {
  for (const client of clients) client.ws.terminate();
  await gate?.close();
  gate = undefined;
  // Every byte a gate claimed on the shared budget is given back once it is closed.
  expect(codexExecGateHeldBytes()).toBe(0);
});

describe("the path a file: URI names", () => {
  it("reads the plain form Codex writes", () => {
    expect(codexExecPath("file:///tmp/work/one.txt")).toBe("/tmp/work/one.txt");
    expect(codexExecPath("file:///tmp/a%20b/caf%C3%A9.txt")).toBe("/tmp/a b/café.txt");
    expect(codexExecPath("file:///")).toBe("/");
  });

  it.each([
    ["no scheme", "/tmp/work/one.txt"],
    ["another scheme", "http://127.0.0.1/tmp"],
    ["a host", "file://server/share/one.txt"],
    ["localhost as host", "file://localhost/tmp/one.txt"],
    ["a query", "file:///tmp/one.txt?x=1"],
    ["a fragment", "file:///tmp/one.txt#x"],
    ["dot segments", "file:///tmp/work/../../etc/passwd"],
    ["encoded dot segments", "file:///tmp/work/%2e%2e/secret"],
    ["an encoded separator", "file:///tmp/work%2Fsecret"],
    ["an encoded backslash", "file:///tmp/work%5Csecret"],
    ["a backslash", "file:///tmp\\work"],
    ["Codex's opaque path form", "file:///%00/bad/path/L2V0Yy9wYXNzd2Q"],
    ["a NUL", "file:///tmp/one%00.txt"],
    ["bytes that are not text", "file:///tmp/%ff%fe"],
    ["a space as written", "file:///tmp/a b"],
    ["a tab", "file:///tmp/a\tb"],
    ["a non-ASCII character as written", "file:///tmp/café"],
    ["an upper-case scheme", "FILE:///tmp/one.txt"],
    ["a bad escape", "file:///tmp/one%zz"],
    ["a drive-letter spelling", "file:///C|/Windows"],
    ["an empty name", "file:///tmp//one.txt"],
    ["a trailing slash", "file:///tmp/work/"],
    ["a path longer than any real one", `file:///${"a/".repeat(2100)}b`],
    ["a number", 7],
    ["nothing", undefined],
  ])("refuses %s", (_what, value) => {
    expect(() => codexExecPath(value)).toThrow();
  });
});

describe("the file: URI the executor is sent", () => {
  it("is the one spelling the gate reads back to the same path", () => {
    for (const path of ["/", "/tmp/work/one.txt", "/tmp/a b/café.txt", "/tmp/100%/x#y?z", "/proc/41/fd/7"])
      expect(codexExecPath(codexExecUri(path))).toBe(path);
    expect(codexExecUri("/tmp/a b")).toBe("file:///tmp/a%20b");
  });

  it("refuses a path it could not name without a doubt", () => {
    expect(() => codexExecUri("/tmp/back\\slash")).toThrow();
    expect(() => codexExecUri("/tmp//twice")).toThrow();
    expect(() => codexExecUri("relative/path")).toThrow();
  });
});

describe("what one request needs", () => {
  const state = (...processes: string[]) => {
    const s = newCodexExecGateConnectionState();
    for (const id of processes) s.processes.set(id, "open");
    return s;
  };
  const reason = (plan: ReturnType<typeof planCodexExecRequest>) => (plan.action === "refuse" ? plan.reason : "");
  const planned = (
    method: string,
    params: unknown,
    s = state(),
    binder: CodexExecGateBinder = fakeBinder(),
  ): ReturnType<typeof planCodexExecRequest> => planCodexExecRequest(method, params, s, binder);

  it("decides a shell command by its script, in the directory ORCA holds, with the model's call id", () => {
    const binder = fakeBinder();
    const plan = planned("process/start", start("p1", ["/bin/bash", "-lc", "echo hi >> one.txt"]), state(), binder);
    expect(plan.action).toBe("decide");
    if (plan.action !== "decide") return;
    expect(plan.calls).toEqual([
      {
        method: "process/start",
        check: "policy",
        toolCall: { title: "echo hi >> one.txt", kind: "execute", locations: [] },
        cwd: "/work",
        toolCallId: "call_1",
      },
    ]);
    expect(plan.subject).toMatchObject({ argv: ["/bin/bash", "-lc", "echo hi >> one.txt"], cwd: "/work" });
    // The executor is told to start in the descriptor, not in the name. What it is sent is
    // the whole list of a start's fields, each one read, with the ones Codex left out at rest.
    expect(plan.params).toEqual({
      processId: "p1",
      metadata: { threadId: "t", toolCallId: "call_1" },
      argv: ["/bin/bash", "-lc", "echo hi >> one.txt"],
      cwd: "file:///proc/7/fd/1",
      envPolicy: null,
      env: {},
      tty: false,
      pipeStdin: false,
      arg0: null,
      sandbox: null,
      enforceManagedNetwork: false,
      managedNetwork: null,
    });
    expect(plan.subject).toMatchObject({ sandbox: "none" });
    expect(binder.held).toEqual(["/work"]);
    expect(binder.released).toEqual([]);
    plan.hold?.release();
    expect(binder.released).toEqual(["/work"]);
  });

  it("decides a start whose directory is reached through a link twice: as held and as written", () => {
    const plan = planned(
      "process/start",
      start("p1", ["/bin/sh", "-c", "ls"]),
      state(),
      fakeBinder({ "/work": "/mnt/real" }),
    );
    expect(plan.action).toBe("decide");
    if (plan.action !== "decide") return;
    expect(plan.calls[0]).toMatchObject({ cwd: "/mnt/real", asWritten: { title: "ls", locations: [], cwd: "/work" } });
    expect(plan.subject).toMatchObject({ cwd: "/mnt/real", written: ["/work"] });
  });

  it("refuses a start whose directory it cannot hold, and holds nothing for a start it cannot read", () => {
    expect(
      reason(planned("process/start", start("p1", ["/bin/sh", "-c", "ls"]), state(), fakeBinder({ "/work": "" }))),
    ).toMatch(/could not hold the directory/);
    const binder = fakeBinder();
    expect(planned("process/start", start("p1", ["/bin/sh", 7 as never]), state(), binder).action).toBe("refuse");
    expect(planned("process/start", start("p1", ["/bin/sh"], { arg0: 7 }), state(), binder).action).toBe("refuse");
    expect(binder.held).toEqual([]);
  });

  it("decides anything that is not a known shell's -c as the whole command line", () => {
    const title = (argv: string[], more?: Record<string, unknown>, s = state()) => {
      const plan = planned("process/start", start("p1", argv, more), s);
      return plan.action === "decide" ? plan.calls[0]!.toolCall.title : reason(plan);
    };
    // A shell at a path the model chose is a program like any other.
    expect(title(["/work/bash", "-lc", "git status"])).toBe("/work/bash -lc 'git status'");
    expect(title(["/usr/bin/python3", "-c", "print(1)"])).toBe("/usr/bin/python3 -c 'print(1)'");
    expect(title(["/bin/bash", "--rcfile", "/work/x", "-c", "ls"])).toBe("/bin/bash --rcfile /work/x -c ls");
    expect(title(["/bin/bash", "-lc", "ls"], { arg0: "codex-linux-sandbox" })).toBe(
      "/bin/bash -lc ls (as codex-linux-sandbox)",
    );
    // The shell the executor itself reported is read like a system shell.
    const reported = state();
    reported.shell = "/opt/fish";
    expect(title(["/opt/fish", "-c", "ls"], undefined, reported)).toBe("ls");
    expect(title(["/opt/fish", "-c", "ls"])).toBe("/opt/fish -c ls");
  });

  it("records a long command cut short, with a digest over all of it", () => {
    const script = `echo ${"x".repeat(100_000)}`;
    const argv = ["/bin/bash", "-lc", script, ...Array.from({ length: 40 }, (_, i) => `arg${i}`)];
    const plan = planned("process/start", start("p1", argv));
    expect(plan.action).toBe("decide");
    if (plan.action !== "decide") return;
    // The decision is over the whole command; only the record is cut.
    expect(plan.calls[0]!.toolCall.title).toContain(script);
    const subject = plan.subject!;
    expect(subject.argv).toHaveLength(16);
    expect(subject.argv![2]!.length).toBeLessThan(1100);
    expect(subject.title!.length).toBeLessThan(2100);
    expect(subject.argvSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(subject).length).toBeLessThan(24_000);
  });

  it.each([
    ["no argv", { argv: [] }],
    ["an argv that is not text", { argv: ["/bin/sh", 7] }],
    ["a cwd that is not a plain file: URI", { cwd: "file:///work/../etc" }],
    ["no process id", { processId: "" }],
    ["a process id longer than any Codex writes", { processId: "p".repeat(200) }],
    ["an arg0 that is not text", { arg0: 7 }],
  ])("refuses a start with %s", (_what, more) => {
    expect(planned("process/start", start("p1", ["/bin/sh", "-c", "ls"], more)).action).toBe("refuse");
  });

  it("refuses a start under a process id already in use", () => {
    expect(reason(planned("process/start", start("p1", ["/bin/sh", "-c", "ls"]), state("p1")))).toMatch(
      /already in use/,
    );
  });

  it("keeps a bounded number of processes, making room only from the ones that closed", () => {
    const s = state(...Array.from({ length: 1024 }, (_, i) => `p${i}`));
    const more = () => planned("process/start", start("new", ["/bin/sh", "-c", "ls"]), s);
    expect(reason(more())).toMatch(/too many processes/);
    s.processes.set("p5", "closed");
    const plan = more();
    expect(plan.action).toBe("decide");
    if (plan.action !== "decide") return;
    plan.effect?.(s);
    expect(s.processes.size).toBe(1024);
    expect(s.processes.has("p5")).toBe(false);
    expect(s.processes.get("new")).toBe("open");
  });

  it("passes reading, interrupting and ending only a process it allowed", () => {
    const s = state("p1");
    for (const [method, more] of [
      ["process/read", {}],
      ["process/signal", { signal: "interrupt" }],
      ["process/terminate", {}],
    ] as const) {
      expect(planned(method, { processId: "p1", ...more }, s).action).toBe("pass");
      expect(reason(planned(method, { processId: "p2", ...more }, s))).toMatch(/did not allow/);
    }
  });

  it("sends each of them on as the fields it read, and refuses one with any other", () => {
    const s = state("p1");
    const sent = (method: string, params: Record<string, unknown>) => {
      const plan = planned(method, params, s);
      if (plan.action === "refuse") throw new Error(plan.reason);
      return plan.params;
    };
    expect(sent("process/read", { processId: "p1", afterSeq: 4, maxBytes: 1024 })).toEqual({
      processId: "p1",
      afterSeq: 4,
      maxBytes: 1024,
      waitMs: null,
    });
    expect(sent("process/signal", { processId: "p1", signal: "interrupt" })).toEqual({
      processId: "p1",
      signal: "interrupt",
    });
    expect(sent("process/terminate", { processId: "p1" })).toEqual({ processId: "p1" });
    // Codex sends these two with no parameters, and so does the gate.
    expect(sent("environment/info", {})).toBeUndefined();
    expect(sent("environment/status", {})).toBeUndefined();

    expect(reason(planned("process/read", { processId: "p1", waitMs: -1 }, s))).toMatch(/not a count/);
    expect(reason(planned("process/read", { processId: "p1", maxBytes: 1.5 }, s))).toMatch(/not a count/);
    expect(reason(planned("process/read", { processId: "p1", follow: true }, s))).toMatch(/does not pass \(follow\)/);
    expect(reason(planned("process/signal", { processId: "p1", signal: "kill" }, s))).toMatch(/signal/);
    expect(reason(planned("process/signal", { processId: "p1" }, s))).toMatch(/signal/);
    expect(reason(planned("process/terminate", { processId: "p1", force: true }, s))).toMatch(/does not pass/);
    expect(reason(planned("process/write", { processId: "p1", chunk: "", writeId: "1", tty: true }, s))).toMatch(
      /does not pass \(tty\)/,
    );
    expect(reason(planned("process/write", { processId: "p1", chunk: "" }, s))).toMatch(/writeId is missing/);
    expect(reason(planned("environment/info", { verbose: true }, s))).toMatch(/does not pass/);
  });

  describe("a start", () => {
    const sh = ["/bin/sh", "-c", "ls"];
    const sent = (more: Record<string, unknown>, binder = fakeBinder()) => {
      const plan = planned("process/start", start("p1", sh, more), state(), binder);
      if (plan.action !== "decide") throw new Error(reason(plan) || plan.action);
      return plan;
    };
    const refused = (more: Record<string, unknown>, binder = fakeBinder()) =>
      reason(planned("process/start", start("p1", sh, more), state(), binder));
    /** What Codex 0.171 writes for a command, name by name. */
    const codexEnv = {
      NO_COLOR: "1",
      TERM: "dumb",
      LANG: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      COLORTERM: "",
      PAGER: "cat",
      GIT_PAGER: "cat",
      GH_PAGER: "cat",
      CODEX_CI: "1",
      CODEX_SESSION_ID: "01a20c23-7fa2-77d3-b887-d084f0365f67",
      CODEX_THREAD_ID: "01a20c23-7fa2-77d3-b887-d084f0365f67",
      CODEX_TOOL_CALL_ID: "call_1",
      CODEX_VERSION: "0.171.0",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: "1",
    };
    const policy = {
      inherit: "all",
      ignoreDefaultExcludes: true,
      exclude: ["CODEX_VERSION"],
      set: {},
      includeOnly: [],
    };

    it("is refused with a field the gate does not read, and nothing is held for it", () => {
      const binder = fakeBinder();
      expect(refused({ surprise: 1 }, binder)).toMatch(/does not pass \(surprise\)/);
      expect(refused({ tty: "yes" }, binder)).toMatch(/tty/);
      expect(refused({ pipeStdin: 1 }, binder)).toMatch(/pipeStdin/);
      expect(refused({ enforceManagedNetwork: "no" }, binder)).toMatch(/enforceManagedNetwork/);
      expect(binder.held).toEqual([]);
    });

    it("is refused when it asks the executor to run or reach something no rule reads", () => {
      const binder = fakeBinder();
      expect(refused({ shellSnapshot: { scopeId: "s", shell: { name: "sh", path: "/tmp/evil" } } }, binder)).toMatch(
        /does not pass \(shellSnapshot\)/,
      );
      expect(refused({ networkProxy: { proxy: {} } }, binder)).toMatch(/does not pass \(networkProxy\)/);
      expect(refused({ managedNetwork: { transparentTcp: true } }, binder)).toMatch(/does not pass \(managedNetwork\)/);
      expect(binder.held).toEqual([]);
      // Named and empty is the same as not named.
      expect(sent({ shellSnapshot: null, networkProxy: null, managedNetwork: null }).params).not.toHaveProperty(
        "shellSnapshot",
      );
    });

    it("passes the environment Codex writes, name by name, and the flags as read", () => {
      const plan = sent({ env: codexEnv, envPolicy: policy, tty: true, pipeStdin: true, enforceManagedNetwork: true });
      expect(plan.params).toMatchObject({
        env: codexEnv,
        envPolicy: policy,
        tty: true,
        pipeStdin: true,
        enforceManagedNetwork: true,
        managedNetwork: null,
      });
    });

    it.each([
      ["a name that is not Codex's", { BASH_ENV: "/tmp/x.sh" }],
      ["a loader's variable", { LD_PRELOAD: "/tmp/x.so" }],
      ["a path", { PATH: "/tmp/bin" }],
      ["a pager that is a command", { PAGER: "sh -c 'id > /tmp/x'" }],
      ["a pager for git that is a command", { GIT_PAGER: "less" }],
      ["a value with a line break", { CODEX_TOOL_CALL_ID: "call_1\nBASH_ENV=/tmp/x" }],
      ["a value that is not text", { NO_COLOR: 1 }],
      ["a name every object has", { ["__proto__"]: "1" }],
      ["a name in another case", { pager: "cat" }],
    ])("is refused when its environment has %s", (_what, env) => {
      const binder = fakeBinder();
      const bad = Object.assign(Object.create(null) as Record<string, unknown>, env);
      expect(refused({ env: { ...codexEnv, ...bad } }, binder)).toMatch(/sets a variable ORCA does not pass/);
      // What an environment policy sets is the same environment by another door.
      expect(refused({ envPolicy: { ...policy, set: bad } }, binder)).toMatch(/sets a variable ORCA does not pass/);
      expect(binder.held).toEqual([]);
    });

    it("is refused with an environment or a policy for it that the gate cannot read", () => {
      expect(refused({ env: null })).toMatch(/environment is missing/);
      expect(refused({ env: ["PAGER=cat"] })).toMatch(/environment is missing/);
      for (const envPolicy of [
        "all",
        { ...policy, inherit: "everything" },
        { ...policy, ignoreDefaultExcludes: "yes" },
        { ...policy, exclude: "PATH" },
        { ...policy, exclude: [7] },
        { ...policy, includeOnly: ["a b"] },
        { ...policy, set: null },
        { ...policy, useProfile: true },
      ])
        expect(refused({ envPolicy })).toMatch(/environment policy/);
    });

    it("reads Codex's ids for the call strictly, since the executor hands them to the process", () => {
      expect(sent({ metadata: null }).params).not.toHaveProperty("metadata");
      expect(sent({ metadata: { toolCallId: "call_9" } }).params).toMatchObject({ metadata: { toolCallId: "call_9" } });
      for (const metadata of [
        "call_1",
        { toolCallId: "call 1" },
        { toolCallId: "x".repeat(257) },
        { threadId: "t\nu" },
        { threadId: 7 },
        { toolCallId: "call_1", turnId: "u" },
      ])
        expect(refused({ metadata })).toMatch(/call's ids/);
    });

    describe("with a sandbox", () => {
      const permissions = {
        type: "managed",
        file_system: {
          type: "restricted",
          entries: [{ path: { type: "special", value: { kind: "root" } }, access: "read" }],
        },
        network: "restricted",
      };
      const sandbox = {
        permissions,
        cwd: uri("/work"),
        workspaceRoots: [uri("/work")],
        windowsSandboxLevel: "disabled",
        windowsSandboxProxySettingsMode: "reconcile",
        useLegacyLandlock: false,
      };

      it("is sent on in a fixed shape, and recorded by its kind", () => {
        const plan = sent({ sandbox });
        expect(plan.params!["sandbox"]).toEqual(sandbox);
        expect(plan.subject).toMatchObject({ sandbox: "managed" });
        expect(
          sent({ sandbox: { permissions: { type: "disabled" }, windowsSandboxLevel: "disabled" } }).subject,
        ).toMatchObject({ sandbox: "disabled" });
      });

      it("has its directories resolved the way the start's own is, so all three agree", () => {
        const binder = fakeBinder({ "/link": "/real", "/roots/b": "/elsewhere/b", "/home/u": "/users/u" });
        const plan = sent(
          {
            cwd: uri("/link"),
            sandbox: {
              ...sandbox,
              cwd: uri("/link"),
              workspaceRoots: [uri("/link"), uri("/roots/b")],
              policyContext: { cwd: uri("/link"), workspaceRoots: [uri("/roots/b")] },
              userHomeDir: uri("/home/u"),
              temporaryDirectories: [uri("/tmp")],
              sandboxOverride: "noOverride",
            },
          },
          binder,
        );
        // Decided in the real directory (and as written), started in the descriptor that holds it.
        expect(plan.calls[0]).toMatchObject({ cwd: "/real", asWritten: { cwd: "/link" } });
        expect(plan.params).toMatchObject({
          cwd: "file:///proc/7/fd/1",
          sandbox: {
            permissions,
            cwd: uri("/real"),
            workspaceRoots: [uri("/real"), uri("/elsewhere/b")],
            policyContext: { cwd: uri("/real"), workspaceRoots: [uri("/elsewhere/b")] },
            userHomeDir: uri("/users/u"),
            temporaryDirectories: [uri("/tmp")],
            sandboxOverride: "noOverride",
          },
        });
      });

      it.each([
        ["a field the gate does not read", { ...sandbox, extraWritableRoots: [uri("/etc")] }],
        ["a profile the executor does not know", { ...sandbox, permissions: { type: "wide-open" } }],
        ["a profile with a field of another one", { ...sandbox, permissions: { type: "disabled", file_system: {} } }],
        ["no profile", { ...sandbox, permissions: undefined }],
        ["a sandbox for another system", { ...sandbox, windowsSandboxLevel: "elevated" }],
        ["no word on which system it is for", { ...sandbox, windowsSandboxLevel: undefined }],
        ["an override the executor does not know", { ...sandbox, sandboxOverride: "off" }],
        ["a proxy mode the executor does not know", { ...sandbox, windowsSandboxProxySettingsMode: "rewrite" }],
        ["a directory that is not a plain path", { ...sandbox, cwd: "file:///work/../etc" }],
        ["roots that are not a list", { ...sandbox, workspaceRoots: uri("/work") }],
        [
          "a context with a field the gate does not read",
          { ...sandbox, policyContext: { cwd: uri("/work"), home: 1 } },
        ],
        ["something that is not a sandbox", "none"],
      ])("is refused with %s, and the directory is let go", (_what, bad) => {
        const binder = fakeBinder();
        expect(refused({ sandbox: bad }, binder)).toMatch(/sandbox|does not pass|plain file: URI/);
        expect(binder.released).toEqual(binder.held);
      });

      it("is refused when a directory it names cannot be resolved", () => {
        const binder = fakeBinder({ "/roots/gone": "" });
        expect(refused({ sandbox: { ...sandbox, workspaceRoots: [uri("/roots/gone")] } }, binder)).toMatch(
          /which directory the sandbox names/,
        );
        expect(binder.released).toEqual(["/work"]);
      });
    });
  });

  it("decides typed input as its own call and keeps the text out of the record", () => {
    const plan = planned("process/write", { processId: "p1", chunk: b64("yes\n"), writeId: "1" }, state("p1"));
    expect(plan.action).toBe("decide");
    if (plan.action !== "decide") return;
    expect(plan.calls[0]).toMatchObject({
      typedInput: true,
      toolCall: { title: 'write_stdin: "yes\\n"', kind: "execute", locations: [] },
    });
    expect(plan.subject).toMatchObject({ processId: "p1", bytes: 4 });
    expect(JSON.stringify(plan.subject)).not.toContain("yes");
    // Typed input is sent on as the three fields a write has.
    expect(plan.params).toEqual({ processId: "p1", chunk: b64("yes\n"), writeId: "1" });
  });

  it("passes an empty write and a lone interrupt, and nothing else typed", () => {
    const s = state("p1");
    const write = (chunk: unknown, processId = "p1") => planned("process/write", { processId, chunk, writeId: "1" }, s);
    expect(write("").action).toBe("pass");
    expect(write(b64("\u0003")).action).toBe("pass");
    expect(write(b64("\u0003\u0003")).action).toBe("decide");
    expect(write(b64("\u0004")).action).toBe("decide");
    expect(reason(write(b64("x"), "p2"))).toMatch(/did not allow/);
    expect(reason(write("not base64!"))).toMatch(/not base64/);
    expect(reason(write(Buffer.from([0xff, 0xfe]).toString("base64")))).toMatch(/not text/);
    expect(reason(write(7))).toMatch(/missing/);
  });

  describe("a file request", () => {
    const path = uri("/work/a.txt");
    const decided = (method: string, params: Record<string, unknown>, binder = fakeBinder()) => {
      const plan = planned(method, params, state(), binder);
      if (plan.action !== "decide") throw new Error(reason(plan) || plan.action);
      return plan;
    };

    it("is decided as a read, an edit or a delete of that one path", () => {
      const kinds = (method: string, params: Record<string, unknown>) =>
        decided(method, params).calls.map((c) => [c.check, c.toolCall.kind, c.toolCall.locations[0]!.path]);
      expect(kinds("fs/readFile", { path })).toEqual([["policy", "read", "/work/a.txt"]]);
      expect(kinds("fs/writeFile", { path, dataBase64: "" })).toEqual([["policy", "edit", "/work/a.txt"]]);
      expect(kinds("fs/createDirectory", { path })).toEqual([["policy", "edit", "/work/a.txt"]]);
      expect(kinds("fs/remove", { path })).toEqual([["policy", "delete", "/work/a.txt"]]);
      // A probe opens nothing: only ORCA's own files are refused.
      expect(kinds("fs/getMetadata", { path })).toEqual([["protected", "read", "/work/a.txt"]]);
    });

    it("is passed on with the path ORCA decided and the executor told to follow no link", () => {
      const sandbox = {
        permissions: { type: "managed", file_system: { type: "unrestricted" }, network: "enabled" },
        cwd: uri("/work"),
        windowsSandboxLevel: "disabled",
        useLegacyLandlock: false,
      };
      const read = decided("fs/readFile", { path, sandbox });
      expect(read.params).toEqual({ path, followSymlinks: false, sandbox });
      expect(read.subject).toMatchObject({ sandbox: "managed" });
      expect(decided("fs/writeFile", { path, dataBase64: b64("x") }).params).toEqual({
        path,
        dataBase64: b64("x"),
        followSymlinks: false,
        sandbox: null,
      });
      expect(decided("fs/getMetadata", { path, followSymlinks: true }).params).toEqual({
        path,
        followSymlinks: false,
        sandbox: null,
      });
      expect(decided("fs/remove", { path, force: true }).params).toEqual({
        path,
        recursive: false,
        force: true,
        followSymlinks: false,
        sandbox: null,
      });
    });

    it("is refused with a field the gate does not read", () => {
      expect(reason(planned("fs/writeFile", { path, dataBase64: b64("x"), append: true }))).toMatch(
        /does not pass \(append\)/,
      );
      expect(reason(planned("fs/readFile", { path, dataBase64: "" }))).toMatch(/does not pass \(dataBase64\)/);
      expect(reason(planned("fs/getMetadata", { path, recursive: true }))).toMatch(/does not pass \(recursive\)/);
      expect(reason(planned("fs/readFile", { path, sandbox: { permissions: { type: "restricted" } } }))).toMatch(
        /sandbox/,
      );
    });

    it("has its sandbox's directories resolved the way its own path is", () => {
      const binder = fakeBinder({ "/work": "/real/work", "/work/a.txt": "/real/work/a.txt" });
      const plan = decided(
        "fs/writeFile",
        {
          path,
          dataBase64: "",
          sandbox: {
            permissions: { type: "disabled" },
            cwd: uri("/work"),
            policyContext: { cwd: uri("/work"), workspaceRoots: [uri("/work")] },
            workspaceRoots: [uri("/work")],
            windowsSandboxLevel: "disabled",
          },
        },
        binder,
      );
      expect(plan.params).toMatchObject({
        path: uri("/real/work/a.txt"),
        sandbox: {
          cwd: uri("/real/work"),
          policyContext: { cwd: uri("/real/work"), workspaceRoots: [uri("/real/work")] },
          workspaceRoots: [uri("/real/work")],
        },
      });
    });

    it("names the file a link leads to, and is decided as that file and as written", () => {
      const binder = fakeBinder({ "/work/a.txt": "/etc/passwd" });
      const plan = decided("fs/writeFile", { path, dataBase64: b64("x") }, binder);
      expect(plan.calls).toEqual([
        {
          method: "fs/writeFile",
          check: "policy",
          toolCall: { title: "Edit /etc/passwd", kind: "edit", locations: [{ path: "/etc/passwd" }] },
          asWritten: { title: "Edit /work/a.txt", locations: [{ path: "/work/a.txt" }] },
        },
      ]);
      expect(plan.params).toMatchObject({ path: uri("/etc/passwd"), followSymlinks: false });
      expect(plan.subject).toMatchObject({ paths: ["/etc/passwd"], written: ["/work/a.txt"] });
    });

    it("holds a request that already follows no link to its own words", () => {
      const binder = fakeBinder({ "/work/a.txt": "/etc/passwd" });
      const plan = decided("fs/readFile", { path, followSymlinks: false }, binder);
      expect(plan.calls[0]!.toolCall.locations).toEqual([{ path: "/work/a.txt" }]);
      expect(plan.calls[0]!.asWritten).toBeUndefined();
      expect(plan.params).toMatchObject({ path, followSymlinks: false });
    });

    it("records a write by its size and digest, never its contents", () => {
      const plan = decided("fs/writeFile", { path, dataBase64: b64("secret words") });
      expect(plan.subject).toMatchObject({
        kind: "edit",
        paths: ["/work/a.txt"],
        bytes: 12,
        sha256: createHash("sha256").update("secret words").digest("hex"),
      });
      expect(JSON.stringify(plan.subject)).not.toContain("secret");
      expect(JSON.stringify(plan.subject)).not.toContain(b64("secret words"));
    });

    it("creates one directory, whatever was asked", () => {
      expect(decided("fs/createDirectory", { path, recursive: true }).params).toEqual({
        path,
        recursive: false,
        followSymlinks: false,
        sandbox: null,
      });
    });

    it("is refused when it would remove a whole tree", () => {
      expect(reason(planned("fs/remove", { path, recursive: true }))).toMatch(/whole directory tree/);
    });

    it("is refused when ORCA cannot tell which file it names", () => {
      const lost = fakeBinder({ "/work/a.txt": "" });
      for (const method of ["fs/readFile", "fs/createDirectory", "fs/remove", "fs/getMetadata"])
        expect(reason(planned(method, { path }, state(), lost))).toMatch(/could not tell which file/);
      expect(reason(planned("fs/writeFile", { path, dataBase64: "" }, state(), lost))).toMatch(
        /could not tell which file/,
      );
    });

    it.each([
      ["a path that is not a plain file: URI", "fs/readFile", { path: "file:///work/%2e%2e/x" }],
      ["no path", "fs/readFile", {}],
      ["contents that are not base64", "fs/writeFile", { path, dataBase64: "not base64!" }],
      ["no contents", "fs/writeFile", { path }],
      ["a followSymlinks that is not a yes or a no", "fs/readFile", { path, followSymlinks: "no" }],
      ["a recursive that is not a yes or a no", "fs/remove", { path, recursive: 1 }],
      ["a force that is not a yes or a no", "fs/remove", { path, force: "yes" }],
      ["a sandbox that is not one", "fs/readFile", { path, sandbox: "none" }],
    ])("is refused with %s", (_what, method, params) => {
      expect(reason(planned(method, params))).toMatch(/could not read/);
    });

    it.each([
      ["fs/open", { handleId: "h", path, mode: "replace" }],
      ["fs/readBlock", { handleId: "h", offset: 0, len: 1 }],
      ["fs/writeBlock", { handleId: "h", offset: 0, chunk: "" }],
      ["fs/close", { handleId: "h" }],
      ["fs/copy", { sourcePath: path, destinationPath: uri("/work/b.txt"), recursive: false }],
      ["fs/readDirectory", { path }],
      ["fs/walk", { path, options: {} }],
      ["fs/canonicalize", { path }],
      ["fs/watchMissing", { watchId: 1, missing: [path], present: null }],
    ])("is refused as %s, which the executor cannot be held to one file for", (method, params) => {
      expect(reason(planned(method, params))).toMatch(/cannot be held to the files ORCA decided/);
    });
  });

  it.each([
    "http/request",
    "environmentConfig/read",
    "capabilityRoots/discoverV1",
    "capabilities/discoverV2",
    "network/policyRequest",
    "process/startDetached",
    "fs/chmod",
    "",
  ])("refuses the method %j", (method) => {
    expect(planned(method, {}).action).toBe("refuse");
  });
});

describe("who may connect", () => {
  const upgrade = (url: string, headers: Record<string, string> = {}): Promise<number> =>
    new Promise((resolve, reject) => {
      const target = new URL(url.replace("ws://", "http://"));
      const req = httpRequest({
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "h6A7t6LIWBFhpizIKH+CDA==",
          ...headers,
        },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

  it("turns away a connection without the session's token, from a page, or under another host name", async () => {
    const g = await open();
    const port = new URL(g.url).port;
    expect(await upgrade(`ws://127.0.0.1:${port}/`)).toBe(404);
    expect(await upgrade(`ws://127.0.0.1:${port}/not-the-token`)).toBe(404);
    expect(await upgrade(`${g.url}/more`)).toBe(404);
    expect(await upgrade(g.url, { Origin: "http://127.0.0.1" })).toBe(403);
    expect(await upgrade(g.url, { Host: `localhost:${port}` })).toBe(403);
    expect(await upgrade(g.url)).toBe(101);
    expect(records.filter((r) => r.method === "connection" && r.outcome === "refused")).toHaveLength(5);
    expect(backends).toHaveLength(0);
  });

  it("holds nothing for a handshake that carries the token and then fails", async () => {
    const budget = codexExecGateBudget(1024 * 1024);
    const g = await open(allowAll, { budget, messageLimitBytes: 64 * 1024 });
    // No key: the websocket handshake is refused after the gate let the request in.
    expect(await upgrade(g.url, { "Sec-WebSocket-Key": "" })).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(budget.held).toBe(0);
    expect(backends).toHaveLength(0);
  });

  it("answers a plain HTTP request with nothing", async () => {
    const g = await open();
    const status = await new Promise<number>((resolve, reject) => {
      httpRequest(g.url.replace("ws://", "http://"), (res) => resolve(res.statusCode ?? 0))
        .on("error", reject)
        .end();
    });
    expect(status).toBe(404);
  });

  it("holds no more connections than it was told to", async () => {
    gate = await openCodexExecGate({ decide: allowAll, maxConnections: 1 });
    const first = await Client.open(gate.url);
    clients.push(first);
    await expect(Client.open(gate.url)).rejects.toThrow(/503/);
  });
});

describe("admission", () => {
  it("refuses initialize until ORCA admits the runtime, and starts no executor", async () => {
    const g = await open(allowAll, { admit: false, admissionWaitMs: 100 });
    const client = await Client.open(g.url);
    clients.push(client);
    const answer = await client.call("initialize", { clientName: "codex-environment" });
    expect(errorOf(answer)).toMatch(/Blocked by ORCA: ORCA has not admitted this session's runtime/);
    expect(backends).toHaveLength(0);
    // Nothing else is answered either.
    expect(errorOf(await client.call("process/start", start("p", ["/bin/sh", "-c", "ls"])))).toMatch(
      /not been initialized/,
    );
    await expect(g.initialized(50)).rejects.toThrow(/did not connect/);
  });

  it("holds an early initialize and lets it through once admitted", async () => {
    const g = await open(allowAll, { admit: false, admissionWaitMs: 2000 });
    const client = await Client.open(g.url);
    clients.push(client);
    const pending = client.call("initialize", { clientName: "codex-environment" });
    const seen = g.initialized(2000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backends).toHaveLength(0);
    g.admit(() => {
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    });
    expect((await pending)["result"]).toBeDefined();
    await seen;
    expect(backends).toHaveLength(1);
    expect(() => g.admit(() => new FakeBackend())).toThrow(/already admitted/);
  });

  it("refuses anything before initialize, and a second initialize", async () => {
    const g = await open();
    const client = await Client.open(g.url);
    clients.push(client);
    expect(errorOf(await client.call("fs/readFile", { path: uri("/work/a") }))).toMatch(/not been initialized/);
    expect(backends).toHaveLength(0);
    // Who is connecting is the one thing an `initialize` must say, and it is all that is sent on.
    expect(errorOf(await client.call("initialize"))).toMatch(/clientName is missing/);
    expect(errorOf(await client.call("initialize", { clientName: "codex", mode: "local" }))).toMatch(
      /does not pass \(mode\)/,
    );
    expect(errorOf(await client.call("initialize", { clientName: "codex", resumeSessionId: "a b" }))).toMatch(
      /session to resume/,
    );
    expect(backends).toHaveLength(0);
    expect((await client.call("initialize", { clientName: "codex", resumeSessionId: "s-1" }))["result"]).toBeDefined();
    expect(backends[0]!.received[0]).toEqual({
      id: expect.any(Number),
      method: "initialize",
      params: { clientName: "codex", resumeSessionId: "s-1" },
    });
    expect(errorOf(await client.call("initialize", { clientName: "codex" }))).toMatch(/already initialized/);
    expect(backends[0]!.methods()).toEqual(["initialize"]);
  });
});

describe("requests through the gate", () => {
  it("forwards what it allows and records the call it decided", async () => {
    const { client, backend } = await connected();
    const answer = await client.call("process/start", start("p1", ["/bin/bash", "-lc", "echo hi"]));
    expect(answer["result"]).toEqual({ ok: "process/start" });
    expect(backend.methods()).toEqual(["initialize", "initialized", "process/start"]);
    expect(calls).toHaveLength(1);
    const record = records.find((r) => r.method === "process/start")!;
    expect(record).toMatchObject({
      outcome: "forwarded",
      basis: "test",
      subject: { title: "echo hi", kind: "execute", cwd: "/work", toolCallId: "call_1", processId: "p1" },
    });
    // The process it allowed can now be read, interrupted and ended.
    expect((await client.call("process/read", { processId: "p1" }))["result"]).toBeDefined();
    expect((await client.call("process/terminate", { processId: "p1" }))["result"]).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("answers a refused request itself, and the executor never sees it", async () => {
    const { client, backend } = await connected(refuseAll);
    for (const [method, params] of [
      ["process/start", start("p1", ["/bin/bash", "-lc", "echo hi"])],
      ["fs/writeFile", { path: uri("/work/a.txt"), dataBase64: b64("x") }],
      ["fs/readFile", { path: uri("/work/a.txt") }],
      ["fs/remove", { path: uri("/work/a.txt") }],
      ["fs/createDirectory", { path: uri("/work/new") }],
      ["fs/getMetadata", { path: uri("/work/a.txt") }],
    ] as const) {
      const answer = await client.call(method, params);
      expect(answer["error"]).toEqual({ code: -32000, message: "Blocked by ORCA: the test says no." });
    }
    expect(backend.methods()).toEqual(["initialize", "initialized"]);
    // A refused start allowed nothing: its process cannot be typed into, read or ended.
    expect(errorOf(await client.call("process/write", { processId: "p1", chunk: b64("x") }))).toMatch(/did not allow/);
    expect(errorOf(await client.call("process/read", { processId: "p1" }))).toMatch(/did not allow/);
    expect(backend.methods()).toEqual(["initialize", "initialized"]);
    expect(records.filter((r) => r.outcome === "refused")).toHaveLength(8);
  });

  it("refuses typed input by default while passing an interrupt", async () => {
    const decide: Decide = (call) =>
      Promise.resolve(
        call.typedInput
          ? { allow: false, basis: "policy:ask", reason: "no rule names typed input" }
          : allowAll(call, new AbortController().signal),
      );
    const { client, backend } = await connected(decide);
    await client.call("process/start", start("p1", ["/bin/bash", "-lc", "cat > typed.txt"], { tty: true }));
    expect(errorOf(await client.call("process/write", { processId: "p1", chunk: b64("typed\n"), writeId: "1" }))).toBe(
      "Blocked by ORCA: no rule names typed input.",
    );
    expect(
      (await client.call("process/write", { processId: "p1", chunk: b64("\u0003"), writeId: "2" }))["result"],
    ).toBeDefined();
    expect(backend.received.filter((m) => m["method"] === "process/write")).toHaveLength(1);
    const refused = records.find((r) => r.method === "process/write" && r.outcome === "refused")!;
    expect(refused.subject).toMatchObject({ processId: "p1", bytes: 6 });
    expect(JSON.stringify(records)).not.toContain("typed\\n");
  });

  it("passes on the request as it read it, so a duplicate key cannot be read two ways", async () => {
    const seen: string[] = [];
    const { client, backend } = await connected((call) => {
      seen.push(call.toolCall.title);
      return Promise.resolve({ allow: true, basis: "test" });
    });
    // A parser that takes the first `argv` would run something the gate never decided.
    const frame =
      `{"id":50,"method":"process/start","params":{"processId":"p9","argv":["/bin/bash","-lc","rm -rf /"],` +
      `"cwd":"file:///work","env":{},"tty":false,"arg0":null,"argv":["/bin/bash","-lc","echo safe"]}}`;
    await client.raw(50, frame);
    expect(seen).toEqual(["echo safe"]);
    const sent = backend.raw.find((m) => m.includes("process/start"))!;
    expect(sent).not.toContain("rm -rf");
    expect(JSON.parse(sent)).toMatchObject({
      id: 50,
      params: { argv: ["/bin/bash", "-lc", "echo safe"], cwd: "file:///proc/7/fd/1" },
    });
  });

  it("passes on only the fields the protocol has", async () => {
    const { client, backend } = await connected();
    const parent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await client.raw(
      60,
      `{"id":60,"method":"environment/status","params":{},"trace":{"traceparent":"${parent}","vendor":{"x":1}},"result":1,"error":2,"extra":3}`,
    );
    await client.raw(61, `{"id":61,"method":"environment/status","trace":"not an object"}`);
    // A trace context is passed when it is one, and left out when it is not.
    await client.raw(62, `{"id":62,"method":"environment/status","trace":{"traceparent":"00-ab-cd-01\\nx"}}`);
    expect(backend.raw.slice(-3)).toEqual([
      `{"id":60,"method":"environment/status","trace":{"traceparent":"${parent}"}}`,
      `{"id":61,"method":"environment/status"}`,
      `{"id":62,"method":"environment/status"}`,
    ]);
    // A request without a usable id is no request: nothing answers it and nothing runs it.
    client.ws.send(
      `{"id":null,"method":"process/start","params":${JSON.stringify(start("p1", ["/bin/sh", "-c", "ls"]))}}`,
    );
    await client.call("environment/status");
    expect(backend.methods()).not.toContain("process/start");
  });

  it("sends the executor the path it decided, told to follow no link, and nothing it was not asked", async () => {
    const binder = fakeBinder({ "/work/link.txt": "/work/real.txt" });
    const { client, backend } = await connected(allowAll, { binder });
    await client.call("fs/writeFile", { path: uri("/work/link.txt"), dataBase64: b64("x"), followSymlinks: true });
    await client.call("fs/remove", { path: uri("/work/old.txt"), recursive: false, force: true });
    await client.call("fs/createDirectory", { path: uri("/work/a/b"), recursive: true });
    expect(backend.received.slice(-3).map((m) => m["params"])).toEqual([
      { path: uri("/work/real.txt"), dataBase64: b64("x"), followSymlinks: false, sandbox: null },
      { path: uri("/work/old.txt"), recursive: false, force: true, followSymlinks: false, sandbox: null },
      { path: uri("/work/a/b"), recursive: false, followSymlinks: false, sandbox: null },
    ]);
    // The call was decided as the file it leads to and as the name it was asked under.
    expect(calls[0]).toMatchObject({
      toolCall: { locations: [{ path: "/work/real.txt" }] },
      asWritten: { locations: [{ path: "/work/link.txt" }] },
    });
    expect(records.find((r) => r.method === "fs/writeFile")!.subject).toMatchObject({
      paths: ["/work/real.txt"],
      written: ["/work/link.txt"],
      bytes: 1,
    });
  });

  it("refuses the file requests the executor cannot be held to one file for", async () => {
    const { client, backend } = await connected();
    for (const [method, params] of [
      ["fs/open", { handleId: "h", path: uri("/work/a.txt"), mode: "replace" }],
      ["fs/writeBlock", { handleId: "h", offset: 0, chunk: b64("x") }],
      ["fs/readBlock", { handleId: "h", offset: 0, len: 4 }],
      ["fs/close", { handleId: "h" }],
      ["fs/copy", { sourcePath: uri("/home/u/.ssh/id_ed25519"), destinationPath: uri("/work/key"), recursive: false }],
      ["fs/readDirectory", { path: uri("/work") }],
      ["fs/walk", { path: uri("/work"), options: {} }],
      ["fs/canonicalize", { path: uri("/work/a.txt") }],
      ["fs/watchMissing", { watchId: 1, missing: [uri("/work/.git")], present: null }],
      ["fs/remove", { path: uri("/work/tree"), recursive: true }],
    ] as const)
      expect(errorOf(await client.call(method, params))).toMatch(/^Blocked by ORCA: ORCA does not pass/);
    expect(backend.methods()).toEqual(["initialize", "initialized"]);
    expect(calls).toHaveLength(0);
  });

  it("holds the starting directory until the executor has answered the start, and no longer", async () => {
    const binder = fakeBinder();
    const { client, backend } = await connected(allowAll, { binder });
    backend.silent = true;
    const started = client.call("process/start", start("p1", ["/bin/sh", "-c", "ls"]));
    await client.raw(70, `{"id":70,"method":"bogus"}`);
    expect(binder.held).toEqual(["/work"]);
    expect(binder.released).toEqual([]);
    backend.emit({ id: backend.received.at(-1)!["id"], result: { processId: "p1" } });
    await started;
    expect(binder.released).toEqual(["/work"]);
  });

  it.each([
    ["returns with the executor still there", "lingers"],
    ["fails", "fails"],
  ] as const)(
    "lets go of a directory for a refused start at once, and of one passed on only when the executor is seen to exit: stopping it %s",
    async (_what, onStop) => {
      const binder = fakeBinder();
      let allow = false;
      const { client, backend } = await connected(
        () => Promise.resolve(allow ? { allow: true, basis: "test" } : { allow: false, basis: "test", reason: "no" }),
        { binder },
      );
      await client.call("process/start", start("p1", ["/bin/sh", "-c", "ls"]));
      expect(binder.released).toEqual(["/work"]);
      allow = true;
      backend.silent = true;
      void client.call("process/start", start("p2", ["/bin/sh", "-c", "ls"], { cwd: uri("/work/sub") }));
      await client.raw(71, `{"id":71,"method":"bogus"}`);
      expect(binder.released).toEqual(["/work"]);
      // The executor was asked to stop and is still there: a start in flight may still be on
      // its way into the directory, so it stays held and the connection stays counted.
      backend.onStop = onStop;
      client.ws.terminate();
      await client.closed;
      await soon();
      expect(backend.stopped).toBe(true);
      expect(binder.released).toEqual(["/work"]);
      expect(gate!.connections()).toEqual({ open: 0, stopping: 1 });
      // Seen to exit, it can use nothing more.
      backend.die("signal SIGKILL");
      expect(binder.released).toEqual(["/work", "/work/sub"]);
      await soon();
      expect(gate!.connections()).toEqual({ open: 0, stopping: 0 });
    },
  );

  it("refuses another start while too many are still unanswered, each with a directory held", async () => {
    const binder = fakeBinder();
    const { client, backend } = await connected(allowAll, { binder });
    backend.silent = true;
    for (let i = 0; i < 32; i++) void client.call("process/start", start(`p${i}`, ["/bin/sh", "-c", "ls"]));
    expect(errorOf(await client.call("process/start", start("p32", ["/bin/sh", "-c", "ls"])))).toMatch(
      /too many commands are still starting/,
    );
    expect(binder.held).toHaveLength(32);
    // One answered start makes room for one more.
    backend.emit({ id: backend.received.find((m) => m["method"] === "process/start")!["id"], result: {} });
    backend.silent = false;
    expect((await client.call("process/start", start("p33", ["/bin/sh", "-c", "ls"])))["result"]).toBeDefined();
    expect(binder.held).toHaveLength(33);
  });

  it("goes on passing reads of a process the executor reports closed", async () => {
    const { client, backend } = await connected();
    await client.call("process/start", start("p1", ["/bin/sh", "-c", "ls"]));
    backend.emit({ method: "process/closed", params: { processId: "p1", seq: 3 } });
    expect((await client.call("process/read", { processId: "p1" }))["result"]).toBeDefined();
  });

  it("refuses methods it does not know and drops notifications it does not know", async () => {
    const { client, backend } = await connected();
    for (const method of ["http/request", "environmentConfig/read", "capabilities/discoverV2", "fs/chmod"])
      expect(errorOf(await client.call(method, {}))).toMatch(
        /Blocked by ORCA: ORCA does not pass the executor request/,
      );
    client.notify("network/policyDecision", { allow: true });
    client.notify("initialized");
    await client.call("environment/status");
    expect(backend.methods()).toEqual(["initialize", "initialized", "initialized", "environment/status"]);
    expect(records.some((r) => r.method === "network/policyDecision" && r.outcome === "dropped")).toBe(true);
  });

  it("lets an answer through only to a question the executor asked, once", async () => {
    const { client, backend } = await connected();
    client.ws.send(JSON.stringify({ id: 900, result: { allow: true } }));
    backend.emit({ id: 77, method: "network/policyRequest", params: {} });
    await client.call("environment/status");
    expect(client.notifications.some((m) => m["id"] === 77)).toBe(true);
    client.ws.send(JSON.stringify({ id: 77, result: { allow: false } }));
    client.ws.send(JSON.stringify({ id: 77, result: { allow: true } }));
    await client.call("environment/status");
    const answers = backend.received.filter((m) => m["method"] === undefined);
    expect(answers).toEqual([{ id: 77, result: { allow: false } }]);
    // Only the answer's own fields go on, whatever else the frame carried.
    backend.emit({ id: 78, method: "network/policyRequest", params: {} });
    await client.call("environment/status");
    client.ws.send(JSON.stringify({ id: 78, error: { code: 1, message: "no" }, method: 5, params: { x: 1 } }));
    await client.call("environment/status");
    expect(backend.raw.at(-2)).toBe(`{"id":78,"error":{"code":1,"message":"no"}}`);
  });

  it("forwards what the executor says without changing it", async () => {
    const { client, backend } = await connected();
    const line =
      '{"method":"process/output","params":{"processId":"p1","seq":1,"stream":"pty","chunk":"aGk="},"x":  1}';
    const got = new Promise<string>((resolve) => client.ws.once("message", (data) => resolve(frameText(data))));
    backend.emitRaw(line);
    expect(await got).toBe(line);
  });

  it("refuses when ORCA cannot decide: an error, or no answer in time", async () => {
    let mode: "throw" | "hang" = "throw";
    let aborted = false;
    const { client, backend } = await connected((_call, signal) => {
      if (mode === "throw") return Promise.reject(new Error("policy file unreadable"));
      return hangs(() => {
        aborted = true;
      })(_call, signal);
    });
    expect(errorOf(await client.call("process/start", start("p1", ["/bin/sh", "-c", "ls"])))).toBe(
      "Blocked by ORCA: ORCA could not check this call.",
    );
    mode = "hang";
    expect(errorOf(await client.call("process/start", start("p2", ["/bin/sh", "-c", "ls"])))).toBe(
      "Blocked by ORCA: ORCA could not decide this call in time.",
    );
    expect(aborted).toBe(true);
    expect(backend.methods()).toEqual(["initialize", "initialized"]);
  });

  it("decides requests one at a time, in the order they arrived", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const { client, backend } = await connected(async (call) => {
      order.push(`decide ${call.toolCall.title}`);
      if (call.toolCall.title === "first") await new Promise<void>((resolve) => (release = resolve));
      return { allow: true, basis: "test" };
    });
    const first = client.call("process/start", start("p1", ["/bin/sh", "-c", "first"]));
    const second = client.call("process/start", start("p2", ["/bin/sh", "-c", "second"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["decide first"]);
    expect(backend.methods()).not.toContain("process/start");
    release!();
    await Promise.all([first, second]);
    expect(order).toEqual(["decide first", "decide second"]);
    expect(backend.received.filter((m) => m["method"] === "process/start").map((m) => m["id"])).toEqual([2, 3]);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a bare yes", true],
    ["a word", "allow"],
    ["a list", [{ allow: true, basis: "test" }]],
    ["an allow that is not exactly true", { allow: "true", basis: "test" }],
    ["a truthy allow", { allow: 1, basis: "test" }],
    ["an allow with no basis", { allow: true }],
    ["an allow with an empty basis", { allow: true, basis: "" }],
    ["an allow whose basis is not text", { allow: true, basis: {} }],
    ["a refusal with no reason", { allow: false, basis: "test" }],
    ["no allow at all", { basis: "test", reason: "x" }],
  ])("refuses when the decision is %s", async (_what, decision) => {
    const { client, backend } = await connected(() => Promise.resolve(decision as never));
    for (const [method, params] of [
      ["process/start", start("p1", ["/bin/sh", "-c", "ls"])],
      ["fs/writeFile", { path: uri("/work/a.txt"), dataBase64: b64("x") }],
      ["fs/getMetadata", { path: uri("/work/a.txt") }],
    ] as const)
      expect(errorOf(await client.call(method, params))).toBe("Blocked by ORCA: ORCA could not check this call.");
    expect(backend.methods()).toEqual(["initialize", "initialized"]);
    expect(records.filter((r) => r.outcome === "refused").every((r) => r.basis === "gate")).toBe(true);
  });

  it("closes the connection when a request id is used twice before its answer", async () => {
    const { client, backend } = await connected();
    backend.silent = true;
    client.ws.send(JSON.stringify({ id: 500, method: "environment/status" }));
    client.ws.send(JSON.stringify({ id: 500, method: "process/start", params: start("p1", ["/bin/sh", "-c", "ls"]) }));
    await client.closed;
    expect(backend.methods()).not.toContain("process/start");
    expect(records.at(-1)!.reason).toMatch(/request id twice/);
  });
});

describe("what the gate holds", () => {
  const KB = 1024;
  const small = { messageLimitBytes: 64 * KB, connectionBudgetBytes: 192 * KB };
  const filler = (bytes: number): string => "x".repeat(bytes);
  const closedFor = () => records.findLast((r) => r.method === "connection" && r.outcome === "closed")?.reason ?? "";

  it("closes a connection that sends more than its budget while a decision is pending, and keeps counting the decision", async () => {
    const budget = codexExecGateBudget(1024 * KB);
    let release: (() => void) | undefined;
    let told = false;
    const { client, backend } = await connected(
      async (_call, signal) => {
        signal.addEventListener("abort", () => {
          told = true;
        });
        // A decision that hears it should stop and takes its time anyway.
        await new Promise<void>((resolve) => (release = resolve));
        return { allow: true, basis: "test" };
      },
      { ...small, budget },
    );
    // 64 KiB is held for the message being assembled, which leaves 128 KiB for what waits.
    expect(budget.held).toBe(64 * KB);
    const first = JSON.stringify({ id: 1, method: "process/start", params: start("p1", ["/bin/sh", "-c", "ls"]) });
    client.ws.send(first);
    for (let id = 2; id < 6; id++)
      client.ws.send(JSON.stringify({ id, method: "process/read", params: { processId: filler(40 * KB) } }));
    await client.closed;
    await soon();
    expect(closedFor()).toMatch(/hold more than ORCA's gate keeps/);
    // The socket and the requests that were only waiting are gone, and so are their bytes.
    // The decision is still being made: it was told to stop, its request's bytes stay
    // claimed, and the connection is still one the gate counts.
    expect(told).toBe(true);
    expect(budget.held).toBe(Buffer.byteLength(first));
    expect(gate!.connections()).toEqual({ open: 0, stopping: 1 });
    release?.();
    await soon();
    expect(backend.methods()).not.toContain("process/start");
    expect(budget.held).toBe(0);
    expect(gate!.connections()).toEqual({ open: 0, stopping: 0 });
  });

  it("closes a connection whose executor stops reading, and holds what it did not read until it is written or gone", async () => {
    const budget = codexExecGateBudget(1024 * KB);
    const { client, backend } = await connected(allowAll, { ...small, budget });
    backend.stalled = true;
    backend.silent = true;
    backend.onStop = "lingers";
    const data = b64(filler(30 * KB));
    for (let id = 1; id < 8 && client.ws.readyState === WebSocket.OPEN; id++) {
      client.ws.send(
        JSON.stringify({ id, method: "fs/writeFile", params: { path: uri(`/work/${id}`), dataBase64: data } }),
      );
      await soon(10);
    }
    await client.closed;
    await soon();
    expect(closedFor()).toMatch(/hold more than ORCA's gate keeps/);
    // Each unwritten write of about 40 KiB stays claimed, so the 128 KiB left is gone by the third.
    const unwritten = backend.received.filter((m) => m["method"] === "fs/writeFile").length;
    expect(unwritten).toBeLessThanOrEqual(3);
    // The executor was asked to stop and has not: what it has not taken is still ORCA's to hold.
    expect(backend.stopped).toBe(true);
    expect(budget.held).toBeGreaterThan(unwritten * 40 * KB);
    expect(budget.held).toBeLessThan(128 * KB);
    expect(gate!.connections()).toEqual({ open: 0, stopping: 1 });
    // Written at last: the bytes are given back, once. The executor is still there, so the
    // connection still counts.
    backend.flush();
    backend.flush();
    expect(budget.held).toBe(0);
    expect(gate!.connections()).toEqual({ open: 0, stopping: 1 });
    backend.die();
    expect(gate!.connections()).toEqual({ open: 0, stopping: 0 });
  });

  it("counts an ended connection against the limit until its executor is seen to exit", async () => {
    const { client, backend } = await connected(allowAll, { maxConnections: 1 });
    backend.onStop = "lingers";
    client.ws.terminate();
    await client.closed;
    await soon();
    expect(gate!.connections()).toEqual({ open: 0, stopping: 1 });
    await expect(Client.open(gate!.url)).rejects.toThrow(/503/);
    expect(records.at(-1)).toMatchObject({ outcome: "refused", reason: "too many connections" });
    backend.die();
    const again = await Client.open(gate!.url);
    clients.push(again);
    expect(gate!.connections()).toEqual({ open: 1, stopping: 0 });
  });

  it("closes a connection whose agent stops reading what the executor says", async () => {
    const budget = codexExecGateBudget(1024 * KB);
    const { client, backend } = await connected(allowAll, { ...small, budget });
    (client.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const line = JSON.stringify({ method: "process/output", params: { processId: "p1", chunk: filler(48 * KB) } });
    let sent = 0;
    while (closedFor() === "" && sent < 4000) {
      backend.emitRaw(line);
      sent++;
      // A turn of the loop lets a completed write give its bytes back before the next line.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // The kernel takes some megabytes before writes stop completing; after that the budget does.
    expect(sent).toBeLessThan(4000);
    expect(closedFor()).toMatch(/hold more than ORCA's gate keeps/);
    expect(backend.stopped).toBe(true);
    // What was never written is dropped with the socket, and only then given back.
    for (let i = 0; i < 100 && budget.held > 0; i++) await soon(10);
    expect(budget.held).toBe(0);
    expect(gate!.connections()).toEqual({ open: 0, stopping: 0 });
  });

  it("closes a connection that sends one message over the limit", async () => {
    const { client, backend } = await connected(allowAll, small);
    client.ws.send(JSON.stringify({ id: 9, method: "environment/status", params: { pad: filler(80 * KB) } }));
    await client.closed;
    expect(closedFor()).toMatch(/over the size limit/);
    expect(backend.methods()).not.toContain("environment/status");
  });

  it("closes a connection that sends requests faster than they are decided", async () => {
    const { client } = await connected(hangs());
    for (let id = 1; id <= 300 && client.ws.readyState === WebSocket.OPEN; id++)
      client.ws.send(JSON.stringify({ id, method: "fs/getMetadata", params: { path: uri("/work/a") } }));
    await client.closed;
    expect(closedFor()).toMatch(/faster than ORCA decides/);
  });

  it("turns a connection away when every gate together holds too much, and takes one again later", async () => {
    const budget = codexExecGateBudget(100 * KB);
    const first = await open(allowAll, { ...small, budget });
    const one = await Client.open(first.url);
    clients.push(one);
    expect(budget.held).toBe(64 * KB);
    // A second gate on the same budget: its own connection limit is not what stops it.
    const second = await openCodexExecGate({ decide: allowAll, ...small, budget, onRecord: (r) => records.push(r) });
    try {
      await expect(Client.open(second.url)).rejects.toThrow(/503/);
      expect(records.at(-1)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/hold too much/) });
      one.ws.terminate();
      await one.closed;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(budget.held).toBe(0);
      const again = await Client.open(second.url);
      clients.push(again);
      expect(budget.held).toBe(64 * KB);
    } finally {
      await second.close();
    }
    expect(budget.held).toBe(0);
  });

  it("gives a budget's bytes back to its parent, and claims nothing once closed", () => {
    const parent = codexExecGateBudget(100);
    const child = codexExecGateBudget(80, parent);
    expect(child.take(60)).toBe(true);
    expect(child.take(30)).toBe(false);
    expect(codexExecGateBudget(80, parent).take(50)).toBe(false);
    expect(parent.held).toBe(60);
    child.give(1000);
    expect([child.held, parent.held]).toEqual([0, 0]);
    expect(child.take(-1)).toBe(false);
    expect(child.take(0.5)).toBe(false);
    expect(child.take(40)).toBe(true);
    child.close();
    expect([child.held, parent.held]).toEqual([0, 0]);
    expect(child.take(1)).toBe(false);
    child.give(40);
    expect(parent.held).toBe(0);
  });

  it("keeps a record's fields short, whatever the agent or a decision wrote", async () => {
    const { client } = await connected(() =>
      Promise.resolve({ allow: false, basis: "b".repeat(5000), reason: "r".repeat(50_000) }),
    );
    const refused = await client.call("fs/readFile", { path: uri("/work/a.txt") });
    expect(errorOf(refused).length).toBeLessThan(2100);
    await client.call("m".repeat(20_000), {});
    client.notify("n".repeat(20_000));
    client.ws.send(JSON.stringify({ id: "i".repeat(5000), method: "environment/status" }));
    await client.closed;
    for (const record of records) {
      expect(record.method.length).toBeLessThanOrEqual(81);
      expect(record.basis.length).toBeLessThanOrEqual(257);
      expect((record.reason ?? "").length).toBeLessThanOrEqual(1025);
      expect(JSON.stringify(record).length).toBeLessThan(30_000);
    }
    expect(closedFor()).toMatch(/an id ORCA cannot answer/);
  });

  it("keeps a bounded number of records while a listener hears every one", async () => {
    const { client } = await connected();
    await client.call("environment/status");
    const before = records.length;
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 200; i++) client.notify("not/known");
      await client.call("environment/status");
    }
    expect(records.length - before).toBe(12 * 201);
    const keptRecords = gate!.records();
    expect(keptRecords).toHaveLength(2048);
    expect(keptRecords.at(-1)!.seq).toBe(records.at(-1)!.seq);
  });

  it("drops the oldest records once those kept pass their byte limit", async () => {
    const reason = "r".repeat(1000);
    const { client } = await connected(() => Promise.resolve({ allow: false, basis: "test", reason }));
    const long = start("p", ["/bin/echo", ...Array.from({ length: 15 }, () => "y".repeat(2000))]);
    for (let i = 0; i < 200; i++) await client.call("process/start", { ...long, processId: `p${i}` });
    const keptRecords = gate!.records();
    // 200 records of some 19,000 characters each, at two bytes a character, would be over 7 MB.
    expect(keptRecords.length).toBeLessThan(200);
    expect(keptRecords.length).toBeGreaterThan(50);
    expect(2 * JSON.stringify(keptRecords).length).toBeLessThan(4.2 * 1024 * KB);
    expect(keptRecords.at(-1)!.subject).toMatchObject({ processId: "p199" });
  });
});

describe("when something fails", () => {
  it("closes the connection when the executor behind it ends, and answers nothing after", async () => {
    const { client, backend } = await connected();
    backend.die("signal SIGKILL");
    await client.closed;
    expect(records.at(-1)).toMatchObject({ method: "connection", outcome: "closed" });
    expect(records.at(-1)!.reason).toMatch(/SIGKILL/);
  });

  it.each([
    ["a frame that is not JSON", "{not json"],
    ["a frame that is not a message", "[1,2,3]"],
    ["a request with an id it cannot answer", '{"id":{"a":1},"method":"process/read","params":{}}'],
    ["a request with an id that is not a whole number", '{"id":1.5,"method":"environment/status"}'],
  ])("closes the connection on %s", async (_what, frame) => {
    const { client, backend } = await connected();
    client.ws.send(frame);
    await client.closed;
    expect(backend.stopped).toBe(true);
  });

  it("closes the connection on a binary frame", async () => {
    const { client, backend } = await connected();
    client.ws.send(Buffer.from('{"id":9,"method":"environment/status"}'), { binary: true });
    await client.closed;
    expect(backend.methods()).not.toContain("environment/status");
  });

  it("closes the connection when the executor writes something that is not JSON", async () => {
    const { client, backend } = await connected();
    backend.emitRaw("panicked at ...");
    await client.closed;
    expect(backend.stopped).toBe(true);
  });

  it("stops every executor and refuses new connections once closed", async () => {
    const { client, backend } = await connected();
    const g = gate!;
    await g.close();
    await client.closed;
    expect(backend.stopped).toBe(true);
    await expect(Client.open(g.url)).rejects.toThrow();
    expect(() => g.admit(() => new FakeBackend())).toThrow(/closed/);
  });

  it("returns from close within its bound when an executor never stops, and goes on counting what is left", async () => {
    class Stubborn extends FakeBackend {
      override stop(): Promise<void> {
        this.stopped = true;
        return new Promise(() => undefined);
      }
    }
    const binder = fakeBinder();
    let decide: Decide = allowAll;
    let settle: (() => void) | undefined;
    const { client, backend } = await connected((call, signal) => decide(call, signal), {
      closeWaitMs: 150,
      binder,
      backend: () => new Stubborn(),
    });
    // A start the executor has not answered, a write it has not taken, a decision still being
    // made, and requests waiting behind it.
    backend.silent = true;
    void client.call("process/start", start("p1", ["/bin/sh", "-c", "ls"]));
    await client.raw(80, `{"id":80,"method":"bogus"}`);
    backend.stalled = true;
    void client.call("fs/writeFile", { path: uri("/work/a"), dataBase64: b64("x".repeat(2000)) });
    await client.raw(81, `{"id":81,"method":"bogus"}`);
    decide = () =>
      new Promise((resolve) => {
        settle = () => resolve({ allow: true, basis: "test" });
      });
    for (let id = 100; id < 150; id++)
      client.ws.send(JSON.stringify({ id, method: "fs/readFile", params: { path: uri(`/work/${id}`) } }));
    await soon();
    const g = gate!;
    const began = Date.now();
    await g.close();
    expect(Date.now() - began).toBeLessThan(1500);
    await client.closed;
    // The caller has its answer. Nothing was given back that had not drained: the directory
    // is held, the unwritten write and the request being decided are claimed, and the
    // connection is counted.
    expect(backend.stopped).toBe(true);
    expect(binder.released).toEqual([]);
    expect(g.connections()).toEqual({ open: 0, stopping: 1 });
    const held = codexExecGateHeldBytes();
    expect(held).toBeGreaterThan(2000);
    expect(held).toBeLessThan(8 * 1024);
    // The decision settles: its request's bytes go, the rest stays.
    settle!();
    await soon();
    expect(codexExecGateHeldBytes()).toBeGreaterThan(2000);
    expect(codexExecGateHeldBytes()).toBeLessThan(held);
    expect(g.connections()).toEqual({ open: 0, stopping: 1 });
    expect(backend.methods().filter((m) => m === "fs/readFile")).toEqual([]);
    // The executor is seen to exit: the directory is let go and nothing is left.
    backend.die("signal SIGKILL");
    expect(binder.released).toEqual(["/work"]);
    expect(codexExecGateHeldBytes()).toBe(0);
    expect(g.connections()).toEqual({ open: 0, stopping: 0 });
  });
});

describe.skipIf(process.platform !== "linux")("this machine's binder", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1026-bind-")));
    await mkdir(join(root, "dir", "sub"), { recursive: true });
    await writeFile(join(root, "dir", "file.txt"), "x");
    await symlink(join(root, "dir"), join(root, "to-dir"));
    await symlink(join(root, "dir", "file.txt"), join(root, "to-file"));
    await symlink(join(root, "nowhere"), join(root, "dangling"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the file a path leads to, and keeps the last name for a removal", () => {
    const binder = codexExecGateBinder();
    expect(binder.target(join(root, "to-dir", "file.txt"))).toBe(join(root, "dir", "file.txt"));
    expect(binder.target(join(root, "to-file"))).toBe(join(root, "dir", "file.txt"));
    expect(binder.target(join(root, "to-dir", "new", "deep.txt"))).toBe(join(root, "dir", "new", "deep.txt"));
    // A link to a file that is not there yet leads where a write through it would create one.
    expect(binder.target(join(root, "dangling"))).toBe(join(root, "nowhere"));
    expect(binder.target(join(root, "dir", "file.txt", "under-a-file"))).toBeUndefined();
    expect(binder.entry(join(root, "to-dir", "file.txt"))).toBe(join(root, "dir", "file.txt"));
    expect(binder.entry(join(root, "to-file"))).toBe(join(root, "to-file"));
    expect(binder.entry("/")).toBeUndefined();
  });

  it("holds a directory by descriptor: the same directory under any name, until released", async () => {
    const binder = codexExecGateBinder();
    const hold = binder.directory(join(root, "to-dir", "sub"))!;
    expect(hold.real).toBe(join(root, "dir", "sub"));
    expect(hold.reach).toMatch(new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
    expect(readlinkSync(hold.reach)).toBe(join(root, "dir", "sub"));
    // The name now leads somewhere else; the descriptor still holds the directory that was decided.
    await rename(join(root, "dir", "sub"), join(root, "dir", "moved"));
    await symlink("/etc", join(root, "dir", "sub"));
    expect(readlinkSync(hold.reach)).toBe(join(root, "dir", "moved"));
    hold.release();
    hold.release();
    expect(existsSync(hold.reach)).toBe(false);
  });

  it("holds nothing that is not a directory that is there", () => {
    const binder = codexExecGateBinder();
    expect(binder.directory(join(root, "dir", "file.txt"))).toBeUndefined();
    expect(binder.directory(join(root, "to-file"))).toBeUndefined();
    expect(binder.directory(join(root, "dangling"))).toBeUndefined();
    expect(binder.directory(join(root, "missing"))).toBeUndefined();
  });

  it("gives the executor a descriptor for a start, and closes it once the start is answered", async () => {
    const { client, backend } = await connected(allowAll, { binder: codexExecGateBinder() });
    backend.silent = true;
    const started = client.call(
      "process/start",
      start("p1", ["/bin/sh", "-c", "ls"], { cwd: uri(join(root, "to-dir")) }),
    );
    await client.raw(90, `{"id":90,"method":"bogus"}`);
    const sent = backend.received.at(-1)!;
    const reach = codexExecPath((sent["params"] as { cwd: string }).cwd);
    expect(readlinkSync(reach)).toBe(join(root, "dir"));
    expect(calls[0]).toMatchObject({ cwd: join(root, "dir"), asWritten: { cwd: join(root, "to-dir") } });
    backend.emit({ id: sent["id"], result: { processId: "p1" } });
    await started;
    expect(existsSync(reach)).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("the session's policy at the gate", () => {
  let root: string;
  let workspace: string;
  let configDir: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1026-gate-")));
    workspace = join(root, "work");
    configDir = join(root, "config");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(configDir, ".orca"), { recursive: true });
    await writeFile(join(configDir, "orca.config.yaml"), "agents: []\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const context = (permissions: ClaudeHookContext["permissions"] = { rules: [] }): ClaudeHookContext => ({
    version: 1,
    agentId: "codex",
    permissions,
    permissionFiles: [permissionPolicyPath(configDir)],
    workspaceCwd: workspace,
    protectedPaths: {
      readOnly: [join(configDir, "orca.config.yaml"), permissionPolicyPath(configDir), join(configDir, ".orca")],
      noAccess: [join(configDir, "auth")],
    },
  });
  /** Plan a request with this machine's binder and decide it, as the gate does. */
  const decideAll = async (ctx: ClaudeHookContext, method: string, params: Record<string, unknown>) => {
    const state = newCodexExecGateConnectionState();
    state.processes.set("p1", "open");
    const planned = planCodexExecRequest(method, params, state, codexExecGateBinder());
    if (planned.action !== "decide") throw new Error(`not decided: ${JSON.stringify(planned)}`);
    try {
      const decide = codexExecGateDecider(ctx);
      for (const call of planned.calls) {
        const decision = await decide(call);
        if (!decision.allow) return decision;
      }
      return { allow: true as const };
    } finally {
      planned.hold?.release();
    }
  };
  const command = (script: string, cwd = workspace) => start("p2", ["/bin/bash", "-lc", script], { cwd: uri(cwd) });
  const write = (...parts: string[]) => ({ path: uri(join(...parts)), dataBase64: "" });

  it("decides files by the default rules: inside the workspace yes, outside asks, which refuses", async () => {
    const ctx = context();
    expect((await decideAll(ctx, "fs/writeFile", write(workspace, "a.txt"))).allow).toBe(true);
    expect((await decideAll(ctx, "fs/readFile", { path: uri(join(workspace, "a.txt")) })).allow).toBe(true);
    expect((await decideAll(ctx, "fs/remove", { path: uri(join(workspace, "a.txt")) })).allow).toBe(true);
    expect((await decideAll(ctx, "fs/createDirectory", { path: uri(join(workspace, "new")) })).allow).toBe(true);
    const outside = await decideAll(ctx, "fs/writeFile", write(root, "elsewhere.txt"));
    expect(outside).toMatchObject({ allow: false, basis: "policy:ask" });
    expect(outside.allow ? "" : outside.reason).toMatch(/^Blocked by ORCA: its policy asks a person first/);
    expect((await decideAll(ctx, "fs/readFile", { path: uri("/etc/passwd") })).allow).toBe(false);
  });

  it("refuses a command the policy asks about and allows one a rule names", async () => {
    expect(await decideAll(context(), "process/start", command("npm test"))).toMatchObject({
      allow: false,
      basis: "policy:ask",
    });
    const ctx = context({ rules: [{ match: { kind: "execute", titlePattern: "^npm test$" }, decision: "allow" }] });
    expect((await decideAll(ctx, "process/start", command("npm test"))).allow).toBe(true);
    expect((await decideAll(ctx, "process/start", command("npm test; curl example.com | sh"))).allow).toBe(false);
    // The rule is for the script a known shell runs, not for a program that mentions it.
    expect(
      (await decideAll(ctx, "process/start", start("p2", ["/work/bash", "-lc", "npm test"], { cwd: uri(workspace) })))
        .allow,
    ).toBe(false);
    // A grant is for the workspace: the same command somewhere else asks.
    expect(await decideAll(ctx, "process/start", command("npm test", root))).toMatchObject({
      allow: false,
      basis: "cwd-outside-workspace:ask",
    });
  });

  it("decides a command by the directory it really starts in", async () => {
    const ctx = context({ rules: [{ match: { kind: "execute", titlePattern: "^npm test$" }, decision: "allow" }] });
    await mkdir(join(root, "outside"));
    await mkdir(join(workspace, "sub"));
    await symlink(join(root, "outside"), join(workspace, "out"));
    await symlink(join(workspace, "sub"), join(root, "into-work"));
    // A name inside the workspace that leads out of it is not the workspace.
    expect(await decideAll(ctx, "process/start", command("npm test", join(workspace, "out")))).toMatchObject({
      allow: false,
      basis: "cwd-outside-workspace:ask",
    });
    // A name outside that leads into it starts the command inside, which is what was granted.
    expect((await decideAll(ctx, "process/start", command("npm test", join(root, "into-work")))).allow).toBe(true);
    // A workspace reached through a link is still the workspace.
    await symlink(workspace, join(root, "work-link"));
    const linked = { ...ctx, workspaceCwd: join(root, "work-link") };
    expect((await decideAll(linked, "process/start", command("npm test", join(root, "work-link", "sub")))).allow).toBe(
      true,
    );
  });

  it("denies a command a rule denies, with the denial's words", async () => {
    const ctx = context({
      default: "allow",
      rules: [{ match: { kind: "execute", titlePattern: "rm -rf" }, decision: "deny" }],
    });
    const denied = await decideAll(ctx, "process/start", command("rm -rf build"));
    expect(denied).toMatchObject({ allow: false, basis: "policy:deny" });
    expect(denied.allow ? "" : denied.reason).toMatch(/^Denied by ORCA/);
    expect((await decideAll(ctx, "process/start", command("ls"))).allow).toBe(true);
  });

  it("never allows typed input by a rule written for commands, or by a default of allow", async () => {
    const typed = { processId: "p1", chunk: b64("y\n"), writeId: "1" };
    for (const permissions of [
      { default: "allow" as const, rules: [] },
      { rules: [{ match: { kind: "execute" as const }, decision: "allow" as const }] },
      { rules: [{ match: { titlePattern: ".*" }, decision: "allow" as const }] },
      { rules: [{ match: {}, decision: "allow" as const }] },
    ])
      expect(await decideAll(context(permissions), "process/write", typed)).toMatchObject({
        allow: false,
        basis: "policy:ask",
      });
  });

  it("allows typed input only by a rule that names it, and a deny still wins", async () => {
    const typed = (textTyped: string) => ({ processId: "p1", chunk: b64(textTyped), writeId: "1" });
    const named = {
      match: { kind: "execute" as const, titlePattern: '^write_stdin: "y\\\\n"$' },
      decision: "allow" as const,
    };
    expect((await decideAll(context({ rules: [named] }), "process/write", typed("y\n"))).allow).toBe(true);
    expect((await decideAll(context({ rules: [named] }), "process/write", typed("yes please\n"))).allow).toBe(false);
    const denyFirst = context({
      rules: [
        { match: { titlePattern: "sudo" }, decision: "deny" },
        { match: { titlePattern: "^write_stdin: " }, decision: "allow" },
      ],
    });
    expect((await decideAll(denyFirst, "process/write", typed("ls\n"))).allow).toBe(true);
    expect(await decideAll(denyFirst, "process/write", typed("sudo rm -rf /\n"))).toMatchObject({
      allow: false,
      basis: "policy:deny",
    });
  });

  it("keeps a typed-input policy's origins in step with its rules", () => {
    const narrowed = typedInputPolicy({
      default: "allow",
      rules: [
        { match: { kind: "execute" }, decision: "allow" },
        { match: { titlePattern: "x" }, decision: "deny" },
        { match: { titlePattern: "write_stdin" }, decision: "allow" },
      ],
      origins: [
        { layer: "config", index: 0 },
        { layer: "config", index: 1 },
        { layer: "config", index: 2 },
      ],
    });
    expect(narrowed.default).toBe("ask");
    expect(narrowed.rules.map((r) => r.decision)).toEqual(["deny", "allow"]);
    expect(narrowed.origins).toEqual([
      { layer: "config", index: 1 },
      { layer: "config", index: 2 },
    ]);
  });

  it("refuses ORCA's own files whatever the rules say, probes included", async () => {
    const ctx = context({ default: "allow", rules: [] });
    expect(await decideAll(ctx, "fs/writeFile", write(configDir, "orca.config.yaml"))).toMatchObject({
      allow: false,
      basis: "protected:deny",
    });
    expect(await decideAll(ctx, "fs/remove", { path: uri(join(configDir, ".orca")) })).toMatchObject({
      allow: false,
      basis: "protected:deny",
    });
    const secret = uri(join(configDir, "auth", "token"));
    expect(await decideAll(ctx, "fs/readFile", { path: secret })).toMatchObject({ allow: false });
    expect(await decideAll(ctx, "fs/getMetadata", { path: secret })).toMatchObject({
      allow: false,
      basis: "protected",
    });
    // A probe through a link into them is a probe of them.
    await symlink(join(configDir, "auth"), join(workspace, "notes"));
    expect(await decideAll(ctx, "fs/getMetadata", { path: uri(join(workspace, "notes", "token")) })).toMatchObject({
      allow: false,
      basis: "protected",
    });
    // A probe of anything else opens nothing and is passed, inside the workspace or not.
    expect((await decideAll(context(), "fs/getMetadata", { path: uri("/etc/hostname") })).allow).toBe(true);
  });

  it("decides a path by the file it really names", async () => {
    const ctx = context();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(workspace, "real.txt"), "x");
    await symlink(outside, join(workspace, "out"));
    await symlink(join(root, "not-there-yet.txt"), join(workspace, "dangling.txt"));
    await symlink(join(workspace, "real.txt"), join(workspace, "alias.txt"));
    // A link out of the workspace is not a workspace file, whatever its own path says.
    for (const name of ["out/new.txt", "dangling.txt"])
      expect(await decideAll(ctx, "fs/writeFile", write(workspace, name))).toMatchObject({
        allow: false,
        basis: "policy:ask",
      });
    expect((await decideAll(ctx, "fs/readFile", { path: uri(join(workspace, "out", "x")) })).allow).toBe(false);
    // A link to another workspace file still is one.
    expect((await decideAll(ctx, "fs/writeFile", write(workspace, "alias.txt"))).allow).toBe(true);
    // A workspace reached through a link is still the workspace.
    await symlink(workspace, join(root, "work-link"));
    const linked = { ...ctx, workspaceCwd: join(root, "work-link") };
    expect((await decideAll(linked, "fs/writeFile", write(root, "work-link", "a.txt"))).allow).toBe(true);
    expect((await decideAll(linked, "fs/writeFile", write(root, "work-link", "out", "a"))).allow).toBe(false);
    // A link into ORCA's own files is refused as those files.
    await symlink(join(configDir, "orca.config.yaml"), join(workspace, "innocent.yaml"));
    expect(await decideAll(ctx, "fs/writeFile", write(workspace, "innocent.yaml"))).toMatchObject({
      allow: false,
      basis: "protected:deny",
    });
  });

  it("allows a file reached through a link only when the file and the name are both allowed", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(workspace, "out"));
    const byName = { match: { kind: "edit" as const, pathPrefix: "out/" }, decision: "allow" as const };
    const byFile = { match: { kind: "edit" as const, pathPrefix: `${outside}/` }, decision: "allow" as const };
    // A rule written for the name does not open the file the link leads to.
    expect(
      await decideAll(context({ rules: [byName] }), "fs/writeFile", write(workspace, "out", "new.txt")),
    ).toMatchObject({ allow: false, basis: "policy:ask" });
    // A rule for the file itself does, under a name the workspace rules already allow.
    expect(
      (await decideAll(context({ rules: [byFile] }), "fs/writeFile", write(workspace, "out", "new.txt"))).allow,
    ).toBe(true);
    expect((await decideAll(context({ rules: [byFile] }), "fs/writeFile", write(outside, "new.txt"))).allow).toBe(true);
    // And a rule that guards the name still guards it when the file is allowed.
    const guarded = context({
      rules: [{ match: { pathPrefix: "out/" }, decision: "deny" }, byFile],
    });
    expect(await decideAll(guarded, "fs/writeFile", write(workspace, "out", "new.txt"))).toMatchObject({
      allow: false,
      basis: "policy:deny",
    });
    expect((await decideAll(guarded, "fs/writeFile", write(outside, "new.txt"))).allow).toBe(true);
  });

  it("removes the entry a path names, not the file a link there leads to", async () => {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "kept.txt"), "x");
    await symlink(join(root, "outside", "kept.txt"), join(workspace, "link.txt"));
    const state = newCodexExecGateConnectionState();
    const planned = planCodexExecRequest(
      "fs/remove",
      { path: uri(join(workspace, "link.txt")) },
      state,
      codexExecGateBinder(),
    );
    // The executor is sent the link's own path, told to follow no link, and refuses a link there.
    expect(planned).toMatchObject({ params: { path: uri(join(workspace, "link.txt")), followSymlinks: false } });
  });

  it("asks, so refuses, once the sidecar cannot be read", async () => {
    await writeFile(permissionPolicyPath(configDir), "{ this is not a policy file");
    const decision = await decideAll(context(), "fs/writeFile", write(workspace, "a.txt"));
    expect(decision).toMatchObject({ allow: false, basis: "sidecar-unreadable:ask" });
  });
});

describe.skipIf(process.platform === "win32")("the real executor behind the gate", () => {
  const sent = (): void => undefined;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orca-1026-backend-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A program standing in for `codex`: it must be started as `exec-server --listen stdio`. */
  const program = async (body: string): Promise<string> => {
    const script = join(dir, "codex.cjs");
    await writeFile(script, body);
    const file = join(dir, "codex");
    await writeFile(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    await chmod(file, 0o755);
    return file;
  };
  const echo = `
    const args = process.argv.slice(2).join(" ");
    const lines = require("node:readline").createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const m = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: m.id, result: { args, url: process.env.CODEX_EXEC_SERVER_URL ?? null, kept: process.env.KEPT, cwd: process.cwd() } }) + "\\n");
    });
    lines.on("close", () => process.exit(0));
  `;
  const exitOf = (backend: CodexExecBackend) => new Promise<string>((resolve) => backend.onExit(resolve));
  const nextMessage = (backend: CodexExecBackend) =>
    new Promise<Record<string, unknown>>((resolve) =>
      backend.onMessage((message) => resolve(JSON.parse(message) as Record<string, unknown>)),
    );

  it("starts it as exec-server over stdio, without the gate's own address in its environment", async () => {
    const backend = spawnCodexExecServer({
      program: await program(echo),
      env: { ...process.env, CODEX_EXEC_SERVER_URL: "ws://127.0.0.1:1/secret", KEPT: "yes" },
      cwd: dir,
    });
    const answer = nextMessage(backend);
    let flushed = 0;
    backend.send(JSON.stringify({ id: 1, method: "initialize" }), () => flushed++);
    expect(await answer).toEqual({
      id: 1,
      result: {
        args: "exec-server --listen stdio",
        url: null,
        kept: "yes",
        cwd: expect.stringContaining("orca-1026-backend-"),
      },
    });
    expect(flushed).toBe(1);
    const exit = exitOf(backend);
    await backend.stop();
    expect(await exit).toBe("exit 0");
    expect(() => backend.send("{}", sent)).toThrow(/gone/);
  });

  it("ends one that ignores its input closing, by signalling that child", async () => {
    const backend = spawnCodexExecServer({
      program: await program(
        `process.stdin.resume(); process.stdin.on("end", () => {}); setInterval(() => {}, 1000); process.stdout.write('{"ready":true}\\n');`,
      ),
      env: process.env,
      cwd: dir,
      stopGraceMs: 200,
    });
    await nextMessage(backend);
    const exit = exitOf(backend);
    await backend.stop();
    expect(await exit).toBe("signal SIGTERM");
  });

  it("reports a program that cannot be started", async () => {
    const backend = spawnCodexExecServer({ program: join(dir, "missing"), env: process.env, cwd: dir });
    expect(await exitOf(backend)).toMatch(/could not be started/);
    expect(() => backend.send("{}", sent)).toThrow(/gone/);
    await backend.stop();
  });

  it("reports the exit of one that dies, and reads messages split across writes", async () => {
    const backend = spawnCodexExecServer({
      program: await program(`
        process.stdout.write('{"a":');
        setTimeout(() => { process.stdout.write('1}\\n{"b":2}\\n\\n'); setTimeout(() => process.kill(process.pid, "SIGKILL"), 50); }, 50);
        process.stdin.resume();
      `),
      env: process.env,
      cwd: dir,
    });
    const got: string[] = [];
    backend.onMessage((message) => got.push(message));
    expect(await exitOf(backend)).toBe("signal SIGKILL");
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
  });
  it("ends one that ignores its input closing and the request to end, within its bound", async () => {
    const backend = spawnCodexExecServer({
      program: await program(
        `process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write('{"ready":true}\\n');`,
      ),
      env: process.env,
      cwd: dir,
      stopGraceMs: 150,
    });
    await nextMessage(backend);
    const exit = exitOf(backend);
    const began = Date.now();
    await backend.stop();
    expect(await exit).toBe("signal SIGKILL");
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it("tells the sender a message was written, or dropped, exactly once", async () => {
    const backend = spawnCodexExecServer({
      // It never reads, so most of what is sent stays in ORCA's memory until it is gone.
      program: await program(`setInterval(() => {}, 1000); process.stdout.write('{"ready":true}\\n');`),
      env: process.env,
      cwd: dir,
      stopGraceMs: 100,
    });
    await nextMessage(backend);
    let flushed = 0;
    const big = "x".repeat(256 * 1024);
    for (let i = 0; i < 40; i++) backend.send(big, () => flushed++);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(flushed).toBeLessThan(40);
    await backend.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushed).toBe(40);
  });

  it("reads many messages in order under load, however the writes are cut, and holds nothing after", async () => {
    const budget = codexExecGateBudget(1024 * 1024);
    const backend = spawnCodexExecServer({
      program: await program(`
        const lines = [];
        for (let i = 0; i < 5000; i++) lines.push(JSON.stringify({ i, pad: "p".repeat(i % 700) }));
        const all = Buffer.from(lines.join("\\n") + "\\n");
        let at = 0;
        const more = () => {
          // Cuts of every size, most of them in the middle of a message.
          while (at < all.length) {
            const size = 1 + ((at * 7919) % 9000);
            const ok = process.stdout.write(all.subarray(at, at + size));
            at += size;
            if (!ok) return process.stdout.once("drain", more);
          }
        };
        more();
        process.stdin.resume();
        process.stdin.on("end", () => process.exit(0));
      `),
      env: process.env,
      cwd: dir,
      budget,
    });
    const got: number[] = [];
    let peak = 0;
    const done = new Promise<void>((resolve) =>
      backend.onMessage((message) => {
        const parsed = JSON.parse(message) as { i: number; pad: string };
        expect(parsed.pad).toHaveLength(parsed.i % 700);
        got.push(parsed.i);
        peak = Math.max(peak, budget.held);
        if (parsed.i === 4999) resolve();
      }),
    );
    await done;
    expect(got).toEqual(Array.from({ length: 5000 }, (_, i) => i));
    // A message under assembly is the most that is ever held: here well under a kilobyte.
    expect(peak).toBeLessThan(1024);
    expect(budget.held).toBe(0);
    await backend.stop();
  });

  it.each<[string, { messageLimitBytes: number; budget?: CodexExecGateBudget }, RegExp]>([
    ["longer than the message limit", { messageLimitBytes: 64 * 1024 }, /over the size limit/],
    [
      "more than the connection may hold",
      { messageLimitBytes: 1024 * 1024, budget: codexExecGateBudget(100 * 1024) },
      /more than ORCA's gate holds/,
    ],
  ])("gives up an executor that writes a message %s, and holds nothing after", async (_what, limits, why) => {
    const backend = spawnCodexExecServer({
      program: await program(`
        process.stdout.write('{"first":1}\\n');
        const chunk = "y".repeat(16 * 1024);
        const more = () => { while (process.stdout.write(chunk)); process.stdout.once("drain", more); };
        more();
        process.stdin.resume();
      `),
      env: process.env,
      cwd: dir,
      ...limits,
    });
    const got: string[] = [];
    backend.onMessage((message) => got.push(message));
    expect(await exitOf(backend)).toMatch(why);
    expect(got).toEqual(['{"first":1}']);
    expect(limits.budget?.held ?? 0).toBe(0);
    expect(() => backend.send("{}", sent)).toThrow(/gone/);
  });
  it("closes a flooded connection at its budget and ends the executor that stopped reading", async () => {
    const budget = codexExecGateBudget(1024 * 1024);
    const records: CodexExecGateRecord[] = [];
    const flooded = await openCodexExecGate({
      decide: () => Promise.resolve({ allow: true, basis: "test" }),
      onRecord: (record) => records.push(record),
      binder: fakeBinder(),
      messageLimitBytes: 64 * 1024,
      connectionBudgetBytes: 256 * 1024,
      budget,
      closeWaitMs: 2000,
    });
    // It answers `initialize` and then never reads again.
    const stuck = await program(`
      let buffered = "";
      const onData = (chunk) => {
        buffered += chunk;
        const end = buffered.indexOf("\\n");
        if (end === -1) return;
        process.stdin.off("data", onData);
        process.stdin.pause();
        process.stdout.write(JSON.stringify({ id: JSON.parse(buffered.slice(0, end)).id, result: {} }) + "\\n");
      };
      process.stdin.on("data", onData);
      setInterval(() => {}, 1000);
    `);
    let exit: Promise<string> | undefined;
    flooded.admit(({ budget: connection }) => {
      const backend = spawnCodexExecServer({
        program: stuck,
        env: process.env,
        cwd: dir,
        stopGraceMs: 100,
        budget: connection,
        messageLimitBytes: 64 * 1024,
      });
      exit = exitOf(backend);
      return backend;
    });
    try {
      const client = await Client.open(flooded.url);
      expect((await client.call("initialize", { clientName: "codex" }))["result"]).toBeDefined();
      const data = b64("z".repeat(36 * 1024));
      let sentWrites = 0;
      // A megabyte and a half at most; the pipe and the budget are full long before that.
      while (client.ws.readyState === WebSocket.OPEN && sentWrites < 30) {
        client.ws.send(
          JSON.stringify({
            id: 1000 + sentWrites,
            method: "fs/writeFile",
            params: { path: uri("/work/f"), dataBase64: data },
          }),
        );
        sentWrites++;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await client.closed;
      expect(sentWrites).toBeLessThan(30);
      expect(records.findLast((r) => r.method === "connection" && r.outcome === "closed")?.reason).toMatch(
        /hold more than ORCA's gate keeps/,
      );
      // The executor is being stopped and is not gone yet: the writes it never read are still
      // in ORCA's memory, so they are still claimed and the connection is still counted.
      expect(budget.held).toBeGreaterThan(36 * 1024);
      expect(flooded.connections()).toEqual({ open: 0, stopping: 1 });
      // It ignored its input closing, so it was signalled. Seen to exit, nothing is left.
      expect(await exit).toMatch(/^signal SIG(TERM|KILL)$/);
      for (let i = 0; i < 100 && budget.held > 0; i++) await soon(10);
      expect(budget.held).toBe(0);
      expect(flooded.connections()).toEqual({ open: 0, stopping: 0 });
    } finally {
      const began = Date.now();
      await flooded.close();
      expect(Date.now() - began).toBeLessThan(2500);
    }
    expect(budget.held).toBe(0);
  });
});
