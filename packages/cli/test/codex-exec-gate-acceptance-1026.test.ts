/**
 * ORCA's gate in Codex's executor path (#1026) against the real Codex ACP adapter and the real
 * Codex it depends on, with the scripted model stand-in, so no account, key or model spend is
 * involved. `codex-exec-gate-acceptance.yml` installs the pinned pair and runs this with
 * `ORCA_CODEX_ADAPTER` set to the adapter's entry point; without it there is nothing to run.
 *
 * No hook is installed here, and Codex runs in the adapter's full-access mode with no sandbox
 * and no asks of its own, so whether a call runs is decided by the gate alone. Each effect is
 * a file in the workspace, read independently of anything Codex or the gate says, and each
 * decision is read from the gate's own record of that request.
 *
 * What is observed on the installed pair:
 * - with `CODEX_EXEC_SERVER_URL` pointing at the gate, every shell command, every byte typed
 *   into a running command, every patch and every image read arrives at the gate, and one the
 *   gate refuses does not happen;
 * - typed input (`write_stdin`), which no hook ever sees, is refused unless a rule names it;
 * - a decision holds for the file the executor uses, not for a name: a path through a link
 *   is decided as the file it leads to, and when a link is swapped in after ORCA decided,
 *   the pinned executor refuses it and nothing outside the decision is written. A command
 *   starts in the directory ORCA decided even when that name leads somewhere else by then;
 * - the file requests the executor cannot be held to one file for are refused, and Codex
 *   carries on without them;
 * - a grant revoked mid-session refuses the very next call;
 * - when ORCA's part fails, the call fails: the policy cannot be decided, the gate is closed,
 *   the gate never admitted the runtime, or the connection does not carry the session's
 *   token. Nothing runs anywhere else, because this Codex has no other executor. When only
 *   the executor behind the gate is killed, Codex connects again, and reaches a new one only
 *   through the gate, which decides every request as before;
 * - the Codex behaviour this rests on, pinned so a change is noticed: a local MCP server does
 *   not start without a local executor.
 *
 * Nothing here wires the gate into ORCA's sessions or claims a support tier.
 */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import {
  CODEX_HOOK_VERIFIED_PAIRS,
  LocalHost,
  codexExecGateBinder,
  codexExecGateDecider,
  codexExecGateHeldBytes,
  openAcpSession,
  openCodexExecGate,
  permissionPolicyPath,
  readPermissionPolicyFile,
  replacePermissionPolicyFile,
  spawnCodexExecServer,
  type AgentSession,
  type ClaudeHookContext,
  type CodexExecGate,
  type CodexExecGateBinder,
  type CodexExecGateCall,
  type CodexExecGateConnection,
  type CodexExecGateDecision,
  type CodexExecGateRecord,
  type OpenSessionOptions,
} from "@orca/agents";
import { modelStandIn, patch, script, shell, type ModelStandIn, type Step } from "./codex-model-stand-in.js";

const ADAPTER = process.env["ORCA_CODEX_ADAPTER"];
/** The Codex the adapter runs: the platform package installed beside it. */
const RUNTIME =
  ADAPTER === undefined
    ? ""
    : join(
        ADAPTER,
        "..",
        "..",
        "..",
        "..",
        "@openai",
        "codex-linux-x64",
        "vendor",
        "x86_64-unknown-linux-musl",
        "bin",
        "codex",
      );

