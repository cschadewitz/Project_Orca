import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import { fileStores } from "@orca/store";
import {
  publishAdmissionExecutionPolicy,
  readAdmissionExecutionStatus,
  requireAdmissionExecutionPolicy,
} from "../src/admission-execution.js";
import { actor, admissionRuntime } from "./admission-execution-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function diskFixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-first-admission-"));
  directories.push(dir);
  return { dir, ...(await admissionRuntime(fileStores(dir))) };
}
const attemptKey = (runId: string) => `admission-execution-attempt:${runId}`;
const witnessKey = (runId: string) => `admission-execution-start:${runId}`;
const policyKey = (runId: string) => `admission-execution-policy:${runId}`;
const privateFile = (dir: string, id: string) =>
  join(dir, "private-execution", `${encodeURIComponent(id)}.generation.json`);

it("ordinary non-admitted runs keep their normal execution and continuation behavior", async () => {
  const f = await diskFixture();
  f.orc.admissionExecution = undefined;
  const runId = await f.orc.startRun({ workflowId: "admission-fence" });
  expect(await readAdmissionExecutionStatus(f.stores, runId)).toEqual({ state: "ordinary" });
  expect((await f.orc.run(runId)).run.status).toBe("paused");
  const input = (await f.orc.pendingInputs(runId))[0]!;
  await f.orc.answer(input.id, "go", runId);
  expect((await f.orc.resume(runId)).run.status).toBe("completed");
  expect(f.effects()).toBe(1);
});

