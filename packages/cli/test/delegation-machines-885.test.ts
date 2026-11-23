/**
 * Cross-machine delegation, end to end, on separate machines (#885 phase 2).
 *
 * Three containers from the two-machine fixture, each a clean Ubuntu 24.04 with sshd and this
 * checkout's headless server bundle installed as a release ships it, on a private network:
 *
 * - `worker`: a daemon with `limits.maxAgentSessions: 2` and the workflows a parent delegates.
 * - `parent`: a daemon whose steps use `type: orca-daemon` agents on the remote `worker`,
 *   reached as `orca@worker` over the worker's sshd with the parent's own key.
 * - `second`: another parent sharing the same worker, for the capacity case.
 *
 * Each parent is enrolled the way an operator does it: `orca remote enroll` with the worker's
 * host key fingerprint, which issues the parent a scoped credential over ssh. Then:
 * delegation with the artifact brought back, a gate forwarded and answered, cancellation
 * reaching the worker, the network dropping under a running step and the step reattaching
 * without a second submission, and two parents never running more than the worker's cap.
 *
 * Runs only where `ORCA_TWO_MACHINES=1` (the Two daemons workflow's machines job); see
 * packages/testing/src/two-machines.ts. Needs `pnpm run build`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MACHINE_NODE,
  MACHINE_SCRIPTED_AGENT,
  MACHINE_WORKSPACE,
  startMachines,
  type Machine,
  type Machines,
} from "@orca/testing/two-machines";

const WORKFLOWS = `${MACHINE_WORKSPACE}/workflows`;

/** A one-step remote workflow run by `agent`, producing a report. */
const remoteWorkflow = (id: string, agent: string, gated = false) => `
id: ${id}
name: ${id}
start: s
nodes:
  s: { type: start }
${gated ? '  ask: { type: gate, question: "Ship the report?", options: [ship, hold] }\n  held: { type: end, outcome: failure }\n' : ""}  work:
    type: agent
    agent: { id: ${agent} }
    prompt: "{{ vars.prompt }}"
    produces:
      - { kind: report, name: report, path: "out/report.md" }
  done: { type: end }
edges:
${gated ? "  - { from: s, to: ask }\n  - { from: ask, to: work, when: \"choice == 'ship'\" }\n  - { from: ask, to: held, when: \"choice == 'hold'\" }\n" : "  - { from: s, to: work }\n"}  - { from: work, to: done }
`;

/** A parent workflow whose one step is delegated through `agent`. */
const parentWorkflow = (id: string, agent: string) => `
id: ${id}
name: ${id}
start: s
nodes:
  s: { type: start }
  hand:
    type: agent
    agent: { id: ${agent} }
    prompt: "Summarize the weather for {{ vars.city }}"
    produces:
      - { kind: report, name: report, path: "delegated/report.md" }
  done: { type: end }
edges:
  - { from: s, to: hand }
  - { from: hand, to: done }
`;

const scripted = (id: string, delayMs: number) => ({
  id,
  command: MACHINE_NODE,
  args: [MACHINE_SCRIPTED_AGENT],
  env: {
    ORCA_PLAYBOOK_JSON: JSON.stringify({
      kinds: { report: [{ data: { status: "done" }, body: "Remote report for: {prompt}", delayMs }] },
    }),
  },
  permissions: { default: "allow" },
});

const workerConfig = JSON.stringify({
  version: 1,
  workflows: [`${WORKFLOWS}/*.yaml`],
  templates: [],
  limits: { maxAgentSessions: 2 },
  agents: [scripted("quick", 0), scripted("slow", 1_500), scripted("long", 10_000)],
});

/** A parent's config: the worker as a remote, and one delegating agent per remote workflow. */
const parentConfig = JSON.stringify({
  version: 1,
  workflows: [`${WORKFLOWS}/*.yaml`],
  templates: [],
  remotes: [
    {
      id: "worker",
      name: "Worker",
      destination: "orca@worker",
      identityFile: "/home/orca/.ssh/id_ed25519",
      serverConfig: `${MACHINE_WORKSPACE}/orca.config.yaml`,
    },
  ],
  agents: [
    { id: "to-task", type: "orca-daemon", profile: "worker", workflow: "remote-task" },
    { id: "to-gated", type: "orca-daemon", profile: "worker", workflow: "remote-gated" },
    { id: "to-long", type: "orca-daemon", profile: "worker", workflow: "remote-long" },
    { id: "to-slow", type: "orca-daemon", profile: "worker", workflow: "remote-slow" },
  ],
});

async function call(machine: Machine, method: string, params: unknown): Promise<Record<string, unknown>> {
  const answer = await machine.call(method, params);
  if (!answer.ok) throw new Error(`${machine.name}: ${method}: ${answer.error.code}: ${answer.error.message}`);
  return answer.result as Record<string, unknown>;
}

type RunView = { id: string; workflowId: string; status: string; error?: unknown; origin?: { runId: string } };

