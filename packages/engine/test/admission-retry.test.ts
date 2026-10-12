import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OrcaError } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import type { RetryContext, RetryOperation, RetryRecord } from "../../core/src/model/admission-retry.js";
import { RegisteredRetryClaims, canonicalJson } from "../src/admission-retry.js";
import { RequestSubmissionService } from "../src/program/request-submission.js";
import { childCommand } from "./child-command.js";
import { submissionFixture } from "./request-submission-fixture.js";

/** The other process of the one test below that starts one: it claims a key and runs its operation. */
const childEntry = new URL("./admission-retry-child.ts", import.meta.url);
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const faults = {
  conflict: () => new OrcaError("RUN_STATE", "conflict", { retryReason: "conflict" }),
  limit: () => new OrcaError("RUN_STATE", "quota", { retryReason: "limit" }),
};
const authority = { principalId: "alice", workspaceId: "workspace", authorize: async (_command: unknown) => {} };
async function fixture(limit = 10_000) {
  const dir = await mkdtemp(join(tmpdir(), "orca-retry-"));
  directories.push(dir);
  const execution = new FileExecutionStore(dir);
  const store = new FileRetryClaimStore({
    storeDir: dir,
    execution,
    faults,
    limits: { maxClaimsPerPrincipal: limit },
    lockTimeoutMs: 30,
  });
  return { dir, execution, store, claims: new RegisteredRetryClaims(store, faults) };
}
function operation() {
  const prepare = vi.fn(async (_command: { value: string }, context: RetryContext) => {
    await context.bind({ admissionId: `admission-${context.operationId}` });
    return { admissionId: (await context.readBinding())!.admissionId };
  });
  const recover = vi.fn(async (_command: { value: string }, context: RetryContext) => ({
    admissionId: (await context.readBinding())!.admissionId,
  }));
  const op: RetryOperation<{ value: string }, { admissionId: unknown }> = {
    kind: "run.admit",
    canonicalize: (command) => ({ value: command.value }),
    prepare,
    recover,
  };
  return { op, prepare, recover };
}