it.each(["direct", "request"] as const)("ordinary run() refuses legacy %s admission without policy", async (kind) => {
  const f = await diskFixture();
  const { runId } = await f.admit(kind, false);
  expect(await readAdmissionExecutionStatus(f.stores, runId)).toEqual({ state: "unknown" });
  await expect(f.orc.run(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.effects()).toBe(0);
  expect(await f.stores.events.lastSeq(runId)).toBe(0);
});

it.each(["direct", "request"] as const)(
  "%s first start consumes evidence under the actual lease before effects",
  async (kind) => {
    const f = await diskFixture();
    const binding = await f.admit(kind);
    const authorize = vi.fn(async (policy) => {
      expect(policy.binding).toEqual(binding);
      const lease = await f.stores.leases.get(`run:${binding.runId}`);
      expect(lease?.holder).toBe(f.orc.leaseHolder);
    });
    f.orc.admissionExecution = { authorize };
    expect((await readAdmissionExecutionStatus(f.stores, binding.runId)).state).toBe("ready");
    expect((await f.orc.run(binding.runId)).run.status).toBe("paused");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(f.effects()).toBe(1);
    expect((await readAdmissionExecutionStatus(f.stores, binding.runId)).state).toBe("started");
    expect(await f.stores.execution.getGeneration(attemptKey(binding.runId))).toBeDefined();
    expect(await f.stores.execution.getGeneration(witnessKey(binding.runId))).toBeDefined();
    const input = (await f.orc.pendingInputs(binding.runId))[0]!;
    await f.orc.answer(input.id, "go", binding.runId, undefined, undefined, actor);
    expect((await f.orc.resume(binding.runId)).run.status).toBe("completed");
    expect(f.effects()).toBe(1);
    expect(await f.stores.events.readTypes(binding.runId, ["run.started"])).toHaveLength(1);
  },
);

it("does not nest the lease mutex when attaching a continuation to an admitted root", async () => {
  const f = await diskFixture();
  const { runId } = await f.admit();
  await f.orc.run(runId);
  const attached = await f.orc.attachContinuation(runId, { beforeExecute: async () => {} });
  expect((await attached.completion).run.status).toBe("paused");
  expect(f.effects()).toBe(1);
});

it("requires a trusted authority callback and rechecks current authority after durable start", async () => {
  const f = await diskFixture();
  const { runId } = await f.admit();
  f.orc.admissionExecution = undefined;
  await expect(f.orc.run(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await f.stores.execution.getGeneration(attemptKey(runId))).toBeUndefined();
  let checks = 0;
  f.orc.admissionExecution = {
    authorize: async () => {
      if (++checks === 2) throw new OrcaError("RUN_STATE", "authority revoked");
    },
  };
  await expect(f.orc.run(runId)).rejects.toThrow("authority revoked");
  expect(f.effects()).toBe(0);
  expect((await readAdmissionExecutionStatus(f.stores, runId)).state).toBe("started");
});

describe("crash boundaries fail closed", () => {
  it.each([
    "attempt-before",
    "attempt-after",
    "start-before",
    "start-after",
    "sync-before",
    "sync-after",
    "witness-before",
    "witness-after",
  ])("%s", async (boundary) => {
    const f = await diskFixture();
    const { runId } = await f.admit();
    const fail = () => {
      throw new Error("simulated process interruption");
    };
    const put = f.stores.execution.putGeneration.bind(f.stores.execution);
    const append = f.stores.events.append.bind(f.stores.events);
    const sync = f.stores.events.synchronizeEvent!.bind(f.stores.events);
    vi.spyOn(f.stores.execution, "putGeneration").mockImplementation(async (id, record) => {
      const target = boundary.startsWith("attempt")
        ? attemptKey(runId)
        : boundary.startsWith("witness")
          ? witnessKey(runId)
          : undefined;
      if (id === target && boundary.endsWith("before")) fail();
      await put(id, record);
      if (id === target && boundary.endsWith("after")) fail();
    });
    vi.spyOn(f.stores.events, "append").mockImplementation(async (event) => {
      if (event.type === "run.started" && boundary === "start-before") fail();
      const result = await append(event);
      if (event.type === "run.started" && boundary === "start-after") fail();
      return result;
    });
    vi.spyOn(f.stores.events, "synchronizeEvent").mockImplementation(async (event) => {
      if (event.type === "run.started" && boundary === "sync-before") fail();
      const result = await sync(event);
      if (event.type === "run.started" && boundary === "sync-after") fail();
      return result;
    });
    await expect(f.orc.run(runId)).rejects.toThrow("simulated process interruption");
    expect(f.effects()).toBe(0);
    vi.restoreAllMocks();
    const status = await readAdmissionExecutionStatus(f.stores, runId);
    if (boundary === "attempt-before" || boundary === "witness-after") {
      expect(status.state).toBe(boundary === "attempt-before" ? "ready" : "started");
      if (boundary === "witness-after") {
        await expect(f.orc.run(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
        expect((await f.orc.resume(runId)).run.status).toBe("paused");
      } else expect((await f.orc.run(runId)).run.status).toBe("paused");
      expect(f.effects()).toBe(1);
    } else {
      expect(status.state).toBe("blocked");
      const before = await f.stores.events.read(runId);
      await expect(f.orc.run(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
      expect(await f.stores.events.read(runId)).toEqual(before);
      expect(f.effects()).toBe(0);
    }
  });
});

it.each([
  "rewound-start",
  "substituted-start",
  "missing-attempt",
  "missing-witness",
  "missing-policy",
  "missing-generation",
  "changed-key",
])("refuses %s after reopening without recreating evidence", async (change) => {
  const f = await diskFixture();
  const binding = await f.admit();
  await f.orc.run(binding.runId);
  const file = join(f.dir, "runs", `${binding.runId}.jsonl`);
  const events = (await readFile(file, "utf8")).trim().split("\n");
  if (change === "rewound-start") await writeFile(file, `${events[0]}\n`);
  else if (change === "substituted-start") {
    const started = JSON.parse(events[1]!) as { id: string };
    started.id += "-substituted";
    events[1] = JSON.stringify(started);
    await writeFile(file, `${events.join("\n")}\n`);
  } else if (change === "changed-key")
    await writeFile(join(f.dir, "private-execution", ".execution-key"), Buffer.alloc(32, 13));
  else {
    const id =
      change === "missing-attempt"
        ? attemptKey(binding.runId)
        : change === "missing-witness"
          ? witnessKey(binding.runId)
          : change === "missing-policy"
            ? policyKey(binding.runId)
            : binding.generationId;
    await rm(privateFile(f.dir, id));
  }
  const stores = fileStores(f.dir);
  // Do not initialize a new generation after intentionally corrupting the shared key.
  const next = change === "changed-key" ? f : await admissionRuntime(stores);
  await expect(next.orc.run(binding.runId)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(next.effects()).toBe(change === "changed-key" ? 1 : 0);
  if (change !== "changed-key")
    expect((await readAdmissionExecutionStatus(stores, binding.runId)).state).not.toBe("ready");
});

it("policy publication and verification bind exact generation, workflow, principal and root", async () => {
  const f = await diskFixture();
  const binding = await f.admit("direct", false);
  for (const altered of [
    { ...binding, generationId: "wrong" },
    { ...binding, workflow: { ...binding.workflow, revision: "wrong" } },
    { ...binding, actor: { ...actor, principalId: "other" } },
    { ...binding, admissionId: "wrong" },
    { ...binding, requestId: "wrong" },
  ])
    await expect(publishAdmissionExecutionPolicy(f.stores, altered)).rejects.toMatchObject({ code: "RUN_STATE" });
  await publishAdmissionExecutionPolicy(f.stores, binding);
  await expect(publishAdmissionExecutionPolicy(f.stores, binding)).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(requireAdmissionExecutionPolicy(f.stores, { ...binding, workspaceId: "other" })).rejects.toMatchObject({
    code: "RUN_STATE",
  });
});

it("refuses a missing exact-event synchronization capability", async () => {
  const f = await diskFixture();
  const binding = await f.admit();
  delete f.stores.events.synchronizeEvent;
  Object.defineProperty(f.stores.events, "synchronizeEvent", { value: undefined, configurable: true });
  await expect(f.orc.run(binding.runId)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.effects()).toBe(0);
});

it("two independent processes racing the same admitted root execute its effect once", async () => {
  const f = await diskFixture();
  const { runId } = await f.admit();
  const effectFile = join(f.dir, "effect.log");
  const fixtureSource = new URL("./admission-execution-fixture.ts", import.meta.url).href;
  const storeSource = new URL("../../store/src/index.ts", import.meta.url).href;
  const script = `
    import { appendFile } from 'node:fs/promises';
    import { fileStores } from ${JSON.stringify(storeSource)};
    import { admissionRuntime } from ${JSON.stringify(fixtureSource)};
    const f = await admissionRuntime(fileStores(${JSON.stringify(f.dir)}), {
      effect: async () => { await appendFile(${JSON.stringify(effectFile)}, 'effect\\n'); await new Promise(r => setTimeout(r, 250)); }
    });
    try { await f.orc.run(${JSON.stringify(runId)}); process.stdout.write('attached'); }
    catch (error) { if (error.code !== 'RUN_LEASED') throw error; process.stdout.write('leased'); }
  `;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(errors))));
    });
  expect((await Promise.all([run(), run()])).sort()).toEqual(["attached", "leased"]);
  expect(await readFile(effectFile, "utf8")).toBe("effect\n");
  expect(await f.stores.events.readTypes(runId, ["run.started"])).toHaveLength(1);
}, 20_000);

it.each([
  "attempt-before",
  "attempt-after",
  "start-before",
  "start-after",
  "sync-before",
  "sync-after",
  "witness-before",
  "witness-after",
  "effect-after",
])(
  "actual process crash at %s cannot replay first attachment",
  async (boundary) => {
    const f = await diskFixture();
    const { runId } = await f.admit();
    const effectFile = join(f.dir, "crash-effects.log");
    const fixtureSource = new URL("./admission-execution-fixture.ts", import.meta.url).href;
    const storeSource = new URL("../../store/src/index.ts", import.meta.url).href;
    const script = `
    import { appendFile } from 'node:fs/promises';
    import { fileStores } from ${JSON.stringify(storeSource)};
    import { admissionRuntime } from ${JSON.stringify(fixtureSource)};
    const boundary = ${JSON.stringify(boundary)};
    const runId = ${JSON.stringify(runId)};
    const f = await admissionRuntime(fileStores(${JSON.stringify(f.dir)}), {
      effect: async () => {
        await appendFile(${JSON.stringify(effectFile)}, 'effect\\n');
        if (boundary === 'effect-after') process.exit(87);
      }
    });
    const put = f.stores.execution.putGeneration.bind(f.stores.execution);
    f.stores.execution.putGeneration = async (id, value) => {
      const type = id === 'admission-execution-attempt:' + runId ? 'attempt' : id === 'admission-execution-start:' + runId ? 'witness' : '';
      if (boundary === type + '-before') process.exit(87);
      await put(id, value);
      if (boundary === type + '-after') process.exit(87);
    };
    const append = f.stores.events.append.bind(f.stores.events);
    f.stores.events.append = async event => {
      if (event.type === 'run.started' && boundary === 'start-before') process.exit(87);
      const result = await append(event);
      if (event.type === 'run.started' && boundary === 'start-after') process.exit(87);
      return result;
    };
    const sync = f.stores.events.synchronizeEvent.bind(f.stores.events);
    f.stores.events.synchronizeEvent = async event => {
      if (event.type === 'run.started' && boundary === 'sync-before') process.exit(87);
      const result = await sync(event);
      if (event.type === 'run.started' && boundary === 'sync-after') process.exit(87);
      return result;
    };
    await f.orc.run(runId);
    throw new Error('Expected abrupt process termination');
  `;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (status) => (status === 87 ? resolve(status) : reject(new Error(errors))));
    });
    expect(code).toBe(87);
    const reopened = await admissionRuntime(fileStores(f.dir));
    const before = await reopened.stores.events.read(runId);
    if (boundary === "attempt-before") {
      expect((await readAdmissionExecutionStatus(reopened.stores, runId)).state).toBe("ready");
      expect((await reopened.orc.run(runId)).run.status).toBe("paused");
      expect(reopened.effects()).toBe(1);
    } else {
      expect((await readAdmissionExecutionStatus(reopened.stores, runId)).state).toBe(
        boundary === "witness-after" || boundary === "effect-after" ? "started" : "blocked",
      );
      await expect(reopened.orc.run(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
      expect(reopened.effects()).toBe(0);
      expect(await reopened.stores.events.read(runId)).toEqual(before);
    }
    expect(await readFile(effectFile, "utf8").catch(() => "")).toBe(boundary === "effect-after" ? "effect\n" : "");
  },
  15_000,
);

it("a generation changed under the same identity is refused before first-start effects", async () => {
  const f = await diskFixture();
  const binding = await f.admit();
  const get = f.stores.execution.getGeneration.bind(f.stores.execution);
  vi.spyOn(f.stores.execution, "getGeneration").mockImplementation(async (id) => {
    const value = await get(id);
    if (id !== binding.generationId) return value;
    return { ...(value as object), savedRevision: "replaced-generation" };
  });
  expect((await readAdmissionExecutionStatus(f.stores, binding.runId)).state).toBe("blocked");
  await expect(f.orc.run(binding.runId)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.effects()).toBe(0);
  expect(await get(attemptKey(binding.runId))).toBeUndefined();
});

it("admits an explicitly selected historical workflow independently of newer generation defaults and survives restart", async () => {
  const first = await diskFixture();
  const original = first.orc.resolveDefinition("admission-fence");
  expect(await first.stores.workflows.put(original)).toBe(true);
  const newer = await admissionRuntime(fileStores(first.dir), { workflowVersion: "2" });
  expect(newer.generations.current.snapshot.workflows).toMatchObject([{ id: original.id, version: "2" }]);
  const binding = await newer.admit("direct", true, "1");
  expect(binding.generationId).toBe(newer.generations.current.snapshot.id);
  expect(binding.workflow.version).toBe("1");
  expect((await requireAdmissionExecutionPolicy(newer.stores, binding)).binding).toEqual(binding);

  const restarted = await admissionRuntime(fileStores(first.dir), { workflowVersion: "3" });
  expect((await readAdmissionExecutionStatus(restarted.stores, binding.runId)).state).toBe("ready");
  const result = await restarted.orc.run(binding.runId);
  expect(result.run).toMatchObject({
    workflowVersion: "1",
    status: "paused",
    provenance: { configGeneration: binding.generationId, workflow: binding.workflow },
  });
  expect(restarted.effects()).toBe(1);
});

it.each(["missing", "changed"] as const)(
  "historical selection refuses a %s stored definition after restart instead of using the newer generation",
  async (change) => {
    const first = await diskFixture();
    const original = first.orc.resolveDefinition("admission-fence");
    await first.stores.workflows.put(original);
    const newer = await admissionRuntime(fileStores(first.dir), { workflowVersion: "2" });
    const binding = await newer.admit("direct", true, "1");
    const historicalFile = join(first.dir, "private-workflows", `${encodeURIComponent(original.id)}@v1.json`);
    await rm(historicalFile);
    if (change === "changed")
      // A fresh authenticated record at the same id/version still cannot replace the selected bytes.
      await fileStores(first.dir).workflows.put({ ...original, vars: { changedDefinition: true } });
    const restarted = await admissionRuntime(fileStores(first.dir), { workflowVersion: "3" });
    const before = await restarted.stores.events.read(binding.runId);
    await expect(requireAdmissionExecutionPolicy(restarted.stores, binding)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect((await readAdmissionExecutionStatus(restarted.stores, binding.runId)).state).toBe("blocked");
    await expect(restarted.orc.run(binding.runId)).rejects.toMatchObject({
      code: change === "missing" ? "WORKFLOW_VERSION_NOT_FOUND" : "RUN_STATE",
    });
    expect(restarted.effects()).toBe(0);
    expect(await restarted.stores.execution.getGeneration(attemptKey(binding.runId))).toBeUndefined();
    expect(await restarted.stores.events.read(binding.runId)).toEqual(before);
  },
);
