/**
 * Delegating a step to another daemon (#883), end to end: two real `orca serve` processes
 * from the two-daemon fixture (#885 phase 1). Daemon `a` runs a workflow whose step's agent is
 * `type: orca-daemon`; daemon `b` runs the delegated work as its own run.
 *
 * - Over SSH (where sshd is installed): `a` reaches `b` through a throwaway loopback sshd with
 *   the shared `SshTunnel`, exactly as it would a remote machine, with a credential `b` issued.
 * - Over a direct stream: the session against `b` through a proxy the test controls, for the
 *   reattach, lost-answer, cancel-before-commit and restart cases that a real tunnel cannot be
 *   made to hit on cue.
 *
 * Needs `pnpm run build` (it runs the compiled CLI); CI builds before it tests.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, isOrcaError } from "@orca/core";
import { LocalHost } from "@orca/agents";
import {
  delegationKey,
  DelegationReceipts,
  openDaemonSession,
  ReceiptConflict,
  type DelegationTransport,
  type OpenDaemonSessionOptions,
} from "@orca/daemon";
import {
  CLI_ENTRY,
  loopbackSshd,
  startTestDaemon,
  type LoopbackSshd,
  type TestDaemon,
} from "@orca/testing/two-daemons";
import { repoRoot } from "@orca/testing/child-bundle";

const SCRIPTED = join(repoRoot, "packages", "testing", "dist", "scripted-agent", "main.js");
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** The remote side: a daemon with a scripted agent and the workflows it runs for a parent. */
async function remoteDaemon(): Promise<TestDaemon> {
  const wf = await mkdtemp(join(tmpdir(), "orca-883-remote-wf-"));
  dirs.push(wf);
  writeFileSync(
    join(wf, "remote-task.yaml"),
    `
id: remote-task
name: remote task
start: s
nodes:
  s: { type: start }
  work:
    type: agent
    agent: { id: scripted }
    prompt: "{{ vars.prompt }}"
    produces:
      - { kind: report, name: report, path: "out/report.md" }
  done: { type: end }
edges:
  - { from: s, to: work }
  - { from: work, to: done }
`,
  );
  writeFileSync(
    join(wf, "remote-gated.yaml"),
    `
id: remote-gated
name: remote gated
start: s
nodes:
  s: { type: start }
  ask: { type: gate, question: "Ship the report?", options: [ship, hold] }
  work:
    type: agent
    agent: { id: scripted }
    prompt: "{{ vars.prompt }}"
    produces:
      - { kind: report, name: report, path: "out/report.md" }
  held: { type: end, outcome: failure }
  done: { type: end }
edges:
  - { from: s, to: ask }
  - { from: ask, to: work, when: "choice == 'ship'" }
  - { from: ask, to: held, when: "choice == 'hold'" }
  - { from: work, to: done }
`,
  );
  const playbook = {
    kinds: { report: [{ data: { status: "done" }, body: "Remote report for: {prompt}" }] },
  };
  const agent = {
    id: "scripted",
    command: process.execPath,
    args: [SCRIPTED],
    env: { ORCA_PLAYBOOK_JSON: JSON.stringify(playbook) },
    permissions: { default: "allow" },
  };
  return startTestDaemon({
    name: "remote",
    config: JSON.stringify({ version: 1, workflows: [join(wf, "*.yaml")], templates: [], agents: [agent] }),
  });
}

/** A credential the remote issues for the parent daemon, with `orca auth issue` there. */
function issueCredential(remote: TestDaemon, principal: string): string {
  const out = spawnSync(process.execPath, [CLI_ENTRY, "auth", "issue", principal, "--preset", "client", "--json"], {
    cwd: remote.dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: join(remote.dir, "..", "home") },
  });
  if (out.status !== 0) throw new Error(`auth issue failed: ${out.stderr}`);
  return (JSON.parse(out.stdout) as { token: string }).token;
}

async function call(daemon: TestDaemon, method: string, params: unknown): Promise<Record<string, unknown>> {
  const answer = await daemon.call(method, params);
  if (!answer.ok) throw new Error(`${method}: ${answer.error.code}: ${answer.error.message}`);
  return answer.result as Record<string, unknown>;
}

type RunView = { status: string; error?: unknown };
async function runOf(
  daemon: TestDaemon,
  runId: string,
): Promise<{ run: RunView; artifacts: { name: string; id: string }[] }> {
  return (await call(daemon, "runs.get", { runId })) as never;
}

