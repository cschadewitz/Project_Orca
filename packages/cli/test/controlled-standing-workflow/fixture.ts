/** Fresh standing workflow. Real disposable composition. Test supervisor identities/profile are explicit assumptions.
 * OS reads are independently intercepted by this test; external syscall acceptance is separate.
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, vi } from "vitest";
import { interceptReadSync } from "../intercept-read-sync.js";
import { fileStores, FileLeaseStore } from "@orca/store";
import { strictPermissionRuleRevision } from "@orca/agents";
import type { StrictPermissionRule } from "@orca/core";
import { CredentialStore } from "../../../daemon/src/auth/credentials.js";
import * as protectedOwner from "../../../daemon/src/protected-scoped-permission-owner.js";
import { resolveManagedRootBinding } from "../../src/typed-workspace-gate.js";
import {
  runControlledOwnedReadTest,
  type ControlledReadTestSupervisor,
} from "../controlled-owned-read/producer-expanded.js";

const cleanup: (() => Promise<unknown>)[] = [];
// Registered when a test file imports this module, so every file that uses `supervisor` cleans up.
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const content = "disposable candidate bytes";
export async function supervisor(
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
  const image = new URL("../controlled-owned-read/producer-expanded.ts", import.meta.url);
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
  const spy = interceptReadSync(((
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
export async function bootstrap() {
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

export type LegacySaveStage = "review" | "verify-first" | "verify-approval";
export type LegacySaveEnding = "cancel" | "credential-expiry";
/** Body of the "legacy bounded Save <stage> stops on <ending>" scenarios, shared by the cancel and the real-time credential-expiry files. */
export async function legacyBoundedSave(stage: LegacySaveStage, ending: LegacySaveEnding) {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    ...(ending === "credential-expiry" ? { operatorCredentialTtlMs: 5000 } : {}),
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let invalidate!: () => void, late: Promise<unknown> | undefined;
  let scope: { signal?: AbortSignal } | undefined;
  const realFactory = protectedOwner.protectedScopedPermissionOwner;
  const spy = vi.spyOn(protectedOwner, "protectedScopedPermissionOwner").mockImplementation((options) => {
    invalidate = () => options.live.close();
    const method = stage === "review" ? "reviewStandingGrant" : "verifyStandingGrantReview";
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply retains the original capture-port receiver.
    const original = options.captures[method]!;
    let calls = 0;
    Object.assign(options.captures, {
      standingGrantReviewScope: "owned-v1",
      [method]: (...args: unknown[]) => {
        if (++calls !== (stage === "verify-approval" ? 2 : 1)) return Reflect.apply(original, options.captures, args);
        scope = args.at(-1) as { signal?: AbortSignal };
        entered();
        return (late = gate.then(() => Reflect.apply(original, options.captures, args)));
      },
    });
    return realFactory(options);
  });
  let settled = false;
  const running = runControlledOwnedReadTest(c.base, "connected", c.options).finally(() => {
    settled = true;
  });
  void running.catch(() => undefined);
  try {
    await Promise.race([
      started,
      running.then(() => {
        throw new Error("Reviewer gate not reached");
      }),
    ]);
    const operator = new CredentialStore({ file: join(c.base, "credentials.json") })
      .list()
      .find((item) => item.principal === "controlled-test-operator")!;
    if (ending === "cancel") invalidate();
    const waitMs = ending === "cancel" ? 2000 : Math.max(1, Date.parse(operator.expiresAt!) - Date.now() + 2000);
    let timer!: ReturnType<typeof setTimeout>;
    const completed = await Promise.race([
      running.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(completed).toBe(true);
    expect(settled).toBe(true);
    expect(scope?.signal?.aborted).toBe(true);
    if (ending === "credential-expiry") expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(operator.expiresAt!));
    await expect(running).rejects.toThrow();
    const dir = join(c.base, "workspace/.orca/private-execution");
    const before = (await readdir(dir)).sort();
    release();
    await late?.catch(() => undefined);
    expect((await readdir(dir)).sort()).toEqual(before);
    const document = JSON.parse(await readFile(join(c.base, "workspace/orca.permissions.json"), "utf8")) as {
      scopedRules: { records: unknown[] };
    };
    expect(document.scopedRules.records).toEqual([]);
    expect(c.observed).toEqual([]);
    const stores = fileStores(join(c.base, "workspace/.orca"));
    expect(await stores.events.readTypes("controlled", ["human.answered"])).toEqual([]);
    // Successful operator removal after settlement also proves the mutex was released.
    expect(await stores.leases.forceRelease("run:controlled")).toMatchObject({ resource: "run:controlled" });
  } finally {
    release();
    await late?.catch(() => undefined);
    await running.catch(() => undefined);
    spy.mockRestore();
  }
}

export type FreshWorkflowFault =
  "operator-revoked" | "lease-lock-contention" | "physical-changed" | "policy-tampered" | "lost-ack";
/** Body of the "fresh workflow refuses <fault> between intent and fresh execution" scenarios. */
export async function freshWorkflowRefuses(fault: FreshWorkflowFault) {
  const b = await bootstrap();
  const c = await supervisor("connected", b.grant, fault === "lost-ack" ? "lost-ack" : undefined);
  let factoryReached = 0,
    leaseLockTimedOut = false;
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    beforeFreshAuthority: async () => {
      factoryReached++;
      if (fault === "operator-revoked") {
        const credentials = new CredentialStore({ file: join(c.base, "credentials.json") });
        const operator = credentials.list().find((record) => record.principal === "controlled-test-operator")!;
        expect(await credentials.revoke(operator.id)).toBe(true);
      }
      if (fault === "lease-lock-contention") {
        // The factory still owns the mutation mutex here. This intentionally
        // proves non-stealing lock refusal, not successful lease removal.
        // Contends with the factory's mutex, so it waits out the lock timeout: a short one, not the 60 s default.
        const leases = new FileLeaseStore(join(c.base, "workspace/.orca"), undefined, 3000);
        const before = await leases.get("run:controlled");
        expect(before).toBeDefined();
        try {
          await leases.forceRelease("run:controlled");
          throw new Error("Contended operator release unexpectedly completed");
        } catch (error) {
          expect(error).toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
          expect(await leases.get("run:controlled")).toEqual(before);
          leaseLockTimedOut = true;
          throw error;
        }
      }
      if (fault === "physical-changed")
        await fs.promises.appendFile(join(c.base, "workspace/.orca/workspace-identity/id"), "changed");
      if (fault === "policy-tampered") {
        const path = join(c.base, "workspace/orca.permissions.json");
        const document = JSON.parse(await readFile(path, "utf8")) as {
          scopedRules: { records: { rule: StrictPermissionRule }[] };
        };
        const record = document.scopedRules.records[0]!;
        const revoked = { ...record.rule, status: "revoked" as const };
        record.rule = { ...revoked, ruleRevision: strictPermissionRuleRevision(revoked) };
        await writeFile(path, JSON.stringify(document));
      }
    },
  });
  await expect(runControlledOwnedReadTest(c.base, "connected", c.options)).rejects.toThrow();
  expect(factoryReached).toBe(fault === "lost-ack" ? 0 : 1);
  expect(leaseLockTimedOut).toBe(fault === "lease-lock-contention");
  expect(c.observed).toEqual([]);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  expect(await stores.events.readTypes("controlled", ["human.answered"])).toHaveLength(1);
}

/** The scenario left no saved grant behind: no scoped rule and no approval marker. */
export async function noSavedGrant(base: string) {
  const document = JSON.parse(await readFile(join(base, "workspace/orca.permissions.json"), "utf8")) as {
    scopedRules: { records: unknown[] };
  };
  expect(document.scopedRules.records.length).toBe(0);
  const events = await fileStores(join(base, "workspace/.orca")).events.readTypes("controlled", ["agent.permission"]);
  expect(events.filter((event) => event.type === "agent.permission" && event.payload.scopedApprovalRef).length).toBe(0);
}