/**
 * Admit a run as a client does. Admissions that arrive together contend for the daemon's
 * admission catalog, and one that cannot have it at once is refused with
 * `STORE_LOCK_TIMEOUT`; the client sends the same idempotency key again, which can only ever
 * admit the one run ([admission retry](../../../docs/admission-retry.md)).
 */
async function admit(machine: Machine, workflowId: string, vars: Record<string, unknown>): Promise<string> {
  const params = { workflowId, vars, idempotencyKey: crypto.randomUUID() };
  for (let attempt = 1; ; attempt++) {
    const answer = await machine.call("runs.admit", params);
    if (!answer.ok && answer.error.code === "STORE_LOCK_TIMEOUT" && attempt < 20) {
      await new Promise((r) => setTimeout(r, 100 * attempt));
      continue;
    }
    if (!answer.ok) throw new Error(`${machine.name}: runs.admit: ${answer.error.code}: ${answer.error.message}`);
    const receipt = answer.result as Record<string, unknown>;
    if (receipt.state !== "accepted") throw new Error(`not admitted: ${JSON.stringify(receipt)}`);
    return receipt.runId as string;
  }
}

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    // A read that races a write to the run's log is refused with RUN_STATE; read again.
    const value = await read().catch((error: unknown) => {
      if (String(error).includes("RUN_STATE")) return undefined;
      throw error;
    });
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const runOf = async (machine: Machine, runId: string) =>
  (await call(machine, "runs.get", { runId })) as unknown as {
    run: RunView;
    artifacts: { name: string; id: string }[];
  };

const finished = (machine: Machine, runId: string, ms?: number) =>
  until(
    `run ${runId} on ${machine.name} to finish`,
    async () => {
      const { run } = await runOf(machine, runId);
      return ["succeeded", "failed", "cancelled"].includes(run.status) ? run : undefined;
    },
    ms,
  );

const runsOn = async (machine: Machine, workflowId: string) =>
  ((await call(machine, "runs.list", {})).runs as RunView[]).filter((r) => r.workflowId === workflowId);

/** `orca remote enroll worker` on a parent, trusting exactly the worker's host key. */
async function enroll(parent: Machine, worker: Machine): Promise<Record<string, unknown>> {
  const out = await parent.exec(
    [
      "sh",
      "-c",
      `cd ${MACHINE_WORKSPACE} && orca remote enroll worker --json --host-key "$1"`,
      "sh",
      worker.hostKeyFingerprint,
    ],
    { timeoutMs: 120_000 },
  );
  if (out.status !== 0) throw new Error(`enroll on ${parent.name} failed: ${out.stderr}`);
  return JSON.parse(out.stdout) as Record<string, unknown>;
}