/** Start a run on a daemon without waiting for it to park or finish, as the app does. */
async function admit(daemon: TestDaemon, workflowId: string, vars: Record<string, unknown>): Promise<string> {
  const receipt = await call(daemon, "runs.admit", { workflowId, vars, idempotencyKey: randomUUID() });
  if (receipt.state !== "accepted") throw new Error(`not admitted: ${JSON.stringify(receipt)}`);
  return receipt.runId as string;
}

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    // A read that races a write to the run's log is refused with RUN_STATE; read again.
    const value = await read().catch((error: unknown) => {
      if (String(error).includes("RUN_STATE")) return undefined;
      throw error;
    });
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Run the CLI in a daemon's directory. */
function cli(daemon: TestDaemon, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd: daemon.dir, encoding: "utf8", env: process.env });
}

const finished = (daemon: TestDaemon, runId: string) =>
  until(`run ${runId} to finish`, async () => {
    const { run } = await runOf(daemon, runId);
    return ["succeeded", "failed", "cancelled"].includes(run.status) ? run : undefined;
  });

describe("delegation over SSH (#883)", () => {
  let sshd: LoopbackSshd | undefined;
  let remote: TestDaemon;
  let parent: TestDaemon;
  let parentWorkflows: string;

  beforeAll(async () => {
    sshd = await loopbackSshd();
    if (!sshd) return;
    remote = await remoteDaemon();
    parentWorkflows = await mkdtemp(join(tmpdir(), "orca-883-parent-wf-"));
    dirs.push(parentWorkflows);
    for (const [id, workflow] of [
      ["delegate", "remote"],
      ["delegate-gated", "remote-gated"],
    ] as const)
      writeFileSync(
        join(parentWorkflows, `${id}.yaml`),
        `
id: ${id}
name: ${id}
start: s
nodes:
  s: { type: start }
  hand:
    type: agent
    agent: { id: ${workflow} }
    prompt: "Summarize the weather for {{ vars.city }}"
    produces:
      - { kind: report, name: report, path: "delegated/report.md" }
  done: { type: end }
edges:
  - { from: s, to: hand }
  - { from: hand, to: done }
`,
      );
    const remoteSpec = {
      id: "remote-box",
      name: "Remote box",
      destination: `${userInfo().username}@127.0.0.1`,
      sshPort: sshd.port,
      identityFile: sshd.identity,
      remotePort: remote.port,
    };
    parent = await startTestDaemon({
      name: "parent",
      config: JSON.stringify({
        version: 1,
        workflows: [join(parentWorkflows, "*.yaml")],
        templates: [],
        remotes: [remoteSpec],
        agents: [
          { id: "remote", type: "orca-daemon", profile: "remote-box", workflow: "remote-task" },
          { id: "remote-gated", type: "orca-daemon", profile: "remote-box", workflow: "remote-gated" },
        ],
      }),
    });
    // The one-time setup: the remote issues the parent a credential, saved beside its config.
    const token = issueCredential(remote, "parent-daemon");
    mkdirSync(join(parent.dir, "auth", "remotes"), { recursive: true });
    writeFileSync(join(parent.dir, "auth", "remotes", "remote-box.token"), `${token}\n`, { mode: 0o600 });
  }, 90_000);

  const enrollmentPath = () => join(parent.dir, "auth", "remotes", "remote-box.json");
  const knownHostsPath = () => join(parent.dir, "auth", "remotes", "remote-box.known_hosts");

  afterAll(async () => {
    await parent?.close();
    await remote?.close();
    await sshd?.close();
  });

  it("refuses a remote that was never enrolled, before connecting to it", async (ctx) => {
    if (!sshd) return ctx.skip();
    const run = await finished(parent, await admit(parent, "delegate", { city: "Nowhere" }));
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "DELEGATION_REFUSED", message: expect.stringContaining("orca remote enroll remote-box") },
    });
    // No host key was trusted on first use by the delegation.
    await expect(readFile(knownHostsPath(), "utf8")).rejects.toThrow();
    expect(((await call(remote, "runs.list", {})).runs as unknown[]).length).toBe(0);
  }, 120_000);

  it("refuses to enroll a host whose key nobody vouched for, before sending the credential", async (ctx) => {
    if (!sshd) return ctx.skip();
    const auditLines = async () =>
      (await readFile(join(remote.dir, "auth", "audit.jsonl"), "utf8").catch(() => "")).length;
    const before = await auditLines();
    // No pin and no fingerprint: refused before ssh starts.
    const blind = cli(parent, ["remote", "enroll", "remote-box"]);
    expect(blind.status).not.toBe(0);
    expect(blind.stderr).toContain("--host-key");
    // A fingerprint the host's key does not have: refused once ssh shows the key, before HTTP.
    const wrong = cli(parent, ["remote", "enroll", "remote-box", "--host-key", `SHA256:${"A".repeat(43)}`]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain("not a fingerprint you gave");
    await expect(readFile(knownHostsPath(), "utf8")).rejects.toThrow();
    await expect(readFile(enrollmentPath(), "utf8")).rejects.toThrow();
    // The remote daemon never saw a request (its audit log did not grow).
    expect(await auditLines()).toBe(before);
  }, 120_000);

  it("enrolls the remote: pins its host keys and records its workspace and principal", async (ctx) => {
    if (!sshd) return ctx.skip();
    const out = cli(parent, ["remote", "enroll", "remote-box", "--json", "--host-key", sshd.hostKeyFingerprint]);
    expect(out.status, out.stderr).toBe(0);
    const record = JSON.parse(out.stdout) as Record<string, string>;
    const discovered = (await call(remote, "operator.discover", {})).target as { workspaceId: string };
    expect(record).toMatchObject({ profile: "remote-box", workspaceId: discovered.workspaceId });
    expect(record.principalId).toBeTruthy();
    // The record names the credential by id only.
    const token = await readFile(join(parent.dir, "auth", "remotes", "remote-box.token"), "utf8");
    expect(record.credentialId).toBe(token.trim().split(".")[1]);
    expect(JSON.stringify(record)).not.toContain(token.trim().split(".")[2]);
    await expect(readFile(knownHostsPath(), "utf8")).resolves.toMatch(/ssh-ed25519/);
  }, 120_000);

  it("runs a parent step as a run on the remote daemon and brings its artifact back", async (ctx) => {
    if (!sshd) return ctx.skip();
    const runId = await admit(parent, "delegate", { city: "Lisbon" });
    const run = await finished(parent, runId);
    expect(run).toMatchObject({ status: "succeeded" });

    // The parent collected the remote's artifact at its own deliverable.
    const { artifacts } = await runOf(parent, runId);
    const report = artifacts.find((a) => a.name === "report");
    expect(report).toBeDefined();
    const text = (await call(parent, "artifacts.get", { artifactId: report!.id })).text as string;
    expect(text).toContain("Remote report for: Summarize the weather for Lisbon");

    // The work is the remote daemon's own run, in its own run list, owned by the parent's principal.
    const remoteRuns = (await call(remote, "runs.list", {})).runs as {
      id: string;
      workflowId: string;
      status: string;
    }[];
    const delegated = remoteRuns.filter((r) => r.workflowId === "remote-task");
    expect(delegated).toHaveLength(1);
    expect(delegated[0]!.status).toBe("succeeded");
    // The remote's audit names the parent's principal on the admission.
    const audit = (await readFile(join(remote.dir, "auth", "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      audit.some((r) => JSON.stringify(r).includes("parent-daemon") && JSON.stringify(r).includes("runs.admit")),
    ).toBe(true);
  }, 120_000);

  it("forwards a remote gate to the parent and sends the parent's answer back", async (ctx) => {
    if (!sshd) return ctx.skip();
    const runId = await admit(parent, "delegate-gated", { city: "Oslo" });

    const input = await until("the forwarded question", async () => {
      const open = (await call(parent, "inputs.list", { runId })).inputs as {
        id: string;
        question: string;
        options: { id: string }[];
        live?: { target: unknown };
      }[];
      return open.find((i) => i.question.includes("Ship the report?"));
    });
    expect(input.options.map((o) => o.id)).toEqual(["ship", "hold"]);
    await call(parent, "inputs.answer", {
      requestId: input.id,
      runId,
      optionId: "ship",
      ...(input.live ? { live: input.live.target } : {}),
    });
    expect(await finished(parent, runId)).toMatchObject({ status: "succeeded" });
    const remoteRuns = (await call(remote, "runs.list", {})).runs as { workflowId: string; status: string }[];
    expect(remoteRuns.filter((r) => r.workflowId === "remote-gated")).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
  }, 120_000);

  it("cancels the remote run when the parent run is cancelled", async (ctx) => {
    if (!sshd) return ctx.skip();
    const before = ((await call(remote, "runs.list", {})).runs as unknown[]).length;
    const runId = await admit(parent, "delegate-gated", { city: "Rome" });
    await until("the forwarded question", async () => {
      const open = (await call(parent, "inputs.list", { runId })).inputs as unknown[];
      return open.length ? open : undefined;
    });
    const remoteRun = await until("the remote run", async () => {
      const runs = (await call(remote, "runs.list", {})).runs as { id: string; status: string }[];
      return runs.length > before ? runs.find((r) => r.status !== "succeeded") : undefined;
    });
    await call(parent, "runs.cancel", { runId, reason: "test" });
    expect(await finished(parent, runId)).toMatchObject({ status: "cancelled" });
    expect(await finished(remote, remoteRun.id)).toMatchObject({ status: "cancelled" });
  }, 120_000);

  it("sends no bearer with a credential other than the enrolled one", async (ctx) => {
    if (!sshd) return ctx.skip();
    const file = join(parent.dir, "auth", "remotes", "remote-box.token");
    const good = await readFile(file, "utf8");
    const before = ((await call(remote, "runs.list", {})).runs as unknown[]).length;
    // A well-formed token, but not the enrolled credential.
    writeFileSync(file, `orca1.AAAAAAAAAAAA.${"A".repeat(43)}\n`, { mode: 0o600 });
    try {
      const run = await finished(parent, await admit(parent, "delegate", { city: "Nowhere" }));
      expect(run).toMatchObject({
        status: "failed",
        error: { code: "DELEGATION_REFUSED", message: expect.stringContaining("not the one it was enrolled with") },
      });
    } finally {
      writeFileSync(file, good, { mode: 0o600 });
    }
    expect(((await call(remote, "runs.list", {})).runs as unknown[]).length).toBe(before);
  }, 120_000);

  it("refuses a host whose keys are not the enrolled ones", async (ctx) => {
    if (!sshd) return ctx.skip();
    const file = enrollmentPath();
    const good = await readFile(file, "utf8");
    const before = ((await call(remote, "runs.list", {})).runs as unknown[]).length;
    const record = JSON.parse(good) as { keys: string };
    writeFileSync(file, JSON.stringify({ ...record, keys: `${record.keys}-other` }), { mode: 0o600 });
    try {
      const run = await finished(parent, await admit(parent, "delegate", { city: "Elsewhere" }));
      expect(run).toMatchObject({ status: "failed", error: { code: "DELEGATION_REFUSED" } });
    } finally {
      writeFileSync(file, good, { mode: 0o600 });
    }
    expect(((await call(remote, "runs.list", {})).runs as unknown[]).length).toBe(before);
  }, 120_000);

  it("fails the step with a typed refusal once the remote revokes the credential", async (ctx) => {
    if (!sshd) return ctx.skip();
    const { credentialId } = JSON.parse(await readFile(enrollmentPath(), "utf8")) as { credentialId: string };
    const revoked = cli(remote, ["auth", "revoke", credentialId]);
    expect(revoked.status, revoked.stderr).toBe(0);
    const run = await finished(parent, await admit(parent, "delegate", { city: "Nowhere" }));
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "DELEGATION_REFUSED", message: expect.stringContaining("refused this daemon's credential") },
    });
  }, 120_000);
});

