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
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, isOrcaError, RemoteDaemonSpecSchema } from "@orca/core";
import { helloOffer } from "@orca/protocol";
import { LocalHost } from "@orca/agents";
import {
  delegationKey,
  DelegationReceipts,
  enrollRemote,
  openDaemonSession,
  ReceiptConflict,
  recordsOrigin,
  remoteFiles,
  remoteProfile,
  takesGitRef,
  type DelegationReceipt,
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
  // The workflow a remote enrolled with an issued credential (#883 part 4) delegates to.
  writeFileSync(
    join(wf, "remote-auto.yaml"),
    `
id: remote-auto
name: remote auto
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
function issueCredential(remote: TestDaemon, principal: string, label?: string): string {
  const args = ["auth", "issue", principal, "--preset", "client", "--json", ...(label ? ["--label", label] : [])];
  const out = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
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
    // The fixture key runs what the client asked for through this script, as a login shell
    // would: the remote's ORCA CLI, for enrollment that issues a credential (#883 part 4).
    const bin = await mkdtemp(join(tmpdir(), "orca-883-bin-"));
    dirs.push(bin);
    const shell = join(bin, "shell");
    writeFileSync(
      shell,
      '#!/bin/sh\n[ -n "$SSH_ORIGINAL_COMMAND" ] || exit 0\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n',
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(bin, "orca"), `#!/bin/sh\nexec '${process.execPath}' '${CLI_ENTRY}' "$@"\n`, { mode: 0o755 });
    sshd = await loopbackSshd({ forcedCommand: shell });
    if (!sshd) return;
    remote = await remoteDaemon();
    parentWorkflows = await mkdtemp(join(tmpdir(), "orca-883-parent-wf-"));
    dirs.push(parentWorkflows);
    for (const [id, workflow] of [
      ["delegate", "remote"],
      ["delegate-gated", "remote-gated"],
      ["delegate-auto", "remote-auto"],
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
    // The same remote, enrolled with a credential its own CLI issues over ssh (#883 part 4):
    // `serverCommand` is that CLI, `serverConfig` its workspace config.
    const autoSpec = {
      ...remoteSpec,
      id: "auto-box",
      name: "Auto box",
      serverCommand: join(bin, "orca"),
      serverConfig: join(remote.dir, "orca.config.yaml"),
    };
    parent = await startTestDaemon({
      name: "parent",
      config: JSON.stringify({
        version: 1,
        workflows: [join(parentWorkflows, "*.yaml")],
        templates: [],
        remotes: [remoteSpec, autoSpec],
        agents: [
          { id: "remote-auto", type: "orca-daemon", profile: "auto-box", workflow: "remote-auto" },
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

    // The remote run records the parent workspace, run and step as its origin. The remote's
    // audit record of the admission names the authenticated principal and the run it made;
    // the caller-stated origin stays out of the audit log (it is not redacted there).
    const parentWorkspace = ((await call(parent, "operator.discover", {})).target as { workspaceId: string })
      .workspaceId;
    const remoteRun = (await call(remote, "runs.get", { runId: delegated[0]!.id })).run as {
      origin?: { workspaceId: string; runId: string; stepRunId?: string };
    };
    expect(remoteRun.origin).toMatchObject({ workspaceId: parentWorkspace, runId });
    expect(typeof remoteRun.origin!.stepRunId).toBe("string");
    const admission = audit.find(
      (r) =>
        r.operation === "runs.admit" &&
        Object.values((r.target as Record<string, string> | undefined) ?? {}).includes(delegated[0]!.id),
    );
    expect(admission).toMatchObject({ outcome: "succeeded", actor: { principal: "parent-daemon" } });
    const log = JSON.stringify(audit);
    for (const value of [parentWorkspace, runId, remoteRun.origin!.stepRunId!]) expect(log).not.toContain(value);
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

  it("refuses a route other than the enrolled one before using the credential", async (ctx) => {
    if (!sshd) return ctx.skip();
    const file = enrollmentPath();
    const good = await readFile(file, "utf8");
    const before = ((await call(remote, "runs.list", {})).runs as unknown[]).length;
    // Same pinned host, another daemon port: as a config edit would retarget it.
    const record = JSON.parse(good) as { route: { remotePort: number } };
    writeFileSync(file, JSON.stringify({ ...record, route: { ...record.route, remotePort: remote.port + 1 } }), {
      mode: 0o600,
    });
    try {
      const run = await finished(parent, await admit(parent, "delegate", { city: "Elsewhere" }));
      expect(run).toMatchObject({
        status: "failed",
        error: { code: "DELEGATION_REFUSED", message: expect.stringContaining("different address, port or jump host") },
      });
    } finally {
      writeFileSync(file, good, { mode: 0o600 });
    }
    expect(((await call(remote, "runs.list", {})).runs as unknown[]).length).toBe(before);
  }, 120_000);

  /** The credentials the remote's CLI lists. */
  const remoteCredentials = () => {
    const out = spawnSync(process.execPath, [CLI_ENTRY, "auth", "list", "--json"], {
      cwd: remote.dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: join(remote.dir, "..", "home") },
    });
    expect(out.status, out.stderr).toBe(0);
    return JSON.parse(out.stdout) as {
      id: string;
      principal: string;
      revokedAt?: string;
      label?: string;
      scope: { workflows: string[] | "*"; runs: string };
    }[];
  };
  const revokedOnRemote = (id: string) => Boolean(remoteCredentials().find((c) => c.id === id)?.revokedAt);
  const autoDir = () => join(parent.dir, "auth", "remotes");
  const autoRecord = () => join(autoDir(), "auto-box.json");
  type AutoRecord = {
    credentialId: string;
    principalId: string;
    issued?: boolean;
    tokenFile?: string;
    workspaceId: string;
  };
  const readAutoRecord = async () => JSON.parse(await readFile(autoRecord(), "utf8")) as AutoRecord;
  const enrollAuto = (...flags: string[]) => {
    const out = cli(parent, ["remote", "enroll", "auto-box", "--json", ...flags]);
    expect(out.status, out.stderr).toBe(0);
    return { record: JSON.parse(out.stdout) as AutoRecord, stderr: out.stderr };
  };
  const delegatesAuto = async (city: string) =>
    expect(await finished(parent, await admit(parent, "delegate-auto", { city }))).toMatchObject({
      status: "succeeded",
    });

  it("issues the credential over ssh when none was saved, scoped to the delegated workflow (#883)", async (ctx) => {
    if (!sshd) return ctx.skip();
    expect(existsSync(join(autoDir(), "auto-box.token"))).toBe(false);
    const { record: first } = enrollAuto("--host-key", sshd.hostKeyFingerprint);
    const parentWorkspace = ((await call(parent, "operator.discover", {})).target as { workspaceId: string })
      .workspaceId;
    expect(first).toMatchObject({
      issued: true,
      principalId: `delegate-${parentWorkspace}`,
      tokenFile: `auto-box.${first.credentialId}.token`,
    });
    // Saved for this user alone, in its own generation file, holding the credential the record names.
    const token = join(autoDir(), first.tokenFile!);
    expect(statSync(token).mode & 0o777).toBe(0o600);
    expect((await readFile(token, "utf8")).trim().split(".")[1]).toBe(first.credentialId);
    expect(existsSync(join(autoDir(), "auto-box.token"))).toBe(false);
    // On the remote: a client credential, owned runs only, for exactly the delegated workflow.
    expect(remoteCredentials().find((c) => c.id === first.credentialId)).toMatchObject({
      principal: `delegate-${parentWorkspace}`,
      label: expect.stringMatching(/^orca-delegation-auto-box-[0-9a-f]{16}$/),
      scope: { workflows: ["remote-auto"], runs: "owned" },
    });
    expect(revokedOnRemote(first.credentialId)).toBe(false);
    await delegatesAuto("Oslo");

    // Enrolling again with --issue replaces it: a new credential and generation file, the old
    // one revoked there and its file gone.
    const { record: second } = enrollAuto("--issue");
    expect(second.issued).toBe(true);
    expect(second.credentialId).not.toBe(first.credentialId);
    expect(await readAutoRecord()).toMatchObject({ credentialId: second.credentialId });
    expect(revokedOnRemote(first.credentialId)).toBe(true);
    expect(revokedOnRemote(second.credentialId)).toBe(false);
    expect(existsSync(token)).toBe(false);
    expect(existsSync(`${autoRecord()}.pending-revoke`)).toBe(false);
    await delegatesAuto("Bergen");
  }, 180_000);

  it("keeps an issued credential's provenance when re-enrolling reuses it, so a later rotation retires it", async (ctx) => {
    if (!sshd) return ctx.skip();
    const before = await readAutoRecord();
    const issuedBefore = remoteCredentials().length;
    // Plain re-enrollment: the same credential, still marked issued, nothing new on the remote.
    const { record: reused } = enrollAuto();
    expect(reused).toMatchObject({ credentialId: before.credentialId, issued: true, tokenFile: before.tokenFile });
    expect(remoteCredentials()).toHaveLength(issuedBefore);
    await delegatesAuto("Tromsø");
    // So the rotation after it still revokes it.
    const { record: rotated } = enrollAuto("--issue");
    expect(rotated.credentialId).not.toBe(before.credentialId);
    expect(revokedOnRemote(before.credentialId)).toBe(true);
    await delegatesAuto("Bodø");
  }, 180_000);

  it("leaves the previous enrollment working when a rotation is cut off before it commits", async (ctx) => {
    if (!sshd) return ctx.skip();
    const before = await readAutoRecord();
    const recordText = await readFile(autoRecord(), "utf8");
    const known = new Set(remoteCredentials().map((c) => c.id));
    const config = JSON.parse(await readFile(join(parent.dir, "orca.config.yaml"), "utf8")) as {
      remotes: unknown[];
    };
    const spec = RemoteDaemonSpecSchema.parse(config.remotes.find((r) => (r as { id: string }).id === "auto-box"));
    const files = remoteFiles(parent.dir, spec);
    await expect(
      enrollRemote({
        remote: spec,
        profile: remoteProfile(spec),
        knownHostsFile: files.knownHostsFile,
        file: files.enrollmentFile,
        workflows: ["remote-auto"],
        receiptsDir: join(parent.dir, ".orca", "delegations"),
        issue: { principal: before.principalId, rotate: true },
        beforeCommit: () => {
          throw new Error("cut off");
        },
      }),
    ).rejects.toThrow("cut off");
    // The record, its token file and the credential it names are untouched...
    expect(await readFile(autoRecord(), "utf8")).toBe(recordText);
    expect(existsSync(join(autoDir(), before.tokenFile!))).toBe(true);
    expect(revokedOnRemote(before.credentialId)).toBe(false);
    // ...and the credential the cut-off rotation issued is revoked, its file gone, nothing pending.
    const extra = remoteCredentials().filter((c) => !known.has(c.id));
    expect(extra).toHaveLength(1);
    expect(extra[0]!.revokedAt).toBeTruthy();
    expect(existsSync(join(autoDir(), `auto-box.${extra[0]!.id}.token`))).toBe(false);
    expect(existsSync(`${autoRecord()}.pending-revoke`)).toBe(false);
    await delegatesAuto("Narvik");
  }, 180_000);

  it("journals the generation it replaces before committing, so a cut-off just after it is cleaned up", async (ctx) => {
    if (!sshd) return ctx.skip();
    const before = await readAutoRecord();
    const config = JSON.parse(await readFile(join(parent.dir, "orca.config.yaml"), "utf8")) as {
      remotes: unknown[];
    };
    const spec = RemoteDaemonSpecSchema.parse(config.remotes.find((r) => (r as { id: string }).id === "auto-box"));
    const files = remoteFiles(parent.dir, spec);
    await expect(
      enrollRemote({
        remote: spec,
        profile: remoteProfile(spec),
        knownHostsFile: files.knownHostsFile,
        file: files.enrollmentFile,
        workflows: ["remote-auto"],
        receiptsDir: join(parent.dir, ".orca", "delegations"),
        issue: { principal: before.principalId, rotate: true },
        afterCommit: () => {
          throw new Error("cut off");
        },
      }),
    ).rejects.toThrow("cut off");
    // The new generation is active; the one it replaced is journaled, still valid until settled.
    // (The new one's own issuing entry may still be listed: the active credential never counts.)
    const after = await readAutoRecord();
    expect(after.credentialId).not.toBe(before.credentialId);
    const journal = JSON.parse(await readFile(`${autoRecord()}.pending-revoke`, "utf8")) as {
      entries: { credentialId?: string; label: string }[];
    };
    expect(journal.entries.map((e) => e.credentialId)).toContain(before.credentialId);
    expect(revokedOnRemote(after.credentialId)).toBe(false);
    expect(revokedOnRemote(before.credentialId)).toBe(false);
    await delegatesAuto("Harstad");
    // The next enrollment reconciles against the active generation: it keeps that, revokes the old.
    const { record } = enrollAuto();
    expect(record.credentialId).toBe(after.credentialId);
    expect(revokedOnRemote(before.credentialId)).toBe(true);
    expect(existsSync(join(autoDir(), before.tokenFile!))).toBe(false);
    expect(existsSync(`${autoRecord()}.pending-revoke`)).toBe(false);
  }, 180_000);

  it("revokes what a crashed enrollment left pending only where its label proves the issuer", async (ctx) => {
    if (!sshd) return ctx.skip();
    const current = await readAutoRecord();
    const { route, keys } = JSON.parse(await readFile(autoRecord(), "utf8")) as { route: unknown; keys: string };
    const label = () => `orca-delegation-auto-box-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    // A request whose answer was lost: only its label is known here. One whose answer arrived.
    // One journaled at another workspace, and one that never reached the remote at all.
    const lost = { label: label() };
    const lostId = issueCredential(remote, current.principalId, lost.label).split(".")[1]!;
    const known = { label: label() };
    const knownId = issueCredential(remote, current.principalId, known.label).split(".")[1]!;
    const elsewhere = { label: label() };
    const elsewhereId = issueCredential(remote, current.principalId, elsewhere.label).split(".")[1]!;
    const never = { label: label() };
    const since = new Date().toISOString();
    const base = { principal: current.principalId, route, keys, since, reason: "issued, not yet enrolled" };
    writeFileSync(
      `${autoRecord()}.pending-revoke`,
      JSON.stringify({
        version: 1,
        entries: [
          { ...base, ...lost },
          { ...base, ...known, credentialId: knownId },
          { ...base, ...elsewhere, credentialId: elsewhereId, workspaceId: "ws_elsewhere" },
          { ...base, ...never },
          // The active credential is never revoked, whatever a cut-off run listed.
          { ...base, label: label(), credentialId: current.credentialId },
        ],
      }),
      { mode: 0o600 },
    );
    const { record, stderr } = enrollAuto();
    expect(record.credentialId).toBe(current.credentialId);
    expect(revokedOnRemote(lostId)).toBe(true);
    expect(revokedOnRemote(knownId)).toBe(true);
    expect(revokedOnRemote(elsewhereId)).toBe(false);
    expect(revokedOnRemote(current.credentialId)).toBe(false);
    expect(stderr).toContain(elsewhereId);
    expect(stderr).toContain(never.label);
    const left = JSON.parse(await readFile(`${autoRecord()}.pending-revoke`, "utf8")) as {
      entries: { label: string; unresolved?: string }[];
    };
    expect(left.entries.map((e) => e.label).sort()).toEqual([elsewhere.label, never.label].sort());
    expect(left.entries.every((e) => e.unresolved)).toBe(true);
    await delegatesAuto("Alta");
    writeFileSync(
      `${autoRecord()}.pending-revoke`,
      JSON.stringify({ version: 1, entries: left.entries.filter((e) => e.label === elsewhere.label) }),
      { mode: 0o600 },
    );

    // A rotation away from an enrollment whose daemon named another workspace does not send its
    // credential id to this one: it is kept pending, with a warning.
    const recorded = JSON.parse(await readFile(autoRecord(), "utf8")) as Record<string, unknown>;
    writeFileSync(autoRecord(), JSON.stringify({ ...recorded, workspaceId: "ws_moved" }), { mode: 0o600 });
    const { record: rotated, stderr: warned } = enrollAuto("--issue");
    expect(rotated.credentialId).not.toBe(current.credentialId);
    expect(revokedOnRemote(current.credentialId)).toBe(false);
    expect(warned).toContain(current.credentialId);
    const pending = JSON.parse(await readFile(`${autoRecord()}.pending-revoke`, "utf8")) as {
      entries: { credentialId?: string; workspaceId?: string }[];
    };
    expect(pending.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credentialId: elsewhereId }),
        expect.objectContaining({ credentialId: current.credentialId, workspaceId: "ws_moved" }),
      ]),
    );
    await delegatesAuto("Kirkenes");
  }, 180_000);

  it("refuses to re-enroll while delegations still depend on the current enrollment", async (ctx) => {
    if (!sshd) return ctx.skip();
    const before = await readAutoRecord();
    const receipts = join(parent.dir, ".orca", "delegations");
    mkdirSync(receipts, { recursive: true });
    // One it cannot read counts as running: never strand what cannot be seen.
    const stuck = join(receipts, "zz-unreadable.json");
    writeFileSync(stuck, "{");
    try {
      const out = cli(parent, ["remote", "enroll", "auto-box", "--issue", "--json"]);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain("still running on remote auto-box");
    } finally {
      rmSync(stuck, { force: true });
    }
    expect((await readAutoRecord()).credentialId).toBe(before.credentialId);
  }, 180_000);

  it("holds a delegation that starts while the remote is being enrolled until the enrollment ends", async (ctx) => {
    if (!sshd) return ctx.skip();
    const lock = `${autoRecord()}.lock`;
    const before = ((await call(remote, "runs.list", {})).runs as { workflowId: string }[]).filter(
      (r) => r.workflowId === "remote-auto",
    ).length;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() }));
    let runId: string;
    try {
      runId = await admit(parent, "delegate-auto", { city: "Hammerfest" });
      await new Promise((r) => setTimeout(r, 2_000));
      // Nothing was sent, and nothing was recorded that a new enrollment could strand.
      const now = ((await call(remote, "runs.list", {})).runs as { workflowId: string }[]).filter(
        (r) => r.workflowId === "remote-auto",
      ).length;
      expect(now).toBe(before);
      expect(new DelegationReceipts(join(parent.dir, ".orca", "delegations")).unsettled("auto-box")).toBe(0);
    } finally {
      rmSync(lock, { force: true });
    }
    expect(await finished(parent, runId)).toMatchObject({ status: "succeeded" });
  }, 180_000);

  it("refuses a second enrollment of the same remote while one is running", async (ctx) => {
    if (!sshd) return ctx.skip();
    const lock = `${autoRecord()}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() }));
    try {
      const out = cli(parent, ["remote", "enroll", "auto-box", "--json"]);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain("already being enrolled");
    } finally {
      rmSync(lock, { force: true });
    }
    // A lock whose process on this host is gone is taken over by exactly one of several
    // enrollments racing for it; the others are refused, and no lock or claim is left behind.
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 1, host: hostname(), since: new Date().toISOString() }));
    const racers = await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<{ code: number | null; stderr: string }>((done) => {
            const child = spawn(process.execPath, [CLI_ENTRY, "remote", "enroll", "auto-box", "--json"], {
              cwd: parent.dir,
              env: process.env,
            });
            let stderr = "";
            child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
            child.stdout.resume();
            child.on("close", (code) => done({ code, stderr }));
          }),
      ),
    );
    for (const racer of racers)
      if (racer.code !== 0) expect(racer.stderr, racer.stderr).toContain("already being enrolled");
    expect(racers.filter((r) => r.code === 0).length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(autoDir()).filter((n) => n.startsWith("auto-box.json.lock"))).toEqual([]);
    await delegatesAuto("Vardø");
  }, 180_000);

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
      credentialId: token.split(".")[1]!,
      workflowId: "remote-task",
      configGeneration: "generation-1",
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
    const agent = extra.agent ?? agentFor("remote-task");
    return openDaemonSession({
      host,
      cwd: work,
      profile: "direct",
      remoteName: "direct",
      transport,
      token,
      receipts,
      pollMs: 100,
      ...extra,
      agent,
      // The binding names the agent's own workflow, as the factory computes it.
      binding: { ...(extra.binding ?? binding), workflowId: agent.workflow! },
    });
  }

  it("reports the remote's session cap from its hello for the slot queue (#884)", async () => {
    const proxy = await proxied();
    const seen: (number | undefined)[] = [];
    const session = await open(proxy.transport(), new DelegationReceipts(join(work, "receipts-capacity")), {
      onCapacity: (max) => void seen.push(max),
    });
    // This remote sets no limits.maxAgentSessions: unlimited.
    expect(seen).toEqual([undefined]);
    await session.close();
    await proxy.close();
  }, 60_000);

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

  it("backs out a new receipt and waits while the remote is being enrolled, then goes on under the same record", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-gate"));
    let enrolling = true;
    const seen: (ReturnType<DelegationReceipts["read"]> | "checked")[] = [];
    const session = await open(proxy.transport(), receipts, {
      enrollment: {
        inProgress: () => {
          // What a running enrollment would see: the receipt was backed out at once.
          if (enrolling) seen.push(receipts.read("run_gate", "run_gate_step1") ?? "checked");
          return enrolling;
        },
        current: () => true,
      },
    });
    const before = (await runsOf("remote-task")).length;
    const path = join(work, "gate", "report.md");
    const running = session.prompt("ignored", { timeoutMs: 60_000, turn: turn("run_gate", path) });
    await until("the gate to be met", async () => (seen.length >= 2 ? true : undefined));
    expect(seen.slice(1).every((r) => r === "checked")).toBe(true);
    expect(await runsOf("remote-task")).toHaveLength(before);
    enrolling = false;
    await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(await runsOf("remote-task")).toHaveLength(before + 1);
    await session.close();
    await proxy.close();
  }, 60_000);

  it("never submits a reservation outside the gate: a crash's is backed out by enrollment or promoted once by recovery", async () => {
    const receipts = new DelegationReceipts(join(work, "receipts-reserved"));
    const bound = { ...binding, workflowId: "remote-task" };
    const reserve = (parentRunId: string, extra: Partial<DelegationReceipt> = {}) =>
      receipts.write({
        profile: "direct",
        binding: bound,
        parentRunId,
        delegationId: `${parentRunId}_step1`,
        generation: 0,
        key: delegationKey(parentRunId, `${parentRunId}_step1`, 0),
        state: "reserved",
        ...extra,
      });
    // What an enrollment does under its lock: a first reservation leaves nothing, a next
    // generation goes back to the settled one it would have replaced.
    reserve("run_res_a");
    reserve("run_res_b", {
      generation: 1,
      key: delegationKey("run_res_b", "run_res_b_step1", 1),
      previous: { generation: 0, key: delegationKey("run_res_b", "run_res_b_step1", 0), outcome: "failed" },
    });
    expect(receipts.unsettled("direct")).toBe(2);
    receipts.unreserveAll("direct");
    expect(receipts.read("run_res_a", "run_res_a_step1")).toBeUndefined();
    expect(receipts.read("run_res_b", "run_res_b_step1")).toMatchObject({
      state: "settled",
      generation: 0,
      outcome: "failed",
    });
    expect(receipts.unsettled("direct")).toBe(0);

    // A reservation removed and made again at the same path is another receipt: whoever still
    // holds the first can neither promote nor remove the second, even at the same revision.
    const first = reserve("run_res_d");
    receipts.unreserve(first);
    const second = reserve("run_res_d");
    expect(second.revision).toBe(first.revision);
    const { version: _v, updatedAt: _u, ...stale } = first;
    expect(() => receipts.write({ ...stale, state: "submitting" })).toThrow(ReceiptConflict);
    expect(() => receipts.discard(first)).toThrow(ReceiptConflict);
    expect(() => receipts.unreserve(first)).toThrow(ReceiptConflict);
    expect(receipts.read("run_res_d", "run_res_d_step1")).toMatchObject({
      state: "reserved",
      instance: second.instance,
    });
    receipts.unreserve(second);

    // Receipts written before `instance` existed are read, counted and moved on as ever; the
    // first transition gives one a fresh instance, after which the old copy conflicts.
    const legacy = (parentRunId: string, state: string, extra: Record<string, unknown> = {}) => {
      const fields = {
        profile: "direct",
        binding: bound,
        parentRunId,
        delegationId: `${parentRunId}_step1`,
        generation: 0,
        key: delegationKey(parentRunId, `${parentRunId}_step1`, 0),
        state,
        ...extra,
      };
      const before = new Set(readdirSync(receipts.dir));
      // Through the API, then with `instance` stripped, exactly as the earlier format wrote it.
      receipts.write(fields as never);
      const file = readdirSync(receipts.dir).find((n) => n.endsWith(".json") && !before.has(n))!;
      const { instance: _i, ...old } = JSON.parse(readFileSync(join(receipts.dir, file), "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(join(receipts.dir, file), JSON.stringify({ ...old, revision: 3 }));
      return receipts.read(parentRunId, `${parentRunId}_step1`)!;
    };
    const submitting = legacy("run_old_s", "submitting");
    const admitted = legacy("run_old_a", "admitted", { remoteRunId: "run_remote_old" });
    legacy("run_old_d", "settled", { remoteRunId: "run_remote_done", outcome: "succeeded" });
    expect(submitting.instance).toBeUndefined();
    expect(receipts.unsettled("direct")).toBe(2);
    const moved = receipts.write({ ...admitted, state: "settled", outcome: "succeeded" });
    expect(moved).toMatchObject({ revision: 4, state: "settled" });
    expect(moved.instance).toEqual(expect.any(String));
    expect(() => receipts.write({ ...admitted, state: "cancel-pending" })).toThrow(ReceiptConflict);
    expect(receipts.write({ ...submitting, state: "cancel-pending" }).instance).toEqual(expect.any(String));
    expect(receipts.read("run_old_d", "run_old_d_step1")).toMatchObject({ state: "settled", outcome: "succeeded" });

    // Recovery after a crash: the reservation is promoted through the gate, by exactly one of
    // two sessions racing for it, and submitted once.
    reserve("run_res_c");
    const proxy = await proxied();
    const gate = { inProgress: () => false, current: () => true };
    const one = await open(proxy.transport(), receipts, { enrollment: gate });
    const two = await open(proxy.transport(), receipts, { enrollment: gate });
    const before = (await runsOf("remote-task")).length;
    const results = await Promise.all(
      [one, two].map((session, i) =>
        session.prompt("ignored", {
          timeoutMs: 60_000,
          turn: turn("run_res_c", join(work, `res-c-${i}`, "report.md")),
        }),
      ),
    );
    expect(results.map((r) => r.stopReason)).toEqual(["end_turn", "end_turn"]);
    expect(await runsOf("remote-task")).toHaveLength(before + 1);
    expect(receipts.read("run_res_c", "run_res_c_step1")).toMatchObject({ state: "settled", generation: 0 });
    await one.close();
    await two.close();
    await proxy.close();
  }, 90_000);

  it("refuses, sending nothing and leaving no receipt, when the remote was enrolled again as the step started", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-gate-moved"));
    const session = await open(proxy.transport(), receipts, {
      enrollment: { inProgress: () => false, current: () => false },
    });
    const before = (await runsOf("remote-task")).length;
    await expect(
      session.prompt("ignored", { timeoutMs: 30_000, turn: turn("run_moved", join(work, "moved", "report.md")) }),
    ).rejects.toMatchObject({ code: "DELEGATION_REFUSED", details: { reason: "scope-changed" } });
    // Recovery after a restart finds nothing bound to the replaced generation.
    expect(receipts.read("run_moved", "run_moved_step1")).toBeUndefined();
    expect(await runsOf("remote-task")).toHaveLength(before);
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

  it("fences only in the workspace and principal the caller names", async () => {
    const key = `orca-delegate-scope-${randomUUID()}`;
    const other = await remote.call(
      "admissions.fence",
      {
        idempotencyKey: key,
        workflowId: "remote-task",
        expectedScope: { workspaceId: randomUUID(), principalId: binding.principalId },
      },
      token,
    );
    expect(other).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
    const unscoped = await remote.call("admissions.fence", { idempotencyKey: key, workflowId: "remote-task" }, token);
    expect(unscoped.ok).toBe(false);
    // Neither claimed the key.
    expect(await remote.call("admissions.find", { idempotencyKey: key }, token)).toMatchObject({
      ok: true,
      result: { state: "absent" },
    });
  }, 60_000);

  it("breaks a receipt lock only when its owner is provably gone", () => {
    const receipts = new DelegationReceipts(join(work, "receipts-lock"));
    const base = {
      profile: "direct",
      binding,
      parentRunId: "run_lock",
      delegationId: "run_lock_step1",
      generation: 0,
      key: delegationKey("run_lock", "run_lock_step1", 0),
      state: "submitting" as const,
    };
    const first = receipts.write(base);
    const lock = `${join(
      receipts.dir,
      readdirSync(receipts.dir).find((n) => n.endsWith(".json"))!,
    )}.lock`;
    // A lock held by a live process (this host's init) is never broken: the writer gives up.
    writeFileSync(lock, JSON.stringify({ token: "other", pid: 1, host: hostname() }));
    expect(() => receipts.write({ ...first, state: "admitted", remoteRunId: "run_a" })).toThrow(ReceiptConflict);
    expect(readFileSync(lock, "utf8")).toContain('"other"');
    // One whose process is gone is set aside, and the write goes through.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(lock, JSON.stringify({ token: "gone", pid: Number(dead.stdout), host: hostname() }));
    expect(receipts.write({ ...first, state: "admitted", remoteRunId: "run_a" })).toMatchObject({ revision: 1 });
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  it("never reconciles a recoverable admission to cancel it, and keeps the cancel open while no run exists", async () => {
    // A daemon that admits nothing it is not told to: the real remote's hello and discovery,
    // an admission whose answer never comes, and a fence that finds that admission recoverable
    // with a reserved run id under which no run exists.
    const hello = await remote.call("hello", { client: "test", ...helloOffer() }, token);
    const discovery = await remote.call("operator.discover", {}, token);
    const calls: string[] = [];
    let admitSeen: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => (admitSeen = resolve));
    const fake = createHttpServer((req, res) => {
      let text = "";
      req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      req.on("end", () => {
        const message = JSON.parse(text) as { id: number; method: string };
        calls.push(message.method);
        const answer = (body: object) => res.end(JSON.stringify({ kind: "response", id: message.id, ...body }));
        switch (message.method) {
          case "hello":
          case "operator.discover":
            return answer(message.method === "hello" ? hello : discovery);
          case "runs.admit":
            admitSeen?.();
            return; // never answered
          case "admissions.fence":
            return answer({
              ok: true,
              result: {
                state: "resolved",
                operationId: `retry_${randomUUID()}`,
                replayed: true,
                result: {
                  state: "recoverable-failure",
                  admissionId: "direct_reserved",
                  runId: "run_reserved",
                  failure: { code: "RUN_STATE", message: "incomplete", recovery: "reconcile" },
                },
              },
            });
          case "runs.get":
            return answer({ ok: false, error: { code: "RUN_NOT_FOUND", message: "no such run" } });
          default:
            return answer({ ok: false, error: { code: "NOT_SUPPORTED", message: message.method } });
        }
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const port = (fake.address() as { port: number }).port;
    const live = new Set<Socket>();
    const transport: DelegationTransport = {
      connect: () => {
        const socket = connect(port, "127.0.0.1");
        live.add(socket);
        return socket;
      },
      failed: () => undefined,
      close: async () => undefined,
    };
    const receipts = new DelegationReceipts(join(work, "receipts-recoverable"));
    const session = await open(transport, receipts);
    const abort = new AbortController();
    const running = session.prompt("ignored", {
      timeoutMs: 30_000,
      signal: abort.signal,
      turn: turn("run_recoverable", join(work, "recoverable", "report.md")),
    });
    await admitted;
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(calls).toContain("admissions.fence");
    expect(calls).toContain("runs.get");
    expect(calls).not.toContain("admissions.reconcile");
    expect(calls.filter((c) => c === "runs.admit")).toHaveLength(1);
    expect(receipts.read("run_recoverable", "run_recoverable_step1")).toMatchObject({ state: "cancel-pending" });
    expect(receipts.read("run_recoverable", "run_recoverable_step1")?.remoteRunId).toBeUndefined();
    await session.close();
    for (const socket of live) socket.destroy();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }, 60_000);

  it("keys each generation of a delegation to its own remote admission", () => {
    expect(delegationKey("r", "d", 0)).not.toBe(delegationKey("r", "d", 1));
    expect(delegationKey("r", "d", 0)).not.toBe(delegationKey("r", "e", 0));
    expect(delegationKey("r", "d", 0)).toBe(delegationKey("r", "d", 0));
    expect(new TextEncoder().encode(delegationKey("r", "d", 0)).length).toBeLessThanOrEqual(128);
  });

  // Canonical ids, as the remote checks a stated origin.
  const ORIGIN_WORKSPACE = "0b6f3c1e-4a1d-4c7e-9a52-2d6f0f8f9a11";
  const PARENT = "run_01JD0000000000000000000000";
  const STEP = "step_01JD0000000000000000000000";

  it("states the parent workspace, run and step as the remote run's origin", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-origin"));
    const session = await open(proxy.transport(), receipts, { originWorkspaceId: ORIGIN_WORKSPACE });
    const path = join(work, "origin", "report.md");
    await expect(
      session.prompt("ignored", { timeoutMs: 60_000, turn: turn(PARENT, path, 1, STEP, STEP) }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    const origin = { workspaceId: ORIGIN_WORKSPACE, runId: PARENT, stepRunId: STEP };
    const receipt = receipts.read(PARENT, STEP)!;
    expect(receipt.origin).toEqual(origin);
    const remoteRun = (await call(remote, "runs.get", { runId: receipt.remoteRunId! })).run as { origin?: unknown };
    expect(remoteRun.origin).toEqual(origin);
    await session.close();
    await proxy.close();
  }, 120_000);

  it("states no origin to a daemon whose hello does not list it, whatever its protocol minor", async () => {
    const proxy = await proxied();
    // The remote's hello, with `origin` taken out of admitFields: an independent 2.6 peer.
    proxy.state.rules.tamper = { method: "hello", from: '"admitFields":["origin"', to: '"admitFields":["nigiro"' };
    const receipts = new DelegationReceipts(join(work, "receipts-no-origin"));
    const session = await open(proxy.transport(), receipts, { originWorkspaceId: ORIGIN_WORKSPACE });
    const parent = "run_01JD0000000000000000000001";
    await expect(
      session.prompt("ignored", {
        timeoutMs: 60_000,
        turn: turn(parent, join(work, "no-origin", "report.md"), 1, STEP, STEP),
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    const receipt = receipts.read(parent, STEP)!;
    expect(receipt.origin).toBeUndefined();
    const remoteRun = (await call(remote, "runs.get", { runId: receipt.remoteRunId! })).run as { origin?: unknown };
    expect(remoteRun.origin).toBeUndefined();
    await session.close();
    await proxy.close();
  }, 120_000);

  it("refuses to replay an admission that stated an origin to a daemon that no longer takes one", async () => {
    const proxy = await proxied();
    proxy.state.rules.tamper = { method: "hello", from: '"admitFields":["origin"', to: '"admitFields":["nigiro"' };
    const receipts = new DelegationReceipts(join(work, "receipts-origin-replay"));
    const parent = "run_01JD0000000000000000000002";
    // A receipt whose admission went out with an origin, its answer never learned.
    receipts.write({
      profile: "direct",
      binding: { ...binding, workflowId: "remote-task" },
      parentRunId: parent,
      delegationId: STEP,
      generation: 0,
      key: delegationKey(parent, STEP, 0),
      state: "submitting",
      origin: { workspaceId: ORIGIN_WORKSPACE, runId: parent, stepRunId: STEP },
    });
    const before = (await runsOf("remote-task")).length;
    const session = await open(proxy.transport(), receipts, { originWorkspaceId: ORIGIN_WORKSPACE });
    const error = await session
      .prompt("ignored", { timeoutMs: 30_000, turn: turn(parent, join(work, "replay", "report.md"), 1, STEP, STEP) })
      .catch((e: unknown) => e);
    expect(isOrcaError(error, "DELEGATION_REFUSED")).toBe(true);
    expect((error as { details: { reason: string } }).details.reason).toBe("protocol");
    // Nothing was sent: no run, and the receipt still holds the admission as it was.
    expect(await runsOf("remote-task")).toHaveLength(before);
    expect(receipts.read(parent, STEP)).toMatchObject({ state: "submitting", origin: { runId: parent } });
    await session.close();
    await proxy.close();
  }, 60_000);

  it("fails the step with a typed refusal when the remote cannot check out the named git ref", async () => {
    const proxy = await proxied();
    const receipts = new DelegationReceipts(join(work, "receipts-ref"));
    const agent = AgentSpecSchema.parse({
      id: "remote",
      type: "orca-daemon",
      profile: "direct",
      workflow: "remote-task",
      gitRef: "refs/heads/feature/x",
    });
    const session = await open(proxy.transport(), receipts, { agent });
    const before = (await runsOf("remote-task")).length;
    const error = await session
      .prompt("ignored", { timeoutMs: 30_000, turn: turn("run_ref", join(work, "ref", "report.md")) })
      .catch((e: unknown) => e);
    // The remote's workspace (a shared local checkout) gives no run a checkout of its own.
    expect(isOrcaError(error, "DELEGATION_REFUSED")).toBe(true);
    expect((error as { details: { reason: string; gitRef: string } }).details).toMatchObject({
      reason: "git-ref",
      gitRef: "refs/heads/feature/x",
    });
    expect(await runsOf("remote-task")).toHaveLength(before);
    await session.close();
    await proxy.close();
  }, 60_000);

  it("names a git ref only to a daemon whose hello lists it", () => {
    expect(takesGitRef({})).toBe(false);
    expect(takesGitRef({ admitFields: ["origin"] })).toBe(false);
    expect(takesGitRef({ admitFields: ["origin", "gitRef"] })).toBe(true);
    expect(
      AgentSpecSchema.safeParse({ id: "a", type: "orca-daemon", profile: "p", workflow: "w", gitRef: "a..b" }).success,
    ).toBe(false);
    expect(
      AgentSpecSchema.safeParse({ id: "a", type: "orca-daemon", profile: "p", workflow: "w", gitRef: "main" }).success,
    ).toBe(false);
    expect(AgentSpecSchema.safeParse({ id: "a", command: "x", gitRef: "refs/heads/main" }).success).toBe(false);
  });

  it("refuses an origin that is not canonical ids, before anything is admitted", async () => {
    const before = (await runsOf("remote-task")).length;
    for (const origin of [
      { workspaceId: "not-a-uuid", runId: PARENT },
      { workspaceId: ORIGIN_WORKSPACE, runId: "run_<script>" },
      { workspaceId: ORIGIN_WORKSPACE, runId: PARENT, stepRunId: "private-token-value" },
      { workspaceId: ORIGIN_WORKSPACE, runId: PARENT, extra: "x" },
    ]) {
      const answer = await remote.call("runs.admit", { workflowId: "remote-task", vars: { prompt: "x" }, origin });
      expect(answer.ok).toBe(false);
    }
    expect(await runsOf("remote-task")).toHaveLength(before);
    // Refused admissions are audited without the origin they stated.
    const audit = await readFile(join(remote.dir, "auth", "audit.jsonl"), "utf8");
    for (const value of ["not-a-uuid", "run_<script>", "private-token-value"]) expect(audit).not.toContain(value);
  });

  it("states an origin only to a daemon whose hello lists it", () => {
    expect(recordsOrigin({})).toBe(false);
    expect(recordsOrigin({ admitFields: [] })).toBe(false);
    expect(recordsOrigin({ admitFields: ["origin"] })).toBe(true);
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
