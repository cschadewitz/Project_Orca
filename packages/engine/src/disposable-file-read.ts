/** Inactive Linux disposable-file acceptance capability. Never exported by the package or mounted. */
import fs, { constants, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ActionEvidenceV1, ActionResourceV1, StrictPermissionState } from "@orca/core";
import type { SyntheticReadExecutor, SyntheticReadOwner, SyntheticReadOwnerSnapshot } from "./synthetic-read-fence.js";

type Qualification = Pick<ActionEvidenceV1, "operation" | "profileRef" | "resources" | "rawDuplicateKeyValidation">;
const registrations = new WeakMap<
  object,
  { owner: SyntheticReadOwner; describe(this: void, capture: unknown): Qualification }
>();
const unavailable = () => new Error("Disposable file capability unsupported, unavailable or changed");
const frozen = <T>(value: T): T => {
  const clone = structuredClone(value);
  const freeze = (part: unknown): void => {
    if (part && typeof part === "object") {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
  };
  freeze(clone);
  return clone;
};

/** Lookup, never a general registration or memory-qualification fallback. */
export function fileCaptureQualifier(owner: SyntheticReadOwner, executor: object) {
  const registration = registrations.get(executor);
  return registration?.owner === owner ? registration.describe : undefined;
}

export interface DisposableFileReadParameters {
  readonly resourceRef: string;
  readonly offset: number;
  readonly length: number;
}
interface Capture {
  readonly bytes: string;
  readonly offset: number;
  readonly length: number;
}
const identity = (info: BigIntStats) => {
  const facts = [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.mtimeNs, info.ctimeNs];
  if (facts.some((fact) => typeof fact !== "bigint") || info.ino <= 0n || info.size < 0n) throw unavailable();
  return facts.join(":");
};

/**
 * Test setup ONLY: creates a new synthetic private tree and detached inode. No caller path/fd intake.
 * The returned executor can only read; no production factory, policy writes, native hook or daemon wiring.
 * Same-UID/root interference and hostile kernels/filesystems are outside this trusted-process fixture.
 */
export function createDisposableFileReadForTest(options: {
  enabled: true;
  owner: SyntheticReadOwner;
  content: string;
  policy(resource: ActionResourceV1, snapshot: SyntheticReadOwnerSnapshot): StrictPermissionState;
  observed(action: ActionEvidenceV1, ref: string): Promise<void>;
  /** Trusted response start; its promise acknowledges delivery. Cancellation cannot retract started delivery. */
  respond(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}) {
  if (
    options.enabled !== true ||
    process.platform !== "linux" ||
    typeof process.geteuid !== "function" ||
    !constants.O_NOFOLLOW ||
    typeof options.content !== "string" ||
    Buffer.byteLength(options.content) > 4096
  )
    throw unavailable();
  const injected = options.owner;
  const base: SyntheticReadOwner = Object.freeze({
    signal: injected.signal,
    clock: Object.freeze({
      now: injected.clock.now.bind(injected.clock),
      isoNow: injected.clock.isoNow.bind(injected.clock),
    }),
    snapshot: injected.snapshot.bind(injected),
    withOwnership: injected.withOwnership.bind(injected),
    authorize: injected.authorize.bind(injected),
    assertCurrent: injected.assertCurrent.bind(injected),
  });
  const original = frozen(base.snapshot());
  const observed = options.observed.bind(options);
  const respond = options.respond.bind(options);
  const root = fs.mkdtempSync(join(tmpdir(), "orca-owned-read-"));
  const path = join(root, "fixture");
  let descriptor: number | undefined;
  try {
    const rootInfo = fs.lstatSync(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.uid !== BigInt(process.geteuid()) || (rootInfo.mode & 0o777n) !== 0o700n)
      throw unavailable();
    // Only fixture setup writes. The write descriptor is closed before any read capability exists.
    fs.writeFileSync(path, options.content, { flag: "wx", mode: 0o400 });
    const info = fs.lstatSync(path, { bigint: true });
    if (!info.isFile() || info.uid !== rootInfo.uid || info.nlink !== 1n || (info.mode & 0o777n) !== 0o400n)
      throw unavailable();
    descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (identity(fs.fstatSync(descriptor, { bigint: true })) !== identity(info)) throw unavailable();
    fs.unlinkSync(path); // Remove the name before review; no pathname is used by the executor.
    const fd = descriptor;
    const initial = fs.fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.nlink !== 0n || initial.uid !== rootInfo.uid || initial.size > 4096n)
      throw unavailable();
    const stamp = identity(initial);
    const id = `disposable-file:${randomUUID()}`;
    const physicalTargetRef = `${id}:${stamp}`;
    const resource: ActionResourceV1 = frozen({ operation: "fs.readOwnedBytes", physicalTargetRef });
    let generation = 0n;
    let closed = false;
    let used = false;
    const abort = new AbortController();
    const signal = AbortSignal.any([base.signal, abort.signal]);
    const captures = new WeakMap<object, Capture>();
    const coverage = frozen({
      ...original.coverage,
      coverageId: `${id}:source-v1`,
      boundaryId: "orca-disposable-file-read-v1",
      provider: "orca-owned-disposable-file",
      providerVersion: "1",
      adapterVersion: "1",
      tool: "fs.readOwnedBytes",
      toolSchemaVersion: "1",
      platform: `linux-${process.arch}`,
      level: "policy-per-ask" as const,
      evidence: {
        sourceRefs: ["packages/engine/src/disposable-file-read.ts"],
        installedRefs: [],
        independentlyObservedEffects: false,
      },
      negotiatedHook: { state: "complete" as const, value: `${id}:private-descriptor` },
      protectedConfiguration: { state: "complete" as const, value: `${id}:source-fixture` },
      guaranteedEffects: ["bounded-positional-read-of-retained-detached-inode"],
      unsupportedPaths: [
        "arbitrary-path",
        "external-writers",
        "hostile-same-uid",
        "root",
        "remote-host",
        "macos",
        "windows",
        "native-shell",
        "alternate-mcp",
        "production",
      ],
    });
    const snapshot = () =>
      frozen({
        ...original,
        coverage,
        authority: { ...original.authority, capturedGeneration: `${id}:${generation}` },
        cwd: root,
        workspaceRef: `${id}:temporary-tree`,
        relevantStateRefs: [physicalTargetRef],
      });
    const capturedSnapshot = snapshot();
    const policy = frozen(options.policy(resource, capturedSnapshot));
    const current = () => {
      const currentBase = base.snapshot();
      signal.throwIfAborted();
      if (
        closed ||
        generation !== 0n ||
        BigInt(process.geteuid!()) !== initial.uid ||
        !isDeepStrictEqual(currentBase, original)
      )
        throw unavailable();
      if (identity(fs.fstatSync(fd, { bigint: true })) !== stamp) throw unavailable();
    };
    const owner: SyntheticReadOwner = Object.freeze<SyntheticReadOwner>({
      signal,
      clock: base.clock,
      withOwnership: base.withOwnership.bind(base),
      snapshot,
      authorize: async (action, active) => {
        active.throwIfAborted();
        current();
        await base.authorize(action, active);
        active.throwIfAborted();
        current();
      },
      assertCurrent: (action) => {
        current();
        base.assertCurrent(action);
        current();
        if (
          !isDeepStrictEqual(action.authority, capturedSnapshot.authority) ||
          !isDeepStrictEqual(action.invocation, original.invocation) ||
          !isDeepStrictEqual(action.coverage, coverage) ||
          !isDeepStrictEqual(action.resources, { state: "complete", value: [resource] })
        )
          throw unavailable();
      },
    });
    const retained = (handle: unknown) => {
      current();
      if (!handle || typeof handle !== "object") throw unavailable();
      const capture = captures.get(handle);
      if (!capture) throw unavailable();
      return capture;
    };
    const executor: SyntheticReadExecutor<DisposableFileReadParameters, object> = Object.freeze<
      SyntheticReadExecutor<DisposableFileReadParameters, object>
    >({
      codecVersion: "orca-disposable-file-read-v1",
      capture: (parameters) => {
        current();
        const fields = ["resourceRef", "offset", "length"];
        if (
          !parameters ||
          typeof parameters !== "object" ||
          Reflect.ownKeys(parameters).length !== 3 ||
          fields.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(parameters, key) ?? {}, "value"))
        )
          throw unavailable();
        const { resourceRef, offset, length } = parameters;
        if (
          resourceRef !== id ||
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          Object.is(offset, -0) ||
          offset < 0 ||
          length < 1 ||
          length > 4096 ||
          BigInt(offset + length) > initial.size
        )
          throw unavailable();
        const handle = Object.freeze({});
        captures.set(handle, {
          offset,
          length,
          bytes: JSON.stringify(["orca-disposable-file-read-v1", id, physicalTargetRef, offset, length]),
        });
        return handle;
      },
      encode: (handle) => retained(handle).bytes,
      execute: (handle, action, ref, active) => {
        const capture = retained(handle);
        active.throwIfAborted();
        owner.assertCurrent(action);
        if (used) throw unavailable();
        used = true;
        const bytes = Buffer.alloc(capture.length);
        // No await, path lookup, callback or caller descriptor between checks and real OS read.
        const count = fs.readSync(fd, bytes, 0, bytes.length, capture.offset);
        current();
        active.throwIfAborted();
        owner.assertCurrent(action);
        if (count !== capture.length) throw unavailable();
        return (async () => {
          await observed(action, ref);
          active.throwIfAborted();
          owner.assertCurrent(action);
          await respond(bytes, active);
          active.throwIfAborted();
          owner.assertCurrent(action);
        })();
      },
    });
    registrations.set(executor, {
      owner,
      describe: (handle) => {
        retained(handle);
        return frozen({
          operation: resource.operation,
          profileRef: "orca-disposable-file-read-v1",
          resources: { state: "complete", value: [resource] },
          rawDuplicateKeyValidation: {
            state: "absent",
            reason: "Exact structured own data fields; no raw JSON parser",
          },
        });
      },
    });
    const dispose = () => {
      if (closed) return;
      closed = true;
      abort.abort();
      fs.closeSync(fd);
      fs.rmSync(root, { recursive: true, force: true });
    };
    return Object.freeze({
      owner,
      executor,
      resource,
      resourceRef: id,
      root,
      path,
      policy,
      invalidate: () => {
        generation++;
      },
      source: Object.freeze({
        readCurrent: async (action: ActionEvidenceV1, active: AbortSignal) => {
          active.throwIfAborted();
          owner.assertCurrent(action);
          return policy;
        },
      }),
      dispose,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
