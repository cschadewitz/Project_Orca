/**
 * #1206: a workspace the desktop app set up in first-run can enroll a delegation remote, and
 * delegate from it.
 *
 * The parent is a real `orca serve` over a workspace that carries the app's first-run claim, as
 * the desktop app launches its bundled daemon: the launch capability in `ORCA_FIRST_RUN_LAUNCH`,
 * the claim bound to it, the config's bytes and this boot. Its first-run fence refuses
 * `orca remote enroll` from the CLI, as before. The daemon itself, which holds the fence,
 * enrolls through `remotes.enroll`, and a delegated step then runs exactly once on the worker
 * and reports back. The worker is reached over a throwaway loopback sshd, as a remote machine
 * would be (skipped without `/usr/sbin/sshd` unless `ORCA_REQUIRE_SSHD=1`).
 *
 * Needs `pnpm run build` (it runs the compiled CLI); CI builds before it tests.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceBoot, fenceDirectory, fenceHash, fenceWrite } from "@orca/protocol/first-run-fence";
import { RemotesListResultSchema, type RemotesListResult } from "@orca/protocol";
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

/**
 * The claim the desktop app writes before it launches its daemon for a first-run workspace
 * (`packages/app/src/main/first-run/ownership.ts`): the anchor beside the config, and one attempt
 * whose claim binds the launch capability, the config's bytes, the workspace and this boot.
 */
function firstRunClaim(dir: string, launch: string): void {
  const journal = join(dir, ".orca-first-run-ownership");
  mkdirSync(journal, { mode: 0o700 });
  const workspace = fenceDirectory(dir);
  fenceWrite(join(dir, ".orca-first-run-ownership.json"), {
    version: 1,
    workspace,
    journal: fenceDirectory(journal),
  });
  const attempt = join(journal, "000001");
  mkdirSync(attempt, { mode: 0o700 });
  fenceWrite(join(attempt, "claim.json"), {
    version: 2,
    reservationId: randomUUID(),
    workspace,
    configHash: fenceHash(readFileSync(join(dir, "orca.config.yaml"), "utf8")),
    previous: null,
    launchHash: fenceHash(launch),
    fence: "kernel-lifetime-v1",
    boot: fenceBoot(),
    store: null,
  });
}

const WORK = (id: string) => `
id: ${id}
name: ${id}
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
`;

async function worker(): Promise<TestDaemon> {
  const wf = await mkdtemp(join(tmpdir(), "orca-1206-worker-wf-"));
  dirs.push(wf);
  writeFileSync(join(wf, "build.yaml"), WORK("build"));
  writeFileSync(join(wf, "build-saved.yaml"), WORK("build-saved"));
  const playbook = { kinds: { report: [{ data: { status: "done" }, body: "Worker report for: {prompt}" }] } };
  const agent = {
    id: "scripted",
    command: process.execPath,
    args: [SCRIPTED],
    env: { ORCA_PLAYBOOK_JSON: JSON.stringify(playbook) },
    permissions: { default: "allow" },
  };
  return startTestDaemon({
    name: "worker-1206",
    config: JSON.stringify({ version: 1, workflows: [join(wf, "*.yaml")], templates: [], agents: [agent] }),
  });
}

async function call(daemon: TestDaemon, method: string, params: unknown): Promise<Record<string, unknown>> {
  const answer = await daemon.call(method, params);
  if (!answer.ok) throw new Error(`${method}: ${answer.error.code}: ${answer.error.message}`);
  return answer.result as Record<string, unknown>;
}

async function admit(daemon: TestDaemon, workflowId: string, vars: Record<string, unknown>): Promise<string> {
  const params = { workflowId, vars, idempotencyKey: randomUUID() };
  for (let attempt = 1; ; attempt++) {
    const answer = await daemon.call("runs.admit", params);
    if (!answer.ok && answer.error.code === "STORE_LOCK_TIMEOUT" && attempt < 20) {
      await new Promise((r) => setTimeout(r, 100 * attempt));
      continue;
    }
    if (!answer.ok) throw new Error(`runs.admit: ${answer.error.code}: ${answer.error.message}`);
    const receipt = answer.result as Record<string, unknown>;
    if (receipt.state !== "accepted") throw new Error(`not admitted: ${JSON.stringify(receipt)}`);
    return receipt.runId as string;
  }
}

