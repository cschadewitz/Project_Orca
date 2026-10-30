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
import * as daemonTransport from "../../daemon/src/server.js";
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
it.each(["missing", "refusing", "hanging"] as const)(
  "%s standing reviewer disables Save while ordinary answers remain available",
  async (fault) => {
    const b = await bootstrap();
    for (const choice of (fault === "hanging" ? ["allow-once", "deny"] : ["save", "allow-once", "deny"]) as readonly (
      "save" | "allow-once" | "deny"
    )[]) {
      const c = await supervisor("connected", b.grant);
      Object.assign(c.options, { standingReviewerFault: fault });
      const dispatch = daemonTransport.dispatch;
      let selected: Awaited<ReturnType<typeof dispatch>> | undefined;
      const spy = vi.spyOn(daemonTransport, "dispatch").mockImplementation(async (text, ...rest) => {
        const request = JSON.parse(text) as { method: string; params: { choice?: string } };
        if (request.method === "scopedPermissions.choose") {
          request.params.choice = choice;
          selected = await dispatch(JSON.stringify(request), ...rest);
          return selected;
        }
        return dispatch(text, ...rest);
      });
      try {
        // This producer expects Save and intentionally stops after this substituted
        // answer. The actual authenticated bridge/owner records its real outcome.
        const error = await runControlledOwnedReadTest(c.base, "connected", c.options).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(Error);
        expect(selected, `${choice}: ${String(error)}`).toBeDefined();
        if (choice === "save") {
          if (selected?.ok) expect(selected.result).not.toMatchObject({ outcome: "saved" });
        } else {
          expect(selected?.ok).toBe(true);
          if (selected?.ok) expect(selected.result).toMatchObject({ outcome: "answered" });
        }
        const stores = fileStores(join(c.base, "workspace/.orca"));
        const answers = await stores.events.readTypes("controlled", ["human.answered"]);
        expect(answers.filter((event) => event.type === "human.answered").map((event) => event.payload.answer)).toEqual(
          choice === "save" ? [] : [choice === "deny" ? "deny" : "once"],
        );
        expect(await stores.events.readTypes("controlled", ["agent.permission"])).toEqual([]);
        expect(c.observed).toEqual([]);
      } finally {
        spy.mockRestore();
        c.restore();
      }
    }
  },
);

it("the saved standing grant qualifies a fresh action after the original action expires", async () => {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant);
  Object.assign(c.options, { ownerDurationMs: 300000 });
  const originalPhase = c.options.phase.bind(c.options);
  let expiredActionAt = 0;
  let advanced: ReturnType<typeof vi.spyOn> | undefined;
  c.options.phase = (name, work) =>
    originalPhase(name, async () => {
      if (name === "rule-read") {
        const stores = fileStores(join(c.base, "workspace/.orca"));
        const approved = (await stores.events.readTypes("controlled", ["agent.permission"]))[0]!;
        const payload = (await stores.execution.getPayload(
          "controlled",
          approved.executionPayloadRef!,
          "agent.permission",
        )) as {
          entry: {
            version: number;
            command: { rule: { version: number; expiresAt: null } };
            action: { expiresAt: string };
          };
        };
        expect(payload.entry.version).toBe(2);
        expect(payload.entry.command.rule).toMatchObject({ version: 2, expiresAt: null });
        expiredActionAt = Date.parse(payload.entry.action.expiresAt);
        const lease = await stores.leases.get("run:controlled");
        expect(lease!.guardedTtlMs).toBe(300000);
        expect(expiredActionAt + 1).toBeLessThan(Date.parse(lease!.renewedAt) + lease!.guardedTtlMs!);
        // Simulated clock transition, not a real elapsed-time/effect-proof claim.
        const realNow = Date.now.bind(Date);
        const advance = expiredActionAt + 1 - realNow();
        advanced = vi.spyOn(Date, "now").mockImplementation(() => realNow() + advance);
      }
      await work();
    });
  try {
    const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    const payload = (await stores.execution.getPayload("controlled", result.authorizationRefs[1]!, "agent.update")) as {
      update: { text: string };
    };
    const execution = JSON.parse(payload.update.text).value as {
      action: { expiresAt: string };
      verdict: { authorizedBy: { kind: string } };
    };
    expect(execution.verdict.authorizedBy.kind).toBe("rule");
    expect(Date.parse(execution.action.expiresAt)).toBeGreaterThan(expiredActionAt + 1);
    expect(c.observed.map((effect) => effect.phase)).toEqual(["human-read", "rule-read"]);
  } finally {
    advanced?.mockRestore();
  }
});

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
  // Budget the complete three-phase fixture separately from its unchanged
  // individual action and lease fences; do not remove a running fixture at 30s.
}, 60000);
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

it.each(["reviewer", "proof", "standing-proof", "actor"] as const)(
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
        if (fault === "proof" || fault === "standing-proof") {
          const saved = (await stores.events.readTypes("controlled", ["agent.permission"]))[0]!;
          const payload = (await stores.execution.getPayload(
            "controlled",
            saved.executionPayloadRef!,
            "agent.permission",
          )) as { entry: { persistenceReview: { sourceRefs: string[] }; standingReview: { sourceRefs: string[] } } };
          const path = join(
            storeDir,
            "private-execution",
            `${encodeURIComponent((fault === "proof" ? payload.entry.persistenceReview : payload.entry.standingReview).sourceRefs[0]!)}.payload.json`,
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
