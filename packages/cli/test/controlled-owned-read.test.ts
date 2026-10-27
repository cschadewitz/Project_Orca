/** Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fileStores, FileExecutionStore } from "@orca/store";
import * as agents from "@orca/agents";
import type { ActionEvidenceV1, PolicyEvaluationV1, StrictPermissionRule } from "@orca/core";
import { resolveManagedRootBinding } from "../src/typed-workspace-gate.js";
import { runControlledOwnedReadTest, type ControlledReadTestSupervisor } from "./controlled-owned-read-producer.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const content = "disposable candidate bytes";
async function supervisor(
  lane: "bootstrap" | "connected",
  previous?: { evidenceRef: string; assertCurrent(): undefined },
  fault?: ControlledReadTestSupervisor["fault"],
) {
  const base = await mkdtemp(join(tmpdir(), "orca-controlled-test-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  for (const path of ["workspace", "workspace/.orca", "workspace/.orca/workspace-identity", "control", "releases"])
    await mkdir(join(base, path), { mode: 0o700 });
  const id = join(base, "workspace/.orca/workspace-identity/id");
  await writeFile(id, `${randomUUID()}\n`, { mode: 0o600 });
  const binding = resolveManagedRootBinding(
    [
      { role: "config", path: join(base, "workspace") },
      { role: "sidecar", path: join(base, "workspace/orca.permissions.json") },
      { role: "store", path: join(base, "workspace/.orca") },
    ],
    join(base, "control"),
    join(base, "releases"),
  );
  await writeFile(join(base, "control/never-typed"), `${digest(await readFile(id))}\n${binding.rootBindingRef}\n`, {
    mode: 0o600,
  });
  // A real supervisor-owned flock, not a boolean lifetime substitute.
  const lock = join(base, "lifetime.lock");
  const holder = spawn(
    "python3",
    [
      "-c",
      "import os,fcntl,sys\nf=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)\nfcntl.flock(f,fcntl.LOCK_EX)\nprint(f,flush=True)\nsys.stdin.read()",
      lock,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  cleanup.push(async () => {
    holder.stdin.end();
    if (holder.exitCode === null) await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  });
  const fd = await new Promise<number>((resolve, reject) => {
    holder.stdout.once("data", (b: Buffer) => resolve(Number(b.toString().trim())));
    holder.once("error", reject);
  });
  const identity = (path: string) => {
    const info = fs.lstatSync(path, { bigint: true });
    return [info.dev, info.ino, info.mode, info.uid, info.gid].join(":");
  };
  const originals = new Map(
    [
      base,
      ...[
        "workspace",
        "workspace/.orca",
        "workspace/.orca/workspace-identity",
        "control",
        "releases",
        "lifetime.lock",
        "workspace/.orca/workspace-identity/id",
      ].map((p) => join(base, p)),
    ].map((path) => [path, identity(path)]),
  );
  const identityBytes = fs.readFileSync(id);
  const image = new URL("./controlled-owned-read-producer.ts", import.meta.url);
  const imageBytes = fs.readFileSync(image),
    imageStamp = identity(image.pathname);
  const phases: string[] = [],
    observed: { phase: string; offset: number; length: number; bytes: string }[] = [];
  let phase = "outside";
  const check = (): undefined => {
    assert.equal(holder.exitCode, null);
    assert.match(fs.readFileSync(`/proc/${holder.pid}/fdinfo/${fd}`, "utf8"), /FLOCK\s+ADVISORY\s+WRITE /);
    for (const [path, stamp] of originals) assert.equal(identity(path), stamp);
    assert.equal(digest(fs.readFileSync(id)), digest(identityBytes));
    assert.equal(identity(image.pathname), imageStamp);
    assert.equal(digest(fs.readFileSync(image)), digest(imageBytes));
    return undefined;
  };
  const originalRead = fs.readSync;
  const spy = vi.spyOn(fs, "readSync").mockImplementation(((
    descriptor: number,
    bytes: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const result = originalRead(descriptor, bytes, offset, length, position);
    const info = fs.fstatSync(descriptor);
    if (
      info.isFile() &&
      info.nlink === 0 &&
      info.size === Buffer.byteLength(content) &&
      (info.mode & 0o777) === 0o400
    ) {
      observed.push({
        phase,
        offset: position!,
        length,
        bytes: Buffer.from(bytes.buffer, bytes.byteOffset + offset, result).toString(),
      });
    }
    return result;
  }) as typeof fs.readSync);
  cleanup.push(async () => spy.mockRestore());
  const options: ControlledReadTestSupervisor = {
    content,
    offset: 2,
    length: 4,
    assertCurrent: check,
    ...(previous ? { bootstrap: previous } : {}),
    ...(fault ? { fault } : {}),
    phase: async (name, work) => {
      phases.push(name);
      phase = name;
      try {
        await work();
      } finally {
        phase = "outside";
      }
    },
  };
  return { base, lane, options, phases, observed, check, holder, image, originals, restore: () => spy.mockRestore() };
}
async function bootstrap() {
  const s = await supervisor("bootstrap");
  const result = await runControlledOwnedReadTest(s.base, "bootstrap", s.options);
  expect(s.observed).toEqual([{ phase: "bootstrap", offset: 2, length: 4, bytes: "spos" }]);
  expect(result.authorizationRefs).toHaveLength(1);
  s.restore();
  const ref = result.authorizationRefs[0]!;
  const protectedBytes = fs.readFileSync(
    join(s.base, "workspace/.orca/private-execution", `${encodeURIComponent(ref)}.payload.json`),
  );
  const grant = {
    evidenceRef: `test-supervisor-bootstrap:${digest(protectedBytes)}`,
    assertCurrent: (): undefined => {
      s.check();
      assert.equal(
        digest(
          fs.readFileSync(join(s.base, "workspace/.orca/private-execution", `${encodeURIComponent(ref)}.payload.json`)),
        ),
        digest(protectedBytes),
      );
      assert.deepEqual(s.observed, [{ phase: "bootstrap", offset: 2, length: 4, bytes: "spos" }]);
      return undefined;
    },
  };
  return { ...s, result, grant };
}
it("connects actual Save, separately settled original Allow once and fresh rule execution", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(c.observed).toEqual([
    { phase: "human-read", offset: 2, length: 4, bytes: "spos" },
    { phase: "rule-read", offset: 2, length: 4, bytes: "spos" },
  ]);
  expect(result.initialRevision).not.toBe(result.finalRevision);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  const records = await Promise.all(
    result.authorizationRefs.map((ref) => stores.execution.getPayload("controlled", ref, "agent.update")),
  );
  const values = records.map(
    (payload) =>
      JSON.parse((payload as { update: { text: string } }).update.text).value as {
        action: { invocation: { invocationId: string } };
        verdict: { authorizedBy: { kind: string; acceptedAnswerRef?: string } };
      },
  );
  expect(values.map((v) => v.verdict.authorizedBy.kind)).toEqual(["human", "rule"]);
  expect(values[0]!.action.invocation.invocationId).not.toBe(values[1]!.action.invocation.invocationId);
  const answers = await stores.events.readTypes("controlled", ["human.answered"]);
  expect(answers).toHaveLength(1);
  expect(values[0]!.verdict.authorizedBy.acceptedAnswerRef).toBe(JSON.stringify(["controlled", answers[0]!.id]));
  const approvals = await stores.events.readTypes("controlled", ["agent.permission"]);
  expect(approvals).toHaveLength(1);
  const approval = (await stores.execution.getPayload(
    "controlled",
    approvals[0]!.executionPayloadRef!,
    "agent.permission",
  )) as { entry: { requiredReview: string; persistenceReview: { result: string } } };
  expect(approval.entry.requiredReview).toBe("unavailable");
  expect(approval.entry.persistenceReview.result).toBe("passed");
}, 30000);
it.each(["review-proof", "reviewer-revoked", "stale-revision", "lost-ack", "cancel", "wrong-interval"] as const)(
  "refuses %s without an extra read",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant, fault);
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed.filter((r) => r.phase === "save")).toEqual([]);
    expect(c.observed.length).toBe(fault === "wrong-interval" ? 1 : 0);
  },
  30000,
);
it("refuses unknown bootstrap evidence before creating connected state", async () => {
  const c = await supervisor("connected");
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(c.phases).toEqual([]);
  expect(c.observed).toEqual([]);
});

it.each([false, true])(
  "awaits the genuine deferred final ack; lost=%s never grants read authority",
  async (lost) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant, lost ? "lost-ack" : undefined);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atAck = new Promise<void>((resolve) => {
      entered = resolve;
    });
    c.options.settleOriginalDelivery = async () => {
      entered();
      await gate;
    };
    const running = runControlledOwnedReadTest(c.base, "connected", c.options);
    void running.catch(() => undefined);
    await Promise.race([
      atAck,
      running.then(() => {
        throw new Error("Completed before deferred ack");
      }),
    ]);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    expect(await stores.events.readTypes("controlled", ["human.answered"])).toHaveLength(1);
    expect(c.observed).toEqual([]);
    let settled = false;
    void running
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    if (lost) {
      await expect(running).rejects.toThrow();
      expect(c.observed).toEqual([]);
    } else {
      await running;
      expect(c.observed.map((read) => read.phase)).toEqual(["human-read", "rule-read"]);
    }
  },
  30000,
);
it.each(["root", "lifetime"] as const)(
  "refuses actual changed %s after Save",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant);
    const original = c.options.phase.bind(c.options);
    c.options.phase = async (name, work) => {
      if (name === "human-read") {
        if (fault === "root") {
          const path = join(c.base, "workspace/.orca/workspace-identity/id"),
            bytes = await readFile(path);
          await fs.promises.rename(path, `${path}.old`);
          await writeFile(path, bytes, { mode: 0o600 });
        } else {
          c.holder.stdin.end();
          await new Promise<void>((resolve) => c.holder.once("exit", () => resolve()));
        }
      }
      return original(name, work);
    };
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed).toEqual([]);
  },
  30000,
);

it.each(["reviewer", "proof", "actor"] as const)(
  "authenticates saved %s again after Save",
  async (fault) => {
    const b = await bootstrap();
    const c = await supervisor("connected", b.grant);
    const original = c.options.phase.bind(c.options);
    c.options.phase = (name, work) =>
      original(name, async () => {
        await work();
        if (name !== "save") return;
        const storeDir = join(c.base, "workspace/.orca"),
          stores = fileStores(storeDir);
        if (fault === "proof") {
          const saved = (await stores.events.readTypes("controlled", ["agent.permission"]))[0]!;
          const payload = (await stores.execution.getPayload(
            "controlled",
            saved.executionPayloadRef!,
            "agent.permission",
          )) as { entry: { persistenceReview: { sourceRefs: string[] } } };
          const path = join(
            storeDir,
            "private-execution",
            `${encodeURIComponent(payload.entry.persistenceReview.sourceRefs[0]!)}.payload.json`,
          );
          const bytes = await readFile(path);
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
          await writeFile(path, bytes);
        } else {
          const { CredentialStore } = await import("../../daemon/src/auth/credentials.js");
          const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
          const target = credentials
            .list()
            .find((record) => record.principal === `controlled-test-${fault === "actor" ? "operator" : "reviewer"}`)!;
          expect(await credentials.revoke(target.id)).toBe(true);
        }
      });
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed).toEqual([]);
  },
  30000,
);

it("pins supervisor interval and callable capabilities before Save", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const original = c.options.phase.bind(c.options);
  c.options.phase = (name, work) =>
    original(name, async () => {
      await work();
      if (name === "save") {
        Object.assign(c.options, {
          offset: 3,
          length: 5,
          content: "replacement input",
          assertCurrent: () => {
            throw new Error("replacement callback");
          },
        });
      }
    });
  await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(c.observed.map(({ offset, length, bytes }) => ({ offset, length, bytes }))).toEqual([
    { offset: 2, length: 4, bytes: "spos" },
    { offset: 2, length: 4, bytes: "spos" },
  ]);
}, 30000);

function composedSupervisor(c: Awaited<ReturnType<typeof supervisor>>) {
  const events: string[] = [];
  const previous = c.options.bootstrap!;
  const physicalAssertion = function (this: ControlledReadTestSupervisor): undefined {
    expect(this).toBe(c.options);
    events.push("physical");
    return c.check();
  };
  const bootstrapAssertion = function (this: object): undefined {
    expect(this).toBe(bootstrap);
    events.push("bootstrap");
    assert.equal(physicalAssertion.call(c.options), undefined);
    return previous.assertCurrent();
  };
  const bootstrap = { evidenceRef: previous.evidenceRef, assertCurrent: bootstrapAssertion };
  const currentnessComposition = Object.freeze({
    kind: "connected-physical-bootstrap-v1" as const,
    physicalAssertion,
    bootstrap,
    bootstrapAssertion,
  });
  Object.assign(c.options, { assertCurrent: physicalAssertion, bootstrap, currentnessComposition });
  return { events, bootstrap, currentnessComposition };
}

it("selects the declared composition on every producer check with original receivers", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const composed = composedSupervisor(c);
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(result.authorizationRefs).toHaveLength(2);
  // Initial setup deliberately keeps its separate physical assertion. Every later
  // producer.check calls the bootstrap assertion, which includes physical exactly once.
  expect(composed.events.slice(0, 3)).toEqual(["physical", "bootstrap", "physical"]);
  expect(composed.events.length).toBeGreaterThan(3);
  expect(composed.events.length % 2).toBe(1);
  for (let i = 3; i < composed.events.length; i += 2)
    expect(composed.events.slice(i, i + 2)).toEqual(["bootstrap", "physical"]);
});

it("retains composition roles and bootstrap evidence before await despite later replacements", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const composed = composedSupervisor(c);
  const replacement = vi.fn((): never => {
    throw Error("replacement capability used");
  });
  const originalPhase = c.options.phase.bind(c.options);
  c.options.phase = (name, work) =>
    originalPhase(name, async () => {
      await work();
      if (name !== "save") return;
      Object.assign(composed.bootstrap, { evidenceRef: "replacement evidence", assertCurrent: replacement });
      Object.assign(c.options, {
        assertCurrent: replacement,
        bootstrap: { evidenceRef: "other bootstrap", assertCurrent: replacement },
        currentnessComposition: Object.freeze({}),
      });
    });
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(result.authorizationRefs).toHaveLength(2);
  expect(replacement).not.toHaveBeenCalled();
  expect(composed.events.filter((e) => e === "physical")).toHaveLength(
    composed.events.filter((e) => e === "bootstrap").length + 1,
  );
});

it.each(["physical", "bootstrap"] as const)(
  "composed %s mutation after success refuses the next check",
  async (role) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    const composed = composedSupervisor(c);
    const originalPhase = c.options.phase.bind(c.options);
    let successes = 0;
    c.options.phase = (name, work) =>
      originalPhase(name, async () => {
        await work();
        if (name !== "save") return;
        successes = composed.events.length;
        await fs.promises.appendFile(
          join(role === "physical" ? c.base : b.base, "workspace/.orca/workspace-identity/id"),
          "changed",
        );
      });
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(successes).toBeGreaterThan(3);
    expect(composed.events.length).toBeGreaterThan(successes);
    expect(c.observed).toEqual([]);
  },
);

it("legacy supervisors retain separate checks of their different workspaces", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  const physical = vi.fn(c.check),
    association = vi.fn(() => b.grant.assertCurrent());
  Object.assign(c.options, { assertCurrent: physical, bootstrap: { ...b.grant, assertCurrent: association } });
  const originalPhase = c.options.phase.bind(c.options);
  c.options.phase = (name, work) =>
    originalPhase(name, async () => {
      await work();
      if (name === "save")
        await fs.promises.appendFile(join(b.base, "workspace/.orca/workspace-identity/id"), "changed");
    });
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(physical.mock.calls.length).toBeGreaterThan(1);
  expect(association.mock.calls).toHaveLength(physical.mock.calls.length);
  expect(c.observed).toEqual([]);
});

it.each([
  "copied-physical",
  "substituted-physical",
  "copied-bootstrap",
  "substituted-bootstrap",
  "copied-assertion",
  "substituted-assertion",
  "unfrozen",
  "null",
  "wrong-kind",
  "missing",
  "extra",
  "getter",
  "symbol",
  "wrong-lane",
  "noncallable",
])("refuses supplied invalid %s composition before any callback or fallback", async (scenario) => {
  const physical = vi.fn(() => undefined),
    assertion = vi.fn(() => undefined);
  const bootstrap = { evidenceRef: "synthetic invalid selection only", assertCurrent: assertion };
  const phase = vi.fn(async () => {
    throw Error("invalid composition reached phase");
  });
  const options: ControlledReadTestSupervisor = {
    content,
    offset: 2,
    length: 4,
    assertCurrent: physical,
    bootstrap,
    phase,
  };
  const record: Record<string, unknown> = {
    kind: "connected-physical-bootstrap-v1",
    physicalAssertion: physical,
    bootstrap,
    bootstrapAssertion: assertion,
  };
  if (scenario === "copied-physical") record.physicalAssertion = physical.bind(options);
  if (scenario === "substituted-physical") record.physicalAssertion = () => undefined;
  if (scenario === "copied-bootstrap") record.bootstrap = { ...bootstrap };
  if (scenario === "substituted-bootstrap")
    record.bootstrap = { evidenceRef: bootstrap.evidenceRef, assertCurrent: () => undefined };
  if (scenario === "copied-assertion") record.bootstrapAssertion = assertion.bind(bootstrap);
  if (scenario === "substituted-assertion") record.bootstrapAssertion = () => undefined;
  if (scenario === "wrong-kind") record.kind = "bootstrap";
  if (scenario === "missing") delete record.bootstrapAssertion;
  if (scenario === "extra") record.extra = true;
  if (scenario === "getter")
    Object.defineProperty(record, "physicalAssertion", { get: () => physical, enumerable: true });
  if (scenario === "symbol") Object.defineProperty(record, Symbol("extra"), { value: true });
  if (scenario === "noncallable") {
    Object.assign(options, { assertCurrent: null });
    record.physicalAssertion = null;
  }
  Object.assign(options, {
    currentnessComposition: scenario === "null" ? null : scenario === "unfrozen" ? record : Object.freeze(record),
  });
  await expect(
    runControlledOwnedReadTest(
      "/unused-invalid-composition",
      scenario === "wrong-lane" ? "bootstrap" : "connected",
      options,
    ),
  ).rejects.toThrow();
  expect(physical).not.toHaveBeenCalled();
  expect(assertion).not.toHaveBeenCalled();
  expect(phase).not.toHaveBeenCalled();
});

it.each(["promise", "thenable", "true", "false", "throw"])(
  "composed execution refuses %s synchronously without a physical fallback",
  async (scenario) => {
    const c = await supervisor("connected");
    const physical = vi.fn(c.check);
    let calls = 0;
    const assertion = vi.fn((): undefined => {
      calls++;
      if (calls === 1) return physical(); // Preserve the initial setup success.
      if (scenario === "throw") throw Error("original composed failure");
      return (scenario === "promise"
        ? Promise.resolve(undefined)
        : scenario === "thenable"
          ? { then: () => undefined }
          : scenario === "true") as unknown as undefined;
    });
    const bootstrap = { evidenceRef: "synthetic synchronous selection only", assertCurrent: assertion };
    Object.assign(c.options, {
      assertCurrent: physical,
      bootstrap,
      currentnessComposition: Object.freeze({
        kind: "connected-physical-bootstrap-v1",
        physicalAssertion: physical,
        bootstrap,
        bootstrapAssertion: assertion,
      }),
    });
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow(
      scenario === "throw" ? "original composed failure" : undefined,
    );
    expect(assertion).toHaveBeenCalledTimes(2);
    expect(physical).toHaveBeenCalledTimes(2); // Initial physical + initial bootstrap; no fallback.
    expect(c.observed).toEqual([]);
  },
);
it.each(["policy", "lease"] as const)(
  "refuses actual changed protected %s after Save",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant);
    const original = c.options.phase.bind(c.options);
    c.options.phase = (name, work) =>
      original(name, async () => {
        await work();
        if (name !== "save") return;
        if (fault === "policy") await fs.promises.appendFile(join(c.base, "workspace/orca.permissions.json"), "\n");
        else await fileStores(join(c.base, "workspace/.orca")).leases.forceRelease("run:controlled");
      });
    await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
    expect(c.observed).toEqual([]);
  },
  30000,
);

// Regression based on the focused #744 reproduction at 3281740. This is an ordinary
// passing requirement: a fixture/setup exception is not evidence of revocation.
it("genuinely revokes the saved rule before the fresh canonical evaluation refuses it", async () => {
  const automatic: { action: ActionEvidenceV1; result: PolicyEvaluationV1 }[] = [];
  const createPolicy = agents.createStrictPolicyPort;
  // Record the unchanged result of the real strict policy; supply no replacement verdict.
  const evaluationSpy = vi.spyOn(agents, "createStrictPolicyPort").mockImplementation((options) => {
    const policy = createPolicy(options);
    return {
      ...policy,
      evaluate: async (action, signal) => {
        const result = await policy.evaluate(action, signal);
        if (action.invocation.invocationId === "controlled-rule-invocation") automatic.push({ action, result });
        return result;
      },
    };
  });
  cleanup.push(async () => evaluationSpy.mockRestore());
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant, "revoke-rule");
  let approvedRevision = "";
  const completed: string[] = [];
  const phase = c.options.phase.bind(c.options);
  c.options.phase = (name, work) =>
    phase(name, async () => {
      await work();
      completed.push(name);
      if (name === "save") approvedRevision = digest(await readFile(join(c.base, "workspace/orca.permissions.json")));
    });
  const error: unknown = await runControlledOwnedReadTest(c.base, "connected", c.options).then(
    () => {
      throw new Error("Revoked rule unexpectedly allowed a fresh execution");
    },
    (error: unknown) => error,
  );
  // Pin the origin before accepting refusal: the former error was the writer's
  // sidecar-lock exception and left an approved rule without a fresh evaluation.
  const sidecarBytes = await readFile(join(c.base, "workspace/orca.permissions.json"));
  const sidecar = JSON.parse(sidecarBytes.toString("utf8")) as {
    scopedRules: { records: { rule: StrictPermissionRule; approvalRecordRef: string }[] };
  };
  expect(sidecar.scopedRules.records.map((r) => r.rule.status)).toEqual(["revoked"]);
  expect(error).toBeInstanceOf(assert.AssertionError);
  expect((error as Error).message).toContain('result.verdict.outcome === "allow"');
  expect((error as Error).message).not.toContain("typed policy transition pending");
  expect(approvedRevision).not.toBe("");
  expect(digest(sidecarBytes)).not.toBe(approvedRevision);
  expect(automatic).toHaveLength(1);
  expect(automatic[0]!.result).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "required-policy-unavailable" },
  });
  expect(automatic[0]!.action.authority.currentPolicyRevision).toBe(digest(sidecarBytes));
  expect(c.phases).toEqual(["save", "human-read", "rule-read"]);
  expect(completed).toEqual(["save", "human-read"]);
  expect(c.observed).toEqual([{ phase: "human-read", offset: 2, length: 4, bytes: "spos" }]);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  const answers = await stores.events.readTypes("controlled", ["human.answered"]);
  expect(answers).toHaveLength(1);
  const approvals = await stores.events.readTypes("controlled", ["agent.permission"]);
  expect(approvals).toHaveLength(1);
  const saved = (await stores.execution.getPayload(
    "controlled",
    approvals[0]!.executionPayloadRef!,
    "agent.permission",
  )) as {
    entry: { command: { rule: StrictPermissionRule } };
  };
  const revoked = sidecar.scopedRules.records[0]!;
  expect(revoked.rule.ruleId).toBe(saved.entry.command.rule.ruleId);
  expect(revoked.rule.ruleRevision).not.toBe(saved.entry.command.rule.ruleRevision);
  expect(revoked.rule.ruleRevision).toBe(agents.strictPermissionRuleRevision(revoked.rule));
  const [revocationRun, revocationRef] = JSON.parse(revoked.approvalRecordRef) as [string, string];
  expect(revocationRun).toBe("controlled");
  const protectedRevocation = (await stores.execution.getPayload(revocationRun, revocationRef, "agent.update")) as {
    update: { text: string };
  };
  expect(JSON.parse(protectedRevocation.update.text)).toMatchObject({
    kind: "controlled-rule-revocation-v1",
    value: {
      command: { rule: revoked.rule, expectedRevision: approvedRevision, approvalRecordRef: revoked.approvalRecordRef },
    },
  });
  const authorizationKinds: string[] = [];
  for (const name of await fs.promises.readdir(join(c.base, "workspace/.orca/private-execution"))) {
    if (!name.startsWith("synthetic-read%3A") || !name.endsWith("%3Aevidence.payload.json")) continue;
    const ref = decodeURIComponent(name.slice(0, -".payload.json".length));
    const payload = (await stores.execution.getPayload("controlled", ref, "agent.update")) as {
      update: { text: string };
    };
    const record = JSON.parse(payload.update.text) as {
      kind: string;
      value: { verdict: { authorizedBy: { kind: string } } };
    };
    expect(record.kind).toBe("controlled-authorization-v1");
    authorizationKinds.push(record.value.verdict.authorizedBy.kind);
  }
  expect(authorizationKinds).toEqual(["human"]);
}, 60000);

it.each(["credential", "lease"] as const)(
  "revocation still refuses a genuinely lost %s authority",
  async (fault) => {
    const b = await bootstrap(),
      c = await supervisor("connected", b.grant, "revoke-rule");
    // Rebound to the actual receiver with call(this, ...) inside the interceptor.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const put = FileExecutionStore.prototype.putPayload;
    let injected = false;
    const proofWrite = vi.spyOn(FileExecutionStore.prototype, "putPayload").mockImplementation(async function (
      this: FileExecutionStore,
      ref,
      input,
    ) {
      await put.call(this, ref, input);
      if (
        input.type !== "agent.update" ||
        (input.payload.update as { kind?: unknown }).kind !== "controlled-rule-revocation-v1"
      )
        return;
      expect(injected).toBe(false);
      injected = true;
      if (fault === "lease") {
        expect(await fileStores(join(c.base, "workspace/.orca")).leases.forceRelease("run:controlled")).toBeDefined();
      } else {
        const { CredentialStore } = await import("../../daemon/src/auth/credentials.js");
        const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
        const actor = credentials.list().find((record) => record.principal === "controlled-test-operator")!;
        expect(await credentials.revoke(actor.id)).toBe(true);
      }
    });
    cleanup.push(async () => proofWrite.mockRestore());
    const error: unknown = await runControlledOwnedReadTest(c.base, "connected", c.options).then(
      () => {
        throw new Error("Lost authority unexpectedly published revocation");
      },
      (error: unknown) => error,
    );
    expect(injected).toBe(true);
    if (fault === "credential") {
      expect(error).toBeInstanceOf(assert.AssertionError);
      expect((error as Error).stack).toContain("currentCredential");
      const { CredentialStore } = await import("../../daemon/src/auth/credentials.js");
      const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
      const actor = credentials.list().find((record) => record.principal === "controlled-test-operator")!;
      expect(credentials.current(actor.id)).toMatchObject({ ok: false, reason: "revoked" });
    } else {
      expect(error).toMatchObject({ code: "RUN_LEASED" });
      expect(await fileStores(join(c.base, "workspace/.orca")).leases.get("run:controlled")).toBeUndefined();
    }
    const sidecar = JSON.parse(await readFile(join(c.base, "workspace/orca.permissions.json"), "utf8")) as {
      scopedRules: { records: { rule: { status: string } }[] };
    };
    expect(sidecar.scopedRules.records.map((r) => r.rule.status)).toEqual(["approved"]);
    expect(c.observed).toEqual([{ phase: "human-read", offset: 2, length: 4, bytes: "spos" }]);
  },
  60000,
);
