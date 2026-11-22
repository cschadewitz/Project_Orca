/**
 * Delegating a step to another daemon (#883), end to end: two real `orca serve` processes
 * from the two-daemon fixture (#885 phase 1). Daemon `a` runs a workflow whose step's agent is
 * `type: orca-daemon`; daemon `b` runs the delegated work as its own run.
 *
 * - Over SSH (where sshd is installed): `a` reaches `b` through a throwaway loopback sshd with
 *   the shared `SshTunnel`, exactly as it would a remote machine, with a credential `b` issued.
 * - Over a direct stream: the session against `b` with a transport the test can cut, for the
 *   reattach and idempotency cases that a real tunnel cannot be made to drop on cue.
 *
 * Needs `pnpm run build` (it runs the compiled CLI); CI builds before it tests.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, isOrcaError } from "@orca/core";
import { LocalHost } from "@orca/agents";
import { delegationKey, openDaemonSession, type DelegationTransport } from "@orca/daemon";
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

  afterAll(async () => {
    await parent?.close();
    await remote?.close();
    await sshd?.close();
  });

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

    // The remote's pinned host key was enrolled for the profile on the first connect.
    await expect(readFile(join(parent.dir, "auth", "remotes", "remote-box.known_hosts"), "utf8")).resolves.toMatch(
      /ssh-ed25519/,
    );
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

  it("fails the step with a typed refusal when the remote refuses the credential", async (ctx) => {
    if (!sshd) return ctx.skip();
    const file = join(parent.dir, "auth", "remotes", "remote-box.token");
    const good = await readFile(file, "utf8");
    // A well-formed token the remote never issued.
    writeFileSync(file, `orca1.AAAAAAAAAAAA.${"A".repeat(43)}\n`, { mode: 0o600 });
    try {
      const run = await finished(parent, await admit(parent, "delegate", { city: "Nowhere" }));
      expect(run).toMatchObject({
        status: "failed",
        error: { code: "DELEGATION_REFUSED", message: expect.stringContaining("refused this daemon's credential") },
      });
    } finally {
      writeFileSync(file, good, { mode: 0o600 });
    }
  }, 120_000);
});

describe("delegation over a stream the test can cut (#883)", () => {
  let remote: TestDaemon;
  let token: string;
  let work: string;

  beforeAll(async () => {
    remote = await remoteDaemon();
    token = issueCredential(remote, "parent-direct");
    work = await mkdtemp(join(tmpdir(), "orca-883-work-"));
    dirs.push(work);
  }, 60_000);
  afterAll(async () => {
    await remote?.close();
  });

  /** A transport straight to the remote's port, with a switch that refuses every new stream. */
  function cuttable() {
    const live = new Set<Socket>();
    const state = {
      down: false,
      closed: false,
      streams: 0,
      /** Drop every open stream and refuse new ones, as a lost network would. */
      cut() {
        state.down = true;
        for (const socket of live) socket.destroy();
      },
    };
    const transport: DelegationTransport = {
      connect: () => {
        if (state.down || state.closed) throw new Error("tunnel down");
        state.streams++;
        const socket = connect(remote.port, "127.0.0.1");
        live.add(socket);
        socket.once("close", () => live.delete(socket));
        return socket;
      },
      failed: () => undefined,
      close: async () => {
        state.closed = true;
      },
    };
    return { state, transport };
  }

  const agent = AgentSpecSchema.parse({
    id: "remote",
    type: "orca-daemon",
    profile: "direct",
    workflow: "remote-task",
  });
  const host = new LocalHost({ id: "local", type: "local" });
  const turn = (stepRunId: string, path: string) => ({
    runId: "run_parent",
    stepRunId,
    nodeId: "hand",
    attempt: 1,
    followUp: 0,
    task: `task ${stepRunId}`,
    deliverables: [{ kind: "report", name: "report", path, required: true }],
  });

  it("reattaches to the same remote run after the connection drops, without a second submission", async () => {
    const { state, transport } = cuttable();
    const session = await openDaemonSession({
      agent,
      host,
      cwd: work,
      profile: "direct",
      remoteName: "direct",
      transport,
      token,
      pollMs: 100,
    });
    const notes: string[] = [];
    session.onUpdate((e) => notes.push(e.summary.text ?? ""));
    const path = join(work, "reattach", "report.md");
    const running = session.prompt("ignored", { timeoutMs: 60_000, turn: turn("step_reattach", path) });
    // Drop the connection as soon as the remote run is admitted, and restore it shortly after.
    await until("admission", async () => (notes.some((n) => n.startsWith("Delegated to")) ? true : undefined));
    state.cut();
    await new Promise((r) => setTimeout(r, 600));
    state.down = false;
    await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(notes.join("")).toContain("reattaching");
    await expect(readFile(path, "utf8")).resolves.toContain("Remote report for: task step_reattach");

    // The same turn again (a retried call after a lost answer) admits nothing new.
    const again = join(work, "reattach-again", "report.md");
    await session.prompt("ignored", { timeoutMs: 60_000, turn: turn("step_reattach", again) });
    const runs = (await call(remote, "runs.list", {})).runs as { workflowId: string }[];
    expect(runs.filter((r) => r.workflowId === "remote-task")).toHaveLength(1);
    await session.close();
    await expect(session.terminated).resolves.toBeUndefined();
  }, 120_000);

  it("keys every step attempt to its own remote run", () => {
    expect(delegationKey({ runId: "r", stepRunId: "s1" })).not.toBe(delegationKey({ runId: "r", stepRunId: "s2" }));
    expect(delegationKey({ runId: "r", stepRunId: "s1" })).toBe(delegationKey({ runId: "r", stepRunId: "s1" }));
    expect(new TextEncoder().encode(delegationKey({ runId: "r", stepRunId: "s1" })).length).toBeLessThanOrEqual(128);
  });

  it("refuses a daemon that does not take delegated runs, as a typed failure", async () => {
    const readOnly = await startTestDaemon({ name: "read-only", args: ["--read-only"] });
    try {
      const transport: DelegationTransport = {
        connect: () => connect(readOnly.port, "127.0.0.1"),
        failed: () => undefined,
        close: async () => {},
      };
      const error = await openDaemonSession({
        agent,
        host,
        cwd: work,
        profile: "ro",
        remoteName: "ro",
        transport,
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