describe("durable registered retry claims", () => {
  it("replays equivalent commands, conflicts without effects, isolates principals and workspaces", async () => {
    const { claims, store, dir } = await fixture();
    const { op, prepare } = operation();
    const registered = claims.register(op);
    const first = await claims.execute(registered, { value: "secret-input" }, { idempotencyKey: "same" }, authority);
    const replay = await claims.execute(registered, { value: "secret-input" }, { idempotencyKey: "same" }, authority);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(
      claims.execute(registered, { value: "changed" }, { idempotencyKey: "same" }, authority),
    ).rejects.toMatchObject({ details: { retryReason: "conflict" } });
    await expect(claims.inspect(first.operationId, { ...authority, principalId: "bob" })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    const other = await claims.execute(
      registered,
      { value: "secret-input" },
      { idempotencyKey: "same" },
      { ...authority, principalId: "bob" },
    );
    const workspace = await claims.execute(
      registered,
      { value: "secret-input" },
      { idempotencyKey: "same" },
      { ...authority, workspaceId: "elsewhere" },
    );
    expect(new Set([first.operationId, other.operationId, workspace.operationId]).size).toBe(3);
    const files = await readdir(join(dir, "admission-retries"));
    for (const file of files.filter((name) => name.endsWith(".json")))
      expect(await readFile(join(dir, "admission-retries", file), "utf8")).not.toContain("secret-input");
    expect((await store.batch()).length).toBe(3);
  });
  it("uses registered identity, reauthorizes replay and allows replay at full quota", async () => {
    const { claims } = await fixture(1);
    const { op } = operation();
    const registered = claims.register(op);
    await expect(claims.execute({ ...op }, { value: "a" }, {}, authority)).rejects.toMatchObject({ code: "RUN_STATE" });
    const first = await claims.execute(registered, { value: "a" }, { idempotencyKey: "k" }, authority);
    await expect(
      claims.execute(registered, { value: "a" }, { idempotencyKey: "new" }, authority),
    ).rejects.toMatchObject({ details: { retryReason: "limit" } });
    expect(await claims.execute(registered, { value: "a" }, { idempotencyKey: "k" }, authority)).toMatchObject({
      operationId: first.operationId,
    });
    const revoked = {
      ...authority,
      authorize: async () => {
        throw new OrcaError("RUN_STATE", "revoked");
      },
    };
    await expect(claims.execute(registered, { value: "a" }, { idempotencyKey: "k" }, revoked)).rejects.toThrow(
      "revoked",
    );
    await expect(claims.inspect(first.operationId, revoked)).rejects.toThrow("revoked");
    await expect(claims.reconcile(first.operationId, revoked)).rejects.toThrow("revoked");
  });
  it("bounds key bytes, JSON depth/size and never silently coerces values", async () => {
    const { claims, store } = await fixture();
    const { op } = operation();
    const registered = claims.register(op);
    for (const key of ["", "é".repeat(65)])
      await expect(
        claims.execute(registered, { value: "a" }, { idempotencyKey: key }, authority),
      ).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(() => canonicalJson({ token: "a".repeat(256 * 1024) })).toThrow();
    for (const value of [undefined, NaN, Infinity, new Date(), { x: undefined }, Array(2), { x: () => {} }, 1n])
      expect(() => canonicalJson(value)).toThrow();
    let deep: unknown = 1;
    for (let i = 0; i < 34; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow();
    expect(canonicalJson({ b: [2, 1], a: "é" })).toBe(canonicalJson({ a: "é", b: [2, 1] }));
    expect(canonicalJson({ a: "é" })).not.toBe(canonicalJson({ a: "é" }));
    expect(await store.batch()).toEqual([]);
  });
  it("returns bounded in-progress for a live owner and fences escaped contexts", async () => {
    const { claims } = await fixture();
    let release!: () => void;
    let bound!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      bound = r;
    });
    let escaped!: RetryContext;
    const { op } = operation();
    const registered = claims.register({
      ...op,
      prepare: async (_c, ctx) => {
        escaped = ctx;
        await ctx.bind({ id: "fixed" });
        bound();
        await waiting;
        return { admissionId: "fixed" };
      },
    });
    const first = claims.execute(registered, { value: "x" }, { idempotencyKey: "k" }, authority);
    await ready;
    const second = await claims.execute(registered, { value: "x" }, { idempotencyKey: "k" }, authority);
    expect(second.state).toBe("in-progress");
    release();
    await first;
    await expect(escaped.bind({ id: "other" })).rejects.toMatchObject({ code: "RUN_STATE" });
  });
  it.each(["claimed", "bound", "accepted"] as const)(
    "recovers a lost acknowledgement after %s without another prepare",
    async (phase) => {
      const { store } = await fixture();
      let failed = false;
      const original = store.write.bind(store);
      store.write = async (record: RetryRecord) => {
        await original(record);
        if (!failed && record.phase === phase) {
          failed = true;
          throw new Error("lost acknowledgement");
        }
      };
      if (phase === "claimed") {
        const claim = store.claim.bind(store);
        store.claim = async (...args) => {
          const result = await claim(...args);
          if (!failed) {
            failed = true;
            throw new Error("lost acknowledgement");
          }
          return result;
        };
      }
      const one = new RegisteredRetryClaims(store, faults);
      const firstOp = operation();
      await expect(
        one.execute(one.register(firstOp.op), { value: "a" }, { idempotencyKey: "same" }, authority),
      ).rejects.toThrow("lost acknowledgement");
      const restarted = new RegisteredRetryClaims(store, faults);
      const secondOp = operation();
      const result = await restarted.execute(
        restarted.register(secondOp.op),
        { value: "a" },
        { idempotencyKey: "same" },
        authority,
      );
      expect(result.state).toBe(phase === "claimed" ? "in-progress" : "resolved");
      expect(secondOp.prepare).not.toHaveBeenCalled();
      expect(secondOp.recover).toHaveBeenCalledTimes(phase === "bound" ? 1 : 0);
    },
  );
  it("bind is a write-once CAS and omitted keys create separate journals", async () => {
    const { claims } = await fixture();
    const { op } = operation();
    const registered = claims.register({
      ...op,
      prepare: async (_c, context) => {
        await context.bind({ id: "one" });
        await context.bind({ id: "one" });
        await expect(context.bind({ id: "two" })).rejects.toMatchObject({ details: { retryReason: "conflict" } });
        return { admissionId: "one" };
      },
    });
    const a = await claims.execute(registered, { value: "x" }, {}, authority);
    const b = await claims.execute(registered, { value: "x" }, {}, authority);
    expect(a.operationId).not.toBe(b.operationId);
  });
  it("separate processes racing a key recover one bound operation after owner death", async () => {
    const { dir } = await fixture();
    const run = (crash = false) =>
      new Promise<{ code: number | null; output: string }>((done, reject) => {
        const resultFile = join(dir, `result-${Math.random()}`);
        const child = spawn(process.execPath, childCommand(childEntry, [dir, resultFile, ...(crash ? ["crash"] : [])]));
        let output = "",
          errors = "";
        child.stdout.on("data", (data: Buffer) => {
          output += data.toString();
        });
        child.stderr.on("data", (data: Buffer) => {
          errors += data.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 17 && crash) done({ code, output });
          else if (code === 0) void readFile(resultFile, "utf8").then((output) => done({ code, output }), reject);
          else reject(new Error(`child code=${code} stderr=${errors}`));
        });
      });
    expect((await run(true)).code).toBe(17);
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => JSON.parse(r.output) as unknown)).toEqual([
      expect.objectContaining({ state: "resolved" }),
      expect.objectContaining({ state: "resolved" }),
    ]);
    expect(JSON.parse(results[0].output)).toEqual(JSON.parse(results[1].output));
    expect((await readFile(join(dir, "effects"), "utf8")).trim().split("\n")).toHaveLength(1);
  });
});