describe("delegation through a proxy the test controls (#883)", () => {
  let remote: TestDaemon;
  let token: string;
  let work: string;
  let binding: OpenDaemonSessionOptions["binding"];

  beforeAll(async () => {
    remote = await remoteDaemon();
    token = issueCredential(remote, "parent-direct");
    work = await mkdtemp(join(tmpdir(), "orca-883-work-"));
    dirs.push(work);
    const discovery = (await remote.call("operator.discover", {}, token)) as {
      ok: true;
      result: { principalId: string; target: { workspaceId: string } };
    };
    binding = {
      principalId: discovery.result.principalId,
      workspaceId: discovery.result.target.workspaceId,
      enrollment: "enrollment-1",
      target: "target-1",
    };
  }, 60_000);
  afterAll(async () => {
    await remote?.close();
  });

  /**
   * A TCP proxy in front of the remote, and a transport through it. The proxy can cut every
   * stream, hold the stream that carries a given method (never forwarding it, until `release`
   * replays it to the remote on a fresh connection), drop the stream that carries a method,
   * lose the reply to a method the remote did receive, or rewrite a reply's bytes.
   */
  async function proxied() {
    const live = new Set<Socket>();
    const rules: {
      hold?: string | undefined;
      drop?: string | undefined;
      dropReply?: string | undefined;
      tamper?: { method: string; from: string; to: string } | undefined;
    } = {};
    let held: Buffer[] | undefined;
    let onHeld: (() => void) | undefined;
    const heldNow = new Promise<void>((resolve) => (onHeld = resolve));
    let onReplyDropped: (() => void) | undefined;
    const replyDropped = new Promise<void>((resolve) => (onReplyDropped = resolve));
    const state = {
      down: false,
      streams: 0,
      rules,
      /** Resolves once a stream carrying `rules.hold` was held. */
      held: heldNow,
      /** Resolves once the reply to `rules.dropReply` was lost. */
      replyDropped,
      /** Drop every open stream and refuse new ones, as a lost network would. */
      cut() {
        state.down = true;
        for (const socket of live) socket.destroy();
      },
      /** Deliver the held stream's bytes to the remote after all, as a late packet would. */
      release(): Promise<void> {
        const bytes = Buffer.concat(held ?? []);
        return new Promise((resolve, reject) => {
          const late = connect(remote.port, "127.0.0.1", () => late.end(bytes));
          late.on("data", () => undefined);
          late.on("close", () => resolve());
          late.on("error", reject);
        });
      },
    };
    const server: Server = createServer((client) => {
      live.add(client);
      const upstream = connect(remote.port, "127.0.0.1");
      const log: Buffer[] = [];
      let holding = false;
      let loseReply = false;
      let tamper: { from: string; to: string } | undefined;
      client.on("data", (chunk: Buffer) => {
        log.push(chunk);
        const text = chunk.toString("utf8");
        if (rules.drop && text.includes(`"method":"${rules.drop}"`)) {
          rules.drop = undefined;
          client.destroy();
          upstream.destroy();
          return;
        }
        if (rules.dropReply && text.includes(`"method":"${rules.dropReply}"`)) {
          rules.dropReply = undefined;
          loseReply = true;
        }
        if (rules.tamper && text.includes(`"method":"${rules.tamper.method}"`)) {
          tamper = rules.tamper;
          rules.tamper = undefined;
        }
        if (rules.hold && text.includes(`"method":"${rules.hold}"`)) {
          rules.hold = undefined;
          holding = true;
          held = log;
          onHeld?.();
        }
        if (!holding) upstream.write(chunk);
      });
      upstream.on("data", (chunk: Buffer) => {
        if (loseReply) {
          // The remote did the work; the answer never arrives.
          loseReply = false;
          client.destroy();
          upstream.destroy();
          onReplyDropped?.();
          return;
        }
        if (tamper) {
          const text = chunk.toString("latin1");
          if (text.includes(tamper.from)) {
            chunk = Buffer.from(text.replace(tamper.from, tamper.to), "latin1");
            tamper = undefined;
          }
        }
        client.write(chunk);
      });
      upstream.on("close", () => client.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => {
        live.delete(client);
        upstream.destroy();
      });
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const transport = (): DelegationTransport => ({
      connect: () => {
        if (state.down) throw new Error("tunnel down");
        state.streams++;
        return connect(port, "127.0.0.1");
      },
      failed: () => undefined,
      close: async () => undefined,
    });
    const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return { state, transport, close };
  }

  const agentFor = (workflow: string) =>
    AgentSpecSchema.parse({ id: "remote", type: "orca-daemon", profile: "direct", workflow });
  const host = new LocalHost({ id: "local", type: "local" });
  const turn = (
    parentRunId: string,
    path: string,
    attempt = 1,
    stepRunId = `${parentRunId}_step${attempt}`,
    delegationId = `${parentRunId}_step1`,
  ) => ({
    runId: parentRunId,
    stepRunId,
    delegationId,
    nodeId: "hand",
    attempt,
    followUp: 0,
    task: `task ${parentRunId}`,
    deliverables: [{ kind: "report", name: "report", path, required: true }],
  });
  const runsOf = async (workflowId: string) =>
    ((await call(remote, "runs.list", {})).runs as { id: string; workflowId: string; status: string }[]).filter(
      (r) => r.workflowId === workflowId,
    );

  function open(
    transport: DelegationTransport,
    receipts: DelegationReceipts,
    extra: Partial<OpenDaemonSessionOptions> = {},
  ) {
    return openDaemonSession({
      agent: agentFor("remote-task"),
      host,
      cwd: work,
      profile: "direct",
      remoteName: "direct",
      transport,
      token,
      binding,
      receipts,
      pollMs: 100,
      ...extra,
    });
  }

  it("reattaches to the same remote run after the connection drops, without a second submission", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-reattach"));
    const session = await open(proxy.transport(), receipts);
    const notes: string[] = [];
    session.onUpdate((e) => notes.push(e.summary.text ?? ""));
    const before = (await runsOf("remote-task")).length;
    const path = join(work, "reattach", "report.md");
    const running = session.prompt("ignored", { timeoutMs: 60_000, turn: turn("run_reattach", path) });
    // Drop the connection as soon as the remote run is admitted, and restore it shortly after.
    await until("admission", async () => (notes.some((n) => n.startsWith("Delegated to")) ? true : undefined));
    proxy.state.cut();
    await new Promise((r) => setTimeout(r, 600));
    proxy.state.down = false;
    await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(notes.join("")).toContain("reattaching");
    await expect(readFile(path, "utf8")).resolves.toContain("Remote report for: task run_reattach");

    // The same turn again (a retried call after a lost answer) admits nothing new.
    const again = join(work, "reattach-again", "report.md");
    await session.prompt("ignored", { timeoutMs: 60_000, turn: turn("run_reattach", again) });
    await expect(readFile(again, "utf8")).resolves.toContain("Remote report for: task run_reattach");
    // So does a later attempt of the step: the delegation's succeeded run is its result.
    const retried = join(work, "reattach-retried", "report.md");
    await session.prompt("ignored", { timeoutMs: 60_000, turn: turn("run_reattach", retried, 2) });
    await expect(readFile(retried, "utf8")).resolves.toContain("Remote report for: task run_reattach");
    expect(await runsOf("remote-task")).toHaveLength(before + 1);
    expect(receipts.read("run_reattach", "run_reattach_step1")).toMatchObject({
      state: "settled",
      outcome: "succeeded",
      generation: 0,
    });
    await session.close();
    await expect(session.terminated).resolves.toBeUndefined();
    await proxy.close();
  }, 120_000);

  it("keeps a seen terminal event until the run's result is read, across a lost reply", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-latch"));
    const session = await open(proxy.transport(), receipts);
    // The first read of the run's result is lost on the way: its stream drops mid-call.
    proxy.state.rules.drop = "runs.get";
    const path = join(work, "latch", "report.md");
    await expect(
      session.prompt("ignored", { timeoutMs: 30_000, turn: turn("run_latch", path) }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(proxy.state.rules.drop).toBeUndefined();
    await expect(readFile(path, "utf8")).resolves.toContain("Remote report for: task run_latch");
    await session.close();
    await proxy.close();
  }, 60_000);

  it("never creates work when cancelled before the admission committed, even when it arrives late", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-cancel"));
    const gated = agentFor("remote-gated");
    const session = await open(proxy.transport(), receipts, { agent: gated });
    const before = (await runsOf("remote-gated")).length;
    // The admission is held in the network: the remote never sees it while the parent waits.
    proxy.state.rules.hold = "runs.admit";
    const abort = new AbortController();
    const running = session.prompt("ignored", {
      timeoutMs: 60_000,
      signal: abort.signal,
      turn: turn("run_cancel", join(work, "cancel", "report.md")),
    });
    await proxy.state.held;
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    // Cancelling sent nothing that could admit work, and fenced the key: authoritative.
    expect(await runsOf("remote-gated")).toHaveLength(before);
    expect(receipts.read("run_cancel", "run_cancel_step1")).toMatchObject({
      state: "settled",
      outcome: "never-admitted",
    });
    await session.close();

    // The held admission arrives late after all: the fenced key admits nothing.
    await proxy.state.release();
    const { key } = receipts.read("run_cancel", "run_cancel_step1")!;
    const late = await remote.call(
      "runs.admit",
      { workflowId: "remote-gated", vars: { prompt: "task run_cancel" }, idempotencyKey: key },
      token,
    );
    expect(late.ok).toBe(false);
    expect(await runsOf("remote-gated")).toHaveLength(before);
    await proxy.close();
  }, 120_000);

  it("cancels the run an admission made when only its reply was lost", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-lost-reply"));
    const gated = agentFor("remote-gated");
    const session = await open(proxy.transport(), receipts, { agent: gated });
    const before = (await runsOf("remote-gated")).length;
    // The remote admits the run; the reply never reaches the parent, which then cancels.
    proxy.state.rules.dropReply = "runs.admit";
    const abort = new AbortController();
    const running = session.prompt("ignored", {
      timeoutMs: 60_000,
      signal: abort.signal,
      turn: turn("run_lost_reply", join(work, "lost-reply", "report.md")),
    });
    await proxy.state.replyDropped;
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    const runs = await runsOf("remote-gated");
    expect(runs).toHaveLength(before + 1);
    const made = runs.find((r) => receipts.read("run_lost_reply", "run_lost_reply_step1")?.remoteRunId === r.id);
    expect(made).toBeDefined();
    // The fence named the run instead of claiming the key; the run was cancelled and seen ended.
    expect(await finished(remote, made!.id)).toMatchObject({ status: "cancelled" });
    expect(receipts.read("run_lost_reply", "run_lost_reply_step1")).toMatchObject({
      state: "settled",
      outcome: "cancelled",
      remoteRunId: made!.id,
    });
    await session.close();
    await proxy.close();
  }, 120_000);

  it("refuses an artifact copy that does not match the remote's record of it", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-tamper"));
    const session = await open(proxy.transport(), receipts);
    // Same length, other bytes: only the digest can tell.
    proxy.state.rules.tamper = { method: "artifacts.get", from: "Remote report", to: "Remote rep0rt" };
    const path = join(work, "tamper", "report.md");
    await expect(
      session.prompt("ignored", { timeoutMs: 60_000, turn: turn("run_tamper", path) }),
    ).rejects.toMatchObject({ code: "AGENT_PROTOCOL", details: { mismatch: "digest" } });
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await session.close();
    await proxy.close();
  }, 60_000);

  it("reattaches a retried step to the run its earlier attempt started, after a restart", async () => {
    const proxy = await proxied();
    const dir = join(work, "receipts-restart");
    const gated = agentFor("remote-gated");
    const before = (await runsOf("remote-gated")).length;
    const path = join(work, "restart", "report.md");

    // Attempt 1 admits a remote run that waits on a gate; then this daemon goes away.
    const first = await open(proxy.transport(), new DelegationReceipts(dir), { agent: gated });
    const notes: string[] = [];
    first.onUpdate((e) => notes.push(e.summary.text ?? ""));
    const lost = first
      .prompt("ignored", { timeoutMs: 60_000, turn: turn("run_restart", path) })
      .catch((e: unknown) => e);
    await until("admission", async () => (notes.some((n) => n.startsWith("Delegated to")) ? true : undefined));
    await first.close();
    expect(await lost).toMatchObject({ code: "AGENT_TRANSPORT" });

    // Attempt 2, from a new session that knows only the receipts on disk.
    const asked: string[] = [];
    const second = await open(proxy.transport(), new DelegationReceipts(dir), {
      agent: gated,
      askPermission: async (req) => {
        asked.push(String(req.toolCall.title));
        return "ship";
      },
    });
    await expect(
      second.prompt("ignored", { timeoutMs: 60_000, turn: turn("run_restart", path, 2) }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(asked).toEqual([expect.stringContaining("Ship the report?")]);
    await expect(readFile(path, "utf8")).resolves.toContain("Remote report for: task run_restart");
    expect(await runsOf("remote-gated")).toHaveLength(before + 1);
    await second.close();
    await proxy.close();
  }, 120_000);

  it("refuses a daemon that names another principal than the enrolled one, before admitting", async () => {
    const proxy = await proxied();
    const before = (await runsOf("remote-task")).length;
    const error = await open(proxy.transport(), new DelegationReceipts(join(work, "receipts-scope")), {
      binding: { ...binding, principalId: "someone-else" },
    }).catch((e: unknown) => e);
    expect(isOrcaError(error, "DELEGATION_REFUSED")).toBe(true);
    expect((error as { details: { reason: string } }).details.reason).toBe("scope-changed");
    expect(await runsOf("remote-task")).toHaveLength(before);
    await proxy.close();
  }, 60_000);

  it("never acts on a receipt made under another enrollment or configuration", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-rebind"));
    const before = (await runsOf("remote-task")).length;
    // A cancellation left pending under the earlier enrollment of this remote.
    receipts.write({
      profile: "direct",
      binding: { ...binding, enrollment: "enrollment-0" },
      parentRunId: "run_rebind",
      delegationId: "run_rebind_step1",
      generation: 0,
      key: delegationKey("run_rebind", "run_rebind_step1", 0),
      state: "cancel-pending",
    });
    // The sweep at open leaves it alone; the retried step is refused, and nothing is sent.
    const session = await open(proxy.transport(), receipts);
    expect(receipts.read("run_rebind", "run_rebind_step1")).toMatchObject({ state: "cancel-pending", revision: 0 });
    await expect(
      session.prompt("ignored", { timeoutMs: 30_000, turn: turn("run_rebind", join(work, "rebind", "r.md"), 2) }),
    ).rejects.toMatchObject({ code: "DELEGATION_REFUSED", details: { reason: "scope-changed" } });
    expect(await runsOf("remote-task")).toHaveLength(before);
    await session.close();
    await proxy.close();
  }, 60_000);

  it("commits a receipt transition only over the revision it read", () => {
    const receipts = new DelegationReceipts(join(work, "receipts-cas"));
    const base = {
      profile: "direct",
      binding,
      parentRunId: "run_cas",
      delegationId: "run_cas_step1",
      generation: 0,
      key: delegationKey("run_cas", "run_cas_step1", 0),
    };
    const first = receipts.write({ ...base, state: "cancel-pending" });
    expect(() => receipts.write({ ...base, state: "submitting" })).toThrow(ReceiptConflict);
    // Two sessions read revision 0; the first decision wins, the stale one is refused.
    const newer = receipts.write({ ...first, state: "settled", outcome: "never-admitted" });
    expect(() => receipts.write({ ...first, state: "cancel-pending", remoteRunId: "run_x" })).toThrow(ReceiptConflict);
    expect(receipts.read("run_cas", "run_cas_step1")).toMatchObject({ revision: newer.revision, state: "settled" });
  });

  it("keys each generation of a delegation to its own remote admission", () => {
    expect(delegationKey("r", "d", 0)).not.toBe(delegationKey("r", "d", 1));
    expect(delegationKey("r", "d", 0)).not.toBe(delegationKey("r", "e", 0));
    expect(delegationKey("r", "d", 0)).toBe(delegationKey("r", "d", 0));
    expect(new TextEncoder().encode(delegationKey("r", "d", 0)).length).toBeLessThanOrEqual(128);
  });

  it("refuses a daemon that does not take delegated runs, as a typed failure", async () => {
    const readOnly = await startTestDaemon({ name: "read-only", args: ["--read-only"] });
    try {
      const transport: DelegationTransport = {
        connect: () => connect(readOnly.port, "127.0.0.1"),
        failed: () => undefined,
        close: async () => {},
      };
      const error = await open(transport, new DelegationReceipts(join(work, "receipts-ro")), {
        profile: "ro",
        remoteName: "ro",
        token: readOnly.token,
      }).catch((e: unknown) => e);
      expect(isOrcaError(error, "DELEGATION_REFUSED")).toBe(true);
      expect((error as { details: { reason: string } }).details.reason).toBe("admission-closed");
    } finally {
      await readOnly.close();
    }
  }, 60_000);
});

// The file's own credential check: a token readable by others is refused before it is sent.
it("refuses a credential file other users can read", async () => {
  const { readRemoteCredential } = await import("@orca/daemon");
  const dir = await mkdtemp(join(tmpdir(), "orca-883-cred-"));
  dirs.push(dir);
  const file = join(dir, "x.token");
  writeFileSync(file, `orca1.AAAAAAAAAAAA.${"A".repeat(43)}`);
  chmodSync(file, 0o644);
  const remote = { id: "x", destination: "h" };
  if (process.platform !== "win32") expect(() => readRemoteCredential(remote, file)).toThrow(/readable by other users/);
  chmodSync(file, 0o600);
  expect(readRemoteCredential(remote, file)).toMatch(/^orca1\./);
});