/** A 1x1 PNG, for `view_image`. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

type Decide = (call: CodexExecGateCall, signal: AbortSignal) => Promise<CodexExecGateDecision>;

describe.skipIf(ADAPTER === undefined)("ORCA's exec gate in the real Codex (#1026)", () => {
  let model: ModelStandIn;
  let root: string;
  let configDir: string;
  let workspace: string;
  let codexHome: string;

  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(async () => {
    model.server.close();
    await once(model.server, "close").catch(() => undefined);
  });

  let gate: CodexExecGate | undefined;
  let session: AgentSession | undefined;
  let records: CodexExecGateRecord[] = [];
  /** The pid of each executor ORCA started behind the gate. */
  let executors: number[] = [];
  /** Every message the gate passed to an executor, as the executor received it. */
  let passed: string[] = [];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1026-acceptance-")));
    configDir = join(root, "config");
    workspace = join(root, "work");
    codexHome = join(root, "codex-home");
    await mkdir(join(configDir, ".orca"), { recursive: true });
    await mkdir(workspace);
    await mkdir(codexHome);
    model.outputs.length = 0;
    records = [];
    executors = [];
    passed = [];
    asks.length = 0;
    onTestFailed(() =>
      console.error(
        `tool outputs Codex sent the model:\n${model.outputs.join("\n")}\n` +
          `what the gate recorded:\n${records.map((r) => JSON.stringify(r)).join("\n")}`,
      ),
    );
    return async () => {
      await session?.close().catch(() => undefined);
      await gate?.close();
      session = undefined;
      gate = undefined;
      // Whatever a session did, a closed gate holds nothing.
      expect(codexExecGateHeldBytes()).toBe(0);
      // Codex may still be writing its home as the session closes.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    };
  });

  /** Codex pointed at the stand-in, with no sandbox and no approvals of its own. */
  const codexConfig = (extra: Record<string, unknown> = {}) => ({
    model: "gpt-5.5",
    model_provider: "standin",
    model_providers: {
      standin: { name: "standin", base_url: model.url, wire_api: "responses", env_key: "ORCA_1026_KEY" },
    },
    sandbox_mode: "danger-full-access",
    approval_policy: "never",
    ...extra,
  });

  const agentEnv = (env: Record<string, string>): Record<string, string> => ({
    CODEX_HOME: codexHome,
    CODEX_CONFIG: JSON.stringify(codexConfig()),
    INITIAL_AGENT_MODE: "agent-full-access",
    ORCA_1026_KEY: "sk-orca-1026-test",
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
    ...env,
  });

  /** What ORCA's session layer hands the hook, here handed to the gate's decider. */
  const context = (permissions: ClaudeHookContext["permissions"]): ClaudeHookContext => ({
    version: 1,
    agentId: "codex",
    permissions,
    permissionFiles: [permissionPolicyPath(configDir)],
    workspaceCwd: workspace,
    protectedPaths: {
      readOnly: [permissionPolicyPath(configDir), join(configDir, ".orca")],
      noAccess: [join(configDir, "auth")],
    },
  });

  /** Every permission ask that reaches ORCA's human channel; each one is refused. */
  const asks: string[] = [];
  const askPermission: NonNullable<OpenSessionOptions["askPermission"]> = async (req) => {
    asks.push(req.toolCall.title ?? "");
    return req.options.find((o) => o.kind === "reject_once")?.optionId;
  };

  const exists = (name: string) =>
    readFile(join(workspace, name), "utf8").then(
      (t) => t,
      () => undefined,
    );

  const startExecutor = ({ budget }: CodexExecGateConnection) => {
    const backend = spawnCodexExecServer({
      program: RUNTIME,
      env: { ...process.env, ...agentEnv({}) },
      cwd: workspace,
      budget,
    });
    if (backend.pid !== undefined) executors.push(backend.pid);
    const send = backend.send.bind(backend);
    backend.send = (message, flushed) => {
      passed.push(message);
      send(message, flushed);
    };
    return backend;
  };

  /** A Codex session whose only executor is ORCA's gate, deciding by `permissions`. */
  async function gated(
    permissions: ClaudeHookContext["permissions"] = { rules: [] },
    more: {
      decide?: Decide;
      /** Something to do between ORCA's decision and the request reaching the executor. */
      afterDeciding?: (call: CodexExecGateCall, decision: CodexExecGateDecision) => Promise<void>;
      admit?: boolean;
      env?: Record<string, string>;
      url?: (url: string) => string;
      binder?: CodexExecGateBinder;
    } = {},
  ): Promise<AgentSession> {
    const byPolicy = codexExecGateDecider(context(permissions));
    const decide: Decide = more.decide ?? ((call) => byPolicy(call));
    gate = await openCodexExecGate({
      decide: async (call, signal) => {
        const decision = await decide(call, signal);
        await more.afterDeciding?.(call, decision);
        return decision;
      },
      onRecord: (record) => records.push(record),
      decisionTimeoutMs: 2000,
      admissionWaitMs: 2000,
      ...(more.binder ? { binder: more.binder } : {}),
    });
    if (more.admit !== false) gate.admit(startExecutor);
    session = await openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: process.execPath,
        args: [ADAPTER],
        env: agentEnv({ CODEX_EXEC_SERVER_URL: more.url ? more.url(gate.url) : gate.url, ...more.env }),
        // Codex asks ORCA nothing in this mode; were it to, nothing here would allow it.
        permissions: { default: "ask", rules: [] },
      }),
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });
    return session;
  }

  const recorded = (method: string, outcome: CodexExecGateRecord["outcome"]) =>
    records.filter((r) => r.method === method && r.outcome === outcome);
  const told = (pattern: RegExp) => model.outputs.some((o) => pattern.test(o));

  const ALLOW_MARK = { match: { kind: "execute", titlePattern: "^echo orca-1026 >> " }, decision: "allow" } as const;
  const typing: Step[] = [
    { tool: "exec_command", args: { cmd: "cat > typed.txt", tty: true, yield_time_ms: 500 } },
    { tool: "write_stdin", args: { session_id: "$SID", chars: "typed-1026\n\u0004", yield_time_ms: 500 } },
  ];
  const ALLOW_CAT = { match: { kind: "execute", titlePattern: "^cat > typed\\.txt$" }, decision: "allow" } as const;

  /* --------------------------------- the runs --------------------------------- */

  it("puts the image pinned for the adapter behind the gate", async () => {
    const pkg = JSON.parse(await readFile(join(ADAPTER!, "..", "..", "package.json"), "utf8")) as { version: string };
    const pair = CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === pkg.version);
    const digest = createHash("sha256")
      .update(await readFile(RUNTIME))
      .digest("hex");
    expect(digest).toBe(pair?.images[`${process.platform}-${process.arch}`]);
  });

  it("runs a command ORCA allows and not one a rule denies or the policy asks about", async () => {
    const s = await gated({
      rules: [ALLOW_MARK, { match: { kind: "execute", titlePattern: "^echo denied" }, decision: "deny" }],
    });
    await gate!.initialized(30_000);
    await s.prompt(
      script(
        shell("echo orca-1026 >> allowed.txt"),
        shell("echo denied >> denied.txt"),
        shell("echo asked >> asked.txt"),
      ),
    );
    expect(await exists("allowed.txt")).toBe("orca-1026\n");
    expect(await exists("denied.txt")).toBeUndefined();
    expect(await exists("asked.txt")).toBeUndefined();
    expect(asks).toEqual([]);
    // The model is told it was ORCA, in ORCA's words.
    expect(told(/Denied by ORCA: ORCA's permission policy/)).toBe(true);
    expect(told(/Blocked by ORCA: its policy asks a person first/)).toBe(true);
    // Each decision is the gate's own record of that request, tied to the model's call.
    const [allowed] = recorded("process/start", "forwarded");
    expect(allowed).toMatchObject({
      basis: "policy",
      subject: {
        kind: "execute",
        title: "echo orca-1026 >> allowed.txt",
        cwd: workspace,
        toolCallId: expect.stringMatching(/^call_/),
      },
    });
    expect(allowed!.subject!.argv!.at(-1)).toBe("echo orca-1026 >> allowed.txt");
    expect(recorded("process/start", "refused").map((r) => [r.basis, r.subject?.title])).toEqual([
      ["policy:deny", "echo denied >> denied.txt"],
      ["policy:ask", "echo asked >> asked.txt"],
    ]);
  }, 180_000);

  it("refuses what is typed into a running command unless a rule names it", async () => {
    const s = await gated({ rules: [ALLOW_CAT, { match: { kind: "execute" }, decision: "allow" }] });
    await s.prompt(script(...typing));
    // The command ran; what was typed into it never arrived, whatever the command rules allow.
    expect(await exists("typed.txt")).toBe("");
    const [refused] = recorded("process/write", "refused");
    expect(refused).toMatchObject({ basis: "policy:ask", subject: { bytes: 12 } });
    expect(JSON.stringify(records)).not.toContain("typed-1026");
    expect(told(/Blocked by ORCA/)).toBe(true);
  }, 180_000);

  it("passes typed input a rule names", async () => {
    const s = await gated({
      rules: [ALLOW_CAT, { match: { kind: "execute", titlePattern: '^write_stdin: "typed-1026' }, decision: "allow" }],
    });
    await s.prompt(script(...typing));
    expect(await exists("typed.txt")).toContain("typed-1026");
    expect(recorded("process/write", "forwarded")).toHaveLength(1);
  }, 180_000);

  it("applies a patch inside the workspace, and not one outside it or on ORCA's own files", async () => {
    const s = await gated();
    await s.prompt(script(patch("*** Add File: patched.txt", "+orca-1026")));
    expect(await exists("patched.txt")).toBe("orca-1026\n");
    expect(recorded("fs/writeFile", "forwarded").map((r) => r.subject?.paths)).toEqual([
      [join(workspace, "patched.txt")],
    ]);

    const outside = join(root, "outside.txt");
    await s.prompt(script(patch(`*** Add File: ${outside}`, "+x")));
    expect(await readFile(outside, "utf8").catch(() => undefined)).toBeUndefined();

    const sidecar = permissionPolicyPath(configDir);
    await s.prompt(script(patch(`*** Add File: ${sidecar}`, "+{}")));
    expect(await readFile(sidecar, "utf8").catch(() => undefined)).toBeUndefined();
    expect(recorded("fs/writeFile", "refused").map((r) => [r.basis, r.subject?.paths])).toEqual([
      ["policy:ask", [outside]],
      ["protected:deny", [sidecar]],
    ]);

    // Deleting goes through the gate too.
    await s.prompt(script(patch("*** Delete File: patched.txt")));
    expect(await exists("patched.txt")).toBeUndefined();
    expect(recorded("fs/remove", "forwarded")).toHaveLength(1);
  }, 240_000);

  it("reads an image inside the workspace and not a file outside it", async () => {
    await writeFile(join(workspace, "in.png"), PNG);
    const outside = join(root, "out.png");
    await writeFile(outside, PNG);
    const s = await gated();
    await s.prompt(script({ tool: "view_image", args: { path: join(workspace, "in.png") } }));
    await s.prompt(script({ tool: "view_image", args: { path: outside } }));
    const reads = records.filter((r) => r.method === "fs/readFile" && r.subject?.paths?.[0]?.endsWith(".png"));
    expect(reads.map((r) => [r.outcome, r.subject?.paths?.[0]])).toEqual([
      ["forwarded", join(workspace, "in.png")],
      ["refused", outside],
    ]);
    // Only the first image's bytes reached the model.
    expect(model.outputs.filter((o) => o.includes("data:image/png;base64"))).toHaveLength(1);
  }, 180_000);

  it("decides a path through a link as the file it leads to, and sends the executor that file", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(workspace, "real"));
    await symlink(outside, join(workspace, "out"));
    await symlink(join(workspace, "real"), join(workspace, "alias"));
    const s = await gated();
    // A name in the workspace that leads out of it is not a workspace file.
    await s.prompt(script(patch("*** Add File: out/new.txt", "+x")));
    expect(await readFile(join(outside, "new.txt"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(recorded("fs/writeFile", "refused").map((r) => [r.basis, r.subject?.paths, r.subject?.written])).toEqual([
      ["policy:ask", [join(outside, "new.txt")], [join(workspace, "out", "new.txt")]],
    ]);
    // One that leads to another workspace file is written, at the path with no link in it.
    await s.prompt(script(patch("*** Add File: alias/new.txt", "+orca-1026")));
    expect(await exists("real/new.txt")).toBe("orca-1026\n");
    const [written] = recorded("fs/writeFile", "forwarded");
    expect(written!.subject).toMatchObject({
      paths: [join(workspace, "real", "new.txt")],
      written: [join(workspace, "alias", "new.txt")],
      bytes: 10,
      sha256: createHash("sha256").update("orca-1026\n").digest("hex"),
    });
  }, 180_000);

  it("leaves a link swapped in after ORCA decided to the executor, which refuses it", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(workspace, "swap"));
    let swapped = false;
    const s = await gated(undefined, {
      // ORCA has decided a write of `work/swap/new.txt`. Before the executor gets it, the
      // directory becomes a link out of the workspace.
      afterDeciding: async (call, decision) => {
        if (call.method !== "fs/writeFile" || !decision.allow || swapped) return;
        swapped = true;
        await rmdir(join(workspace, "swap"));
        await symlink(outside, join(workspace, "swap"));
      },
    });
    await s.prompt(script(patch("*** Add File: swap/new.txt", "+x")));
    expect(swapped).toBe(true);
    // ORCA allowed the workspace file and passed that path on; the executor would not follow the link.
    expect(recorded("fs/writeFile", "forwarded").map((r) => r.subject?.paths)).toEqual([
      [join(workspace, "swap", "new.txt")],
    ]);
    expect(await readFile(join(outside, "new.txt"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(told(/Failed to write file/)).toBe(true);
    // Asked again, the name now leads outside, and that is what ORCA decides.
    await s.prompt(script(patch("*** Add File: swap/again.txt", "+x")));
    expect(await readFile(join(outside, "again.txt"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(recorded("fs/writeFile", "refused").map((r) => [r.basis, r.subject?.paths])).toEqual([
      ["policy:ask", [join(outside, "again.txt")]],
    ]);
  }, 180_000);

  it("starts a command in the directory ORCA decided, whatever its name leads to by then", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(workspace, "sub"));
    let swapped = false;
    const s = await gated(
      { rules: [{ match: { kind: "execute", titlePattern: "^pwd > where\\.txt$" }, decision: "allow" }] },
      {
        afterDeciding: async (call, decision) => {
          if (call.method !== "process/start" || !decision.allow || swapped) return;
          swapped = true;
          await rename(join(workspace, "sub"), join(workspace, "moved"));
          await symlink(outside, join(workspace, "sub"));
        },
      },
    );
    await s.prompt(script({ tool: "exec_command", args: { cmd: "pwd > where.txt", workdir: join(workspace, "sub") } }));
    expect(swapped).toBe(true);
    // The command ran in the directory that was decided, now under its new name, not where
    // the old name leads.
    expect(await exists("moved/where.txt")).toBe(`${join(workspace, "moved")}\n`);
    expect(await readFile(join(outside, "where.txt"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(recorded("process/start", "forwarded")[0]!.subject).toMatchObject({ cwd: join(workspace, "sub") });
  }, 180_000);

  it("passes Codex's own sandbox on with the directory ORCA decided, and a command runs inside both", async () => {
    // Codex's workspace-write mode, the one a session is in unless a person chooses another.
    // Codex then names a sandbox in each request, and the executor applies it.
    const beyond = join(homedir(), `.orca-1026-sandbox-${randomUUID()}`);
    const cmd = `pwd > where.txt; echo x > ${beyond}; true`;
    try {
      const s = await gated(
        { rules: [{ match: { kind: "execute" }, decision: "allow" }] },
        {
          env: {
            CODEX_CONFIG: JSON.stringify(codexConfig({ sandbox_mode: "workspace-write" })),
            INITIAL_AGENT_MODE: "agent",
          },
        },
      );
      await s.prompt(script(shell(cmd), patch("*** Add File: patched.txt", "+orca-1026")));

      // What the executor was given: the sandbox Codex named, and the directory ORCA holds open.
      const starts = passed
        .map((m) => JSON.parse(m) as { method?: string; params?: Record<string, unknown> })
        .filter((m) => m.method === "process/start");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.params!["cwd"]).toMatch(/^file:\/\/\/proc\/\d+\/fd\/\d+$/);
      expect(starts[0]!.params!["sandbox"]).toMatchObject({ permissions: { type: "managed" } });
      expect(recorded("process/start", "forwarded")[0]!.subject).toMatchObject({ cwd: workspace });

      // Nothing was written beyond what the sandbox allows, whether or not it could start here.
      expect(await readFile(beyond, "utf8").catch(() => undefined)).toBeUndefined();
      const where = await exists("where.txt");
      if (where === undefined) {
        // A machine that cannot start Codex's sandbox runs nothing. It does not run unsandboxed.
        expect(told(/sandbox|denied|not permitted|failed/i)).toBe(true);
        return;
      }
      expect(where).toBe(`${workspace}\n`);
      expect(told(/Read-only file system|Permission denied|Operation not permitted/)).toBe(true);
      // A patch is written through the same sandbox, by the path ORCA decided.
      expect(await exists("patched.txt")).toBe("orca-1026\n");
      const writes = passed
        .map((m) => JSON.parse(m) as { method?: string; params?: Record<string, unknown> })
        .filter((m) => m.method === "fs/writeFile");
      expect(writes.at(-1)!.params).toMatchObject({
        path: `file://${join(workspace, "patched.txt")}`,
        followSymlinks: false,
        sandbox: { permissions: { type: "managed" } },
      });
    } finally {
      await rm(beyond, { force: true });
    }
  }, 180_000);

  it("holds the pinned executor to a path with no link in it, for every file request it passes", async () => {
    // The gate is given a binder that resolves nothing, which is what a link swapped in at the
    // worst moment amounts to: every path below reaches the executor as written. What the
    // executor then does with a link is the contract the gate relies on, so it is pinned here.
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await writeFile(join(workspace, "plain.txt"), "plain");
    await symlink(outside, join(workspace, "dir-link"));
    await symlink(join(outside, "secret.txt"), join(workspace, "file-link"));
    gate = await openCodexExecGate({
      decide: () => Promise.resolve({ allow: true, basis: "test" }),
      onRecord: (record) => records.push(record),
      binder: { ...codexExecGateBinder(), target: (path) => path, entry: (path) => path },
    });
    gate.admit(startExecutor);
    const ws = new WebSocket(gate.url);
    await once(ws, "open");
    const waiting = new Map<number, (answer: Record<string, unknown>) => void>();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const id = message["id"];
      if (typeof id !== "number" || message["method"] !== undefined) return;
      const answered = waiting.get(id);
      if (typeof answered === "function") answered(message);
    });
    let next = 0;
    const call = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    try {
      expect((await call("initialize", { clientName: "orca-1026" }))["result"]).toBeDefined();
      ws.send(JSON.stringify({ method: "initialized" }));
      const uri = (...parts: string[]) => `file://${join(workspace, ...parts)}`;
      const data = Buffer.from("written").toString("base64");
      // With no link in the path, each request does what it says.
      expect((await call("fs/readFile", { path: uri("plain.txt") }))["result"]).toEqual({
        dataBase64: Buffer.from("plain").toString("base64"),
      });
      expect((await call("fs/getMetadata", { path: uri("plain.txt") }))["result"]).toMatchObject({ isFile: true });
      expect((await call("fs/createDirectory", { path: uri("made") }))["result"]).toEqual({});
      expect((await call("fs/writeFile", { path: uri("made", "new.txt"), dataBase64: data }))["result"]).toEqual({});
      expect(await exists("made/new.txt")).toBe("written");
      expect((await call("fs/remove", { path: uri("made", "new.txt") }))["result"]).toEqual({});
      expect(await exists("made/new.txt")).toBeUndefined();
      // With a link at any step, each one is refused by the executor and nothing is touched.
      for (const [method, params] of [
        ["fs/readFile", { path: uri("dir-link", "secret.txt") }],
        ["fs/readFile", { path: uri("file-link") }],
        ["fs/getMetadata", { path: uri("dir-link", "secret.txt") }],
        ["fs/getMetadata", { path: uri("file-link") }],
        ["fs/writeFile", { path: uri("dir-link", "new.txt"), dataBase64: data }],
        ["fs/writeFile", { path: uri("file-link"), dataBase64: data }],
        ["fs/createDirectory", { path: uri("dir-link", "made"), recursive: true }],
        ["fs/remove", { path: uri("dir-link", "secret.txt") }],
        ["fs/remove", { path: uri("file-link") }],
      ] as const) {
        const answer = await call(method, params);
        expect(answer["error"], `${method} ${params.path}`).toBeDefined();
        expect(JSON.stringify(answer["error"])).not.toContain("Blocked by ORCA");
      }
      expect(records.filter((r) => r.outcome === "refused")).toEqual([]);
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
      expect(await readFile(join(outside, "new.txt"), "utf8").catch(() => undefined)).toBeUndefined();
      expect(await readFile(join(outside, "made"), "utf8").catch((e: { code?: string }) => e.code)).toBe("ENOENT");
      expect(await readFile(join(workspace, "file-link"), "utf8")).toBe("secret");
      // One directory at a time: a create is never passed on as a recursive one.
      const deep = await call("fs/createDirectory", { path: uri("a", "b"), recursive: true });
      expect(deep["error"]).toBeDefined();
      expect(await exists("a")).toBeUndefined();
    } finally {
      ws.close();
    }
  }, 60_000);

  it("refuses the file requests it cannot hold to one file, and Codex carries on without them", async () => {
    await mkdir(join(workspace, ".agents", "skills", "demo"), { recursive: true });
    await writeFile(
      join(workspace, ".agents", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: a demo skill\n---\nNothing.\n",
    );
    const s = await gated({ rules: [ALLOW_MARK] });
    await s.prompt(script(shell("echo orca-1026 >> allowed.txt")));
    expect(await exists("allowed.txt")).toBe("orca-1026\n");
    const unbound = /^fs\/(open|readBlock|writeBlock|close|copy|readDirectory|walk|canonicalize|watchMissing)$/;
    expect(records.filter((r) => unbound.test(r.method) && r.outcome === "forwarded")).toEqual([]);
    // Codex 0.171 asks for these two to load a workspace's skills, and so does not load them
    // here. Pinned so a change is noticed.
    expect(new Set(records.filter((r) => unbound.test(r.method)).map((r) => r.method))).toEqual(
      new Set(["fs/canonicalize", "fs/walk"]),
    );
    expect(records.filter((r) => unbound.test(r.method)).every((r) => r.outcome === "refused")).toBe(true);
  }, 180_000);

  it("adds a file in one new directory, and not in a chain of new ones", async () => {
    const s = await gated();
    await s.prompt(script(patch("*** Add File: one/new.txt", "+orca-1026")));
    expect(await exists("one/new.txt")).toBe("orca-1026\n");
    expect(recorded("fs/createDirectory", "forwarded").map((r) => r.subject?.paths)).toEqual([
      [join(workspace, "one")],
    ]);
    // A recursive create would add directories ORCA never decided, so it is passed on as a
    // create of the one directory, which the executor refuses while its parent is missing.
    await s.prompt(script(patch("*** Add File: two/deep/new.txt", "+x")));
    expect(await exists("two")).toBeUndefined();
    expect(told(/Failed to create parent directories/)).toBe(true);
    // With no skills directory to load, Codex asks to be told when one appears. That is refused too.
    expect(recorded("fs/watchMissing", "refused").length).toBeGreaterThan(0);
    expect(recorded("fs/watchMissing", "forwarded")).toEqual([]);
  }, 180_000);

  it("refuses the very next call once the grant is revoked", async () => {
    const s = await gated({ rules: [ALLOW_MARK] });
    await s.prompt(script(shell("echo orca-1026 >> revoked.txt")));
    expect(await exists("revoked.txt")).toBe("orca-1026\n");
    const doc = await readPermissionPolicyFile(permissionPolicyPath(configDir));
    await replacePermissionPolicyFile(permissionPolicyPath(configDir), {
      ...doc,
      agents: { codex: { rules: [{ match: { kind: "execute", command: "echo" }, decision: "ask" }] } },
    });
    await s.prompt(script(shell("echo orca-1026 >> revoked.txt")));
    expect(await exists("revoked.txt")).toBe("orca-1026\n");
    expect(recorded("process/start", "refused")).toHaveLength(1);
    expect(asks).toEqual([]);
  }, 180_000);

  it("starts the executor's own shell, not one at a path the model names", async () => {
    // Codex 0.171 does not use the model's `shell` with a remote executor. Were it to, the
    // gate would decide the whole command line, since only a system shell's script is read
    // as the command (the unit tests); this pins what the installed Codex sends.
    const fake = join(workspace, "bash");
    await writeFile(fake, "#!/bin/sh\necho ran >> fake-shell.txt\n", { mode: 0o755 });
    const s = await gated({ rules: [ALLOW_MARK] });
    await s.prompt(script({ tool: "exec_command", args: { cmd: "echo orca-1026 >> x.txt", shell: fake } }));
    expect(await exists("fake-shell.txt")).toBeUndefined();
    const starts = records.filter((r) => r.method === "process/start");
    expect(starts.length).toBeGreaterThan(0);
    for (const r of starts) expect(r.subject?.argv?.[0]).not.toBe(fake);
  }, 180_000);

  it("fails the call when ORCA cannot decide it", async () => {
    let mode: "throw" | "hang" = "throw";
    const s = await gated(undefined, {
      decide: (call) => {
        if (call.check === "protected" || call.toolCall.kind !== "execute")
          return Promise.resolve({ allow: true, basis: "test" });
        if (mode === "throw") return Promise.reject(new Error("the policy could not be read"));
        return new Promise<CodexExecGateDecision>(() => undefined);
      },
    });
    await s.prompt(script(shell("echo ran >> threw.txt")));
    expect(await exists("threw.txt")).toBeUndefined();
    expect(told(/Blocked by ORCA: ORCA could not check this call/)).toBe(true);
    mode = "hang";
    await s.prompt(script(shell("echo ran >> hung.txt")));
    expect(await exists("hung.txt")).toBeUndefined();
    expect(told(/Blocked by ORCA: ORCA could not decide this call in time/)).toBe(true);
    expect(recorded("process/start", "forwarded")).toHaveLength(0);
  }, 180_000);

  it("decides every later call again when the executor behind the gate is killed", async () => {
    const s = await gated({
      rules: [
        { match: { kind: "execute", titlePattern: "^echo ran >> (before|after)\\.txt$" }, decision: "allow" },
        { match: { kind: "execute", titlePattern: "^echo denied" }, decision: "deny" },
      ],
    });
    await s.prompt(script(shell("echo ran >> before.txt")));
    expect(await exists("before.txt")).toBe("ran\n");
    expect(executors).toHaveLength(1);
    process.kill(executors[0]!, "SIGKILL");
    await s.prompt(script(shell("echo ran >> after.txt"), shell("echo denied >> denied.txt")));
    // Codex connects again. It reaches a new executor only through the gate, which starts one
    // and decides each request as before: nothing ran on the strength of the old connection.
    expect(
      records.some((r) => r.method === "connection" && r.outcome === "closed" && /SIGKILL/.test(r.reason ?? "")),
    ).toBe(true);
    expect(executors.length).toBeGreaterThan(1);
    expect(await exists("after.txt")).toBe("ran\n");
    expect(await exists("denied.txt")).toBeUndefined();
    const later = records.filter((r) => r.method === "process/start" && r.connection > 1);
    expect(later.map((r) => [r.outcome, r.basis, r.subject?.title])).toEqual([
      ["forwarded", "policy", "echo ran >> after.txt"],
      ["refused", "policy:deny", "echo denied >> denied.txt"],
    ]);
  }, 180_000);

  it("fails every later call when the gate is closed", async () => {
    const s = await gated({ default: "allow", rules: [] });
    await s.prompt(script(shell("echo ran >> before.txt")));
    expect(await exists("before.txt")).toBe("ran\n");
    await gate!.close();
    await s.prompt(
      script(shell("echo ran >> after.txt"), patch("*** Add File: after-patch.txt", "+x"), {
        tool: "view_image",
        args: { path: join(workspace, "before.txt") },
      }),
    );
    expect(await exists("after.txt")).toBeUndefined();
    expect(await exists("after-patch.txt")).toBeUndefined();
    // Each call failed for want of an executor, and said so.
    expect(model.outputs).toHaveLength(4);
    expect(model.outputs[1]).toMatch(/exec-server connection attempt failed/);
    expect(model.outputs[2]).toMatch(/Failed to write file/);
    expect(model.outputs[3]).toMatch(/exec-server connection attempt failed/);
  }, 180_000);

  it("runs nothing when ORCA never admitted the runtime", async () => {
    const s = await gated({ default: "allow", rules: [] }, { admit: false });
    await s.prompt(script(shell("echo ran >> unadmitted.txt"), patch("*** Add File: unadmitted-patch.txt", "+x")));
    expect(await exists("unadmitted.txt")).toBeUndefined();
    expect(await exists("unadmitted-patch.txt")).toBeUndefined();
    expect(executors).toEqual([]);
    expect(records.some((r) => r.outcome === "forwarded")).toBe(false);
  }, 180_000);

  it("runs nothing when the agent's connection does not carry the session's token", async () => {
    const s = await gated(
      { default: "allow", rules: [] },
      { url: (url) => `${url.slice(0, url.lastIndexOf("/"))}/guessed` },
    );
    await s.prompt(script(shell("echo ran >> wrong-token.txt")));
    expect(await exists("wrong-token.txt")).toBeUndefined();
    expect(executors).toEqual([]);
    expect(records.every((r) => r.method === "connection" && r.outcome === "refused")).toBe(true);
  }, 180_000);

  it("does not start a local MCP server, which would run outside the gate", async () => {
    const server = join(root, "mcp-touch.mjs");
    const started = join(root, "mcp-started.txt");
    await writeFile(
      server,
      `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "touch", version: "1" } } });
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", description: "write a file", inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } }] } });
  else if (m.method === "tools/call") { writeFileSync(m.params.arguments.file, "mcp"); out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } }); }
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
      "utf8",
    );
    model.tools.clear();
    const s = await gated(
      { default: "allow", rules: [] },
      {
        env: {
          CODEX_CONFIG: JSON.stringify(
            codexConfig({
              model: "gpt-5",
              mcp_servers: { t: { command: process.execPath, args: [server], default_tools_approval_mode: "approve" } },
            }),
          ),
        },
      },
    );
    await s.prompt(script({ tool: "touch", namespace: "mcp__t", args: { file: join(workspace, "mcp.txt") } }));
    expect(await exists("mcp.txt")).toBeUndefined();
    expect(await readFile(started, "utf8").catch(() => undefined)).toBeUndefined();
    expect([...model.tools].filter((t) => t.includes("touch") || t.startsWith("mcp__"))).toEqual([]);
  }, 180_000);
});