describe("retry-safe Request reservation", () => {
  it("reuses the original admission after response loss and generation change", async () => {
    const { claims } = await fixture();
    const f = submissionFixture();
    const service = new RequestSubmissionService({
      orchestrator: f.orc,
      admissions: f.admissions,
      captureLaunch: f.capture,
      retries: claims,
    });
    const command = { title: "A Request", body: "body" };
    const first = await service.submitRetry(command, { idempotencyKey: "intent" }, f.authority);
    expect(first).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    f.setGeneration("changed");
    expect(
      await service.submitRetry(
        { ...command, vars: {} },
        { idempotencyKey: "intent" },
        { ...f.authority, actor: { principalId: "owner", credentialId: "rotated" } },
      ),
    ).toEqual({ ...first, replayed: true });
    // Fresh validation and preparation each capture; accepted replay does neither.
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(await f.stores.requests.list()).toHaveLength(1);
    expect(await f.orc.listRuns()).toHaveLength(1);
  });
  it("recovers a sealed preparation whose admission index acknowledgement was lost", async () => {
    const { claims } = await fixture();
    const f = submissionFixture();
    const put = f.admissions.records.put.bind(f.admissions.records);
    let fail = true;
    f.admissions.records.put = async (record) => {
      if (fail) {
        fail = false;
        throw new Error("crash before index");
      }
      await put(record);
    };
    const service = new RequestSubmissionService({
      orchestrator: f.orc,
      admissions: f.admissions,
      captureLaunch: f.capture,
      retries: claims,
    });
    await expect(
      service.submitRetry({ title: "one", body: "body" }, { idempotencyKey: "intent" }, f.authority),
    ).rejects.toMatchObject({ code: "STORE_WRITE" });
    const second = await service.submitRetry({ title: "one", body: "body" }, { idempotencyKey: "intent" }, f.authority);
    expect(second).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    expect(await f.stores.requests.list()).toHaveLength(1);
    expect(await f.orc.listRuns()).toHaveLength(1);
  });
});