async function finished(daemon: TestDaemon, runId: string): Promise<{ status: string; error?: unknown }> {
  const end = Date.now() + 90_000;
  for (;;) {
    const answer = await daemon.call("runs.get", { runId });
    if (answer.ok) {
      const run = (answer.result as { run: { status: string; error?: unknown } }).run;
      if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    } else if (answer.error.code !== "RUN_STATE") throw new Error(`runs.get: ${answer.error.message}`);
    if (Date.now() > end) throw new Error(`timed out waiting for run ${runId}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("enrolling a remote for a workspace the desktop app set up (#1206)", () => {
  let sshd: LoopbackSshd | undefined;
  let remote: TestDaemon;
  let parent: TestDaemon;

  beforeAll(async () => {
    // The fixture key runs what the client asked for, as a login shell would: the worker's
    // ORCA CLI, which issues the parent's credential during enrollment.
    const bin = await mkdtemp(join(tmpdir(), "orca-1206-bin-"));
    dirs.push(bin);
    const shell = join(bin, "shell");
    writeFileSync(
      shell,
      '#!/bin/sh\n[ -n "$SSH_ORIGINAL_COMMAND" ] || exit 0\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n',
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "orca"), `#!/bin/sh\nexec '${process.execPath}' '${CLI_ENTRY}' "$@"\n`, { mode: 0o755 });
    sshd = await loopbackSshd({ forcedCommand: shell });
    if (!sshd) return;
    remote = await worker();
    const parentWorkflows = await mkdtemp(join(tmpdir(), "orca-1206-parent-wf-"));
    dirs.push(parentWorkflows);
    for (const [id, agent] of [
      ["delegate", "builder"],
      ["delegate-saved", "saved-builder"],
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
    agent: { id: ${agent} }
    prompt: "Build {{ vars.target }}"
    produces:
      - { kind: report, name: report, path: "delegated/report.md" }
  done: { type: end }
edges:
  - { from: s, to: hand }
  - { from: hand, to: done }
`,
      );
    const route = {
      destination: `${userInfo().username}@127.0.0.1`,
      sshPort: sshd.port,
      identityFile: sshd.identity,
      remotePort: remote.port,
    };
    const launch = randomUUID();
    parent = await startTestDaemon({
      name: "app-parent-1206",
      config: JSON.stringify({
        version: 1,
        workflows: [join(parentWorkflows, "*.yaml")],
        templates: [],
        remotes: [
          // Enrollment has the worker issue the credential over ssh.
          {
            id: "build-box",
            name: "Build box",
            ...route,
            serverCommand: join(bin, "orca"),
            serverConfig: join(remote.dir, "orca.config.yaml"),
          },
          // Enrollment takes a credential the worker issued and the person pasted.
          { id: "saved-box", name: "Saved box", ...route },
        ],
        agents: [
          { id: "builder", type: "orca-daemon", profile: "build-box", workflow: "build" },
          { id: "saved-builder", type: "orca-daemon", profile: "saved-box", workflow: "build-saved" },
        ],
      }),
      prepare: (dir) => firstRunClaim(dir, launch),
      env: { ORCA_FIRST_RUN_LAUNCH: launch },
    });
  }, 120_000);

  afterAll(async () => {
    await parent?.close();
    await remote?.close();
    await sshd?.close();
  });

  const list = async (): Promise<RemotesListResult> =>
    RemotesListResultSchema.parse(await call(parent, "remotes.list", {}));
  const remotesDir = () => join(parent.dir, "auth", "remotes");

  it("is a first-run workspace whose fence still refuses `orca remote enroll` from the CLI", (ctx) => {
    if (!sshd) return ctx.skip();
    // The daemon holds the writer fence: its attempt has a writer record.
    expect(existsSync(join(parent.dir, ".orca-first-run-ownership", "000001", "writer.json"))).toBe(true);
    const out = spawnSync(
      process.execPath,
      [CLI_ENTRY, "remote", "enroll", "build-box", "--host-key", sshd.hostKeyFingerprint],
      {
        cwd: parent.dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: join(parent.dir, "..", "home") },
      },
    );
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("First-run mutation requires owned daemon admission");
    // The refusal names the route that is admitted.
    expect(out.stderr).toContain("Remote daemons");
    expect(existsSync(join(remotesDir(), "build-box.json"))).toBe(false);
  });

  it("lists the configured remotes, none enrolled, and offers the enrollment methods in hello", async (ctx) => {
    if (!sshd) return ctx.skip();
    const hello = await call(parent, "hello", { client: "test", protocol: { major: 2, minor: 13 } });
    expect(hello.methods).toEqual(expect.arrayContaining(["remotes.list", "remotes.enroll"]));
    const listed = await list();
    expect(listed.canIssue).toBe(process.platform !== "win32");
    expect(listed.remotes.map((r) => [r.id, r.enrollment.state, r.workflows])).toEqual([
      ["build-box", "none", ["build"]],
      ["saved-box", "none", ["build-saved"]],
    ]);
    expect(listed.remotes[0]).toMatchObject({ pinned: [], credentialSaved: false, destination: expect.any(String) });
  });

  it("refuses a host key nobody vouched for, and a wrong one, before sending anything", async (ctx) => {
    if (!sshd) return ctx.skip();
    const blind = await parent.call("remotes.enroll", { id: "build-box" });
    expect(blind).toMatchObject({ ok: false, error: { code: "DELEGATION_REFUSED" } });
    expect(blind.ok ? "" : blind.error.message).toContain("no pinned host key");
    const wrong = await parent.call("remotes.enroll", { id: "build-box", hostKeys: [`SHA256:${"A".repeat(43)}`] });
    expect(wrong).toMatchObject({ ok: false, error: { code: "DELEGATION_REFUSED" } });
    expect(wrong.ok ? "" : wrong.error.message).toContain("not a fingerprint you gave");
    expect(existsSync(join(remotesDir(), "build-box.json"))).toBe(false);
    expect(existsSync(join(remotesDir(), "build-box.known_hosts"))).toBe(false);
    expect((await list()).remotes[0]!.enrollment.state).toBe("none");
  });

  it("enrolls through the daemon that owns the workspace: pins the key and has the worker issue the credential", async (ctx) => {
    if (!sshd) return ctx.skip();
    const enrolled = await call(parent, "remotes.enroll", { id: "build-box", hostKeys: [sshd.hostKeyFingerprint] });
    const parentWorkspace = ((await call(parent, "operator.discover", {})).target as { workspaceId: string })
      .workspaceId;
    expect(enrolled).toMatchObject({
      warnings: [],
      remote: {
        id: "build-box",
        pinned: [sshd.hostKeyFingerprint],
        enrollment: {
          state: "enrolled",
          issued: true,
          routeCurrent: true,
          principalId: `delegate-${parentWorkspace}`,
          workspaceId: expect.any(String),
        },
      },
    });
    // No secret crosses back: the answer names the credential's id only.
    const record = JSON.parse(readFileSync(join(remotesDir(), "build-box.json"), "utf8")) as {
      tokenFile: string;
      credentialId: string;
    };
    const token = readFileSync(join(remotesDir(), record.tokenFile), "utf8").trim();
    expect(JSON.stringify(enrolled)).not.toContain(token.split(".")[2]);
    expect(statSync(join(remotesDir(), record.tokenFile)).mode & 0o777).toBe(0o600);
    // The enrollment is in the parent's audit log as a mutation naming the remote.
    const audit = readFileSync(join(parent.dir, "auth", "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { operation?: string; outcome?: string; target?: Record<string, string> });
    expect(audit.filter((r) => r.operation === "remotes.enroll").map((r) => [r.outcome, r.target?.id])).toEqual([
      ["failed", "build-box"],
      ["failed", "build-box"],
      ["succeeded", "build-box"],
    ]);
    expect(JSON.stringify(audit)).not.toContain(token.split(".")[2]);
  }, 60_000);

  it("then delegates: the step runs exactly once on the worker and its report comes back", async (ctx) => {
    if (!sshd) return ctx.skip();
    const runId = await admit(parent, "delegate", { target: "the app workspace" });
    expect(await finished(parent, runId)).toMatchObject({ status: "succeeded" });
    const { artifacts } = (await call(parent, "runs.get", { runId })) as unknown as {
      artifacts: { name: string; id: string }[];
    };
    const report = artifacts.find((a) => a.name === "report");
    expect(report).toBeDefined();
    const text = (await call(parent, "artifacts.get", { artifactId: report!.id })).text as string;
    expect(text).toContain("Worker report for: Build the app workspace");
    const runs = (await call(remote, "runs.list", {})).runs as { id: string; workflowId: string; status: string }[];
    const delegated = runs.filter((r) => r.workflowId === "build");
    expect(delegated).toHaveLength(1);
    expect(delegated[0]!.status).toBe("succeeded");
    const parentWorkspace = ((await call(parent, "operator.discover", {})).target as { workspaceId: string })
      .workspaceId;
    const run = (await call(remote, "runs.get", { runId: delegated[0]!.id })).run as {
      origin?: { workspaceId: string; runId: string };
    };
    expect(run.origin).toMatchObject({ workspaceId: parentWorkspace, runId });
  }, 120_000);

  it("enrolls with a credential the worker issued and the person pasted, saved for this user alone", async (ctx) => {
    if (!sshd) return ctx.skip();
    const issued = spawnSync(
      process.execPath,
      [CLI_ENTRY, "auth", "issue", "app-parent", "--preset", "client", "--json"],
      {
        cwd: remote.dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: join(remote.dir, "..", "home") },
      },
    );
    expect(issued.status, issued.stderr).toBe(0);
    const bad = await parent.call("remotes.enroll", {
      id: "saved-box",
      hostKeys: [sshd.hostKeyFingerprint],
      credential: "not a credential",
    });
    expect(bad).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(existsSync(join(remotesDir(), "saved-box.token"))).toBe(false);

    // The whole `--json` output, as the person copied it.
    const enrolled = await call(parent, "remotes.enroll", {
      id: "saved-box",
      hostKeys: [sshd.hostKeyFingerprint],
      credential: issued.stdout,
    });
    expect(enrolled).toMatchObject({
      remote: {
        id: "saved-box",
        credentialSaved: true,
        enrollment: { state: "enrolled", issued: false, principalId: "app-parent" },
      },
    });
    const token = (JSON.parse(issued.stdout) as { token: string }).token;
    expect(readFileSync(join(remotesDir(), "saved-box.token"), "utf8").trim()).toBe(token);
    expect(statSync(join(remotesDir(), "saved-box.token")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(enrolled)).not.toContain(token.split(".")[2]);

    const runId = await admit(parent, "delegate-saved", { target: "with a saved credential" });
    expect(await finished(parent, runId)).toMatchObject({ status: "succeeded" });
    const runs = (await call(remote, "runs.list", {})).runs as { workflowId: string }[];
    expect(runs.filter((r) => r.workflowId === "build-saved")).toHaveLength(1);
  }, 120_000);

  it("refuses a remote the active configuration does not name", async (ctx) => {
    if (!sshd) return ctx.skip();
    const answer = await parent.call("remotes.enroll", { id: "nowhere", hostKeys: [sshd.hostKeyFingerprint] });
    expect(answer).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
  });
});