describe("delegation between machines over ssh (#885)", () => {
  let machines: Machines | undefined;
  let worker: Machine;
  let parent: Machine;
  let second: Machine;

  beforeAll(async () => {
    machines = await startMachines(["worker", "parent", "second"]);
    if (!machines) return;
    worker = machines.machines.worker!;
    parent = machines.machines.parent!;
    second = machines.machines.second!;
    await worker.serve(workerConfig, {
      "workflows/remote-task.yaml": remoteWorkflow("remote-task", "quick"),
      "workflows/remote-gated.yaml": remoteWorkflow("remote-gated", "quick", true),
      "workflows/remote-long.yaml": remoteWorkflow("remote-long", "long"),
      "workflows/remote-slow.yaml": remoteWorkflow("remote-slow", "slow"),
    });
    for (const p of [parent, second]) {
      await machines.authorize(p.name, "worker");
      await p.serve(parentConfig, {
        "workflows/delegate.yaml": parentWorkflow("delegate", "to-task"),
        "workflows/delegate-gated.yaml": parentWorkflow("delegate-gated", "to-gated"),
        "workflows/delegate-long.yaml": parentWorkflow("delegate-long", "to-long"),
        "workflows/fan.yaml": parentWorkflow("fan", "to-slow"),
      });
    }
  }, 900_000);

  afterAll(async () => {
    await machines?.close();
  }, 60_000);

  it("enrolls each parent with a credential the worker issues over ssh, pinned to its host key", async (ctx) => {
    if (!machines) return ctx.skip();
    const discovered = (await call(worker, "operator.discover", {})).target as { workspaceId: string };
    for (const p of [parent, second]) {
      const record = await enroll(p, worker);
      const workspace = ((await call(p, "operator.discover", {})).target as { workspaceId: string }).workspaceId;
      expect(record).toMatchObject({
        profile: "worker",
        workspaceId: discovered.workspaceId,
        issued: true,
        principalId: `delegate-${workspace}`,
      });
      // The known_hosts the enrollment pinned holds the worker's key, and the parent's own
      // ~/.ssh/known_hosts was never touched (no trust on first use).
      const pinned = await p.exec(["cat", `${MACHINE_WORKSPACE}/auth/remotes/worker.known_hosts`]);
      expect(pinned.stdout).toMatch(/ssh-ed25519/);
      expect((await p.exec(["test", "-e", "/home/orca/.ssh/known_hosts"])).status).not.toBe(0);
    }
  }, 300_000);

  it("runs a parent step as a run on the worker and brings its artifact back", async (ctx) => {
    if (!machines) return ctx.skip();
    const runId = await admit(parent, "delegate", { city: "Lisbon" });
    expect(await finished(parent, runId)).toMatchObject({ status: "succeeded" });
    const { artifacts } = await runOf(parent, runId);
    const report = artifacts.find((a) => a.name === "report");
    expect(report).toBeDefined();
    const text = (await call(parent, "artifacts.get", { artifactId: report!.id })).text as string;
    expect(text).toContain("Remote report for: Summarize the weather for Lisbon");
    // The work is the worker's own run, stating the parent run as its origin.
    const delegated = await runsOn(worker, "remote-task");
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toMatchObject({ status: "succeeded" });
    const remoteRun = (await call(worker, "runs.get", { runId: delegated[0]!.id })).run as RunView;
    expect(remoteRun.origin).toMatchObject({ runId });
  }, 180_000);

  it("forwards the worker's gate to the parent and sends the answer back", async (ctx) => {
    if (!machines) return ctx.skip();
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
    expect(await runsOn(worker, "remote-gated")).toEqual([expect.objectContaining({ status: "succeeded" })]);
  }, 180_000);

  it("cancels the worker's run when the parent run is cancelled", async (ctx) => {
    if (!machines) return ctx.skip();
    const runId = await admit(parent, "delegate-gated", { city: "Rome" });
    await until("the forwarded question", async () => {
      const open = (await call(parent, "inputs.list", { runId })).inputs as unknown[];
      return open.length ? open : undefined;
    });
    const remoteRun = await until("the worker's run", async () =>
      (await runsOn(worker, "remote-gated")).find((r) => r.status !== "succeeded"),
    );
    await call(parent, "runs.cancel", { runId, reason: "test" });
    expect(await finished(parent, runId)).toMatchObject({ status: "cancelled" });
    expect(await finished(worker, remoteRun.id)).toMatchObject({ status: "cancelled" });
  }, 180_000);

  it("reattaches to the same worker run after the parent loses the network mid-step", async (ctx) => {
    if (!machines) return ctx.skip();
    const runId = await admit(parent, "delegate-long", { city: "Tromsø" });
    const remoteRun = await until("the worker's run to start", async () =>
      (await runsOn(worker, "remote-long")).find((r) => r.status === "running"),
    );
    // The parent drops off the network and its tunnel dies with it; while it is away, any
    // reconnect it tries fails. Then it comes back.
    await machines.disconnect("parent");
    await parent.exec(["pkill", "-x", "ssh"]);
    await new Promise((r) => setTimeout(r, 4_000));
    await machines.reconnect("parent");
    expect(await finished(parent, runId, 120_000)).toMatchObject({ status: "succeeded" });
    // Exactly one run on the worker: the same one, never submitted a second time.
    const runs = await runsOn(worker, "remote-long");
    expect(runs.map((r) => r.id)).toEqual([remoteRun.id]);
    expect(runs[0]).toMatchObject({ status: "succeeded" });
    const { artifacts } = await runOf(parent, runId);
    expect(artifacts.some((a) => a.name === "report")).toBe(true);
  }, 240_000);

  it("never runs more than the worker's two sessions for two parents together, holding the rest", async (ctx) => {
    if (!machines) return ctx.skip();
    // Watch the worker's own sessions from inside it while the work overlaps.
    await worker.exec(["rm", "-f", "/tmp/orca-peak.stop"]);
    const peak = worker.exec([MACHINE_NODE, "/opt/orca-test/rpc.mjs", "--peak"], { timeoutMs: 240_000 });
    const runs = await Promise.all([
      ...["Oslo", "Bergen", "Tromsø"].map(async (city) => ({
        machine: parent,
        runId: await admit(parent, "fan", { city }),
      })),
      ...["Alta", "Bodø"].map(async (city) => ({ machine: second, runId: await admit(second, "fan", { city }) })),
    ]);
    const done = await Promise.all(runs.map(({ machine, runId }) => finished(machine, runId, 180_000)));
    await worker.exec(["touch", "/tmp/orca-peak.stop"]);
    const watched = await peak;
    expect(watched.status, watched.stderr).toBe(0);
    expect(done.map((r) => r.status)).toEqual(Array(5).fill("succeeded"));
    expect(Number(watched.stdout.trim())).toBe(2);
    // The fanning parent held its third step itself, saying which remote was full.
    const waits: string[] = [];
    for (const { machine, runId } of runs.filter((r) => r.machine === parent)) {
      const { events } = (await call(machine, "runs.events", { runId, limit: 200 })) as unknown as {
        events: { type: string; payload: { on?: string; detail?: string } }[];
      };
      for (const e of events)
        if (e.type === "step.waiting" && e.payload.on === "agent-slot") waits.push(e.payload.detail ?? "");
    }
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((w) => w.includes("on remote worker"))).toBe(true);
  }, 300_000);
});
