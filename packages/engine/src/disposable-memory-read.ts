/** Inactive disposable-memory capability. No AgentHost.fs, path resolution or installed qualification. */
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  ActionEvidenceV1,
  ActionResourceV1,
  AuthorityStampV1,
  Clock,
  CoverageV1,
  StrictPermissionSource,
  StrictPermissionState,
} from "@orca/core";
import type { SyntheticReadExecutor, SyntheticReadOwner, SyntheticReadOwnerSnapshot } from "./synthetic-read-fence.js";

function immutable<T>(input: T): T {
  const value = structuredClone(input);
  const freeze = (part: unknown): void => {
    if (part && typeof part === "object") {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
  };
  freeze(value);
  return value;
}
const refuse = () => new Error("Disposable memory capability is unavailable or changed");
const text = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 4096;
type Qualification = Pick<ActionEvidenceV1, "operation" | "profileRef" | "resources" | "rawDuplicateKeyValidation">;
const processRef = randomUUID();
let ownerSequence = 0n;
const registered = new WeakMap<
  object,
  { owner: SyntheticReadOwner; describe(this: void, capture: unknown): Qualification }
>();

/** Lookup only: callers cannot register arbitrary executors or forge retained capture handles. */
export function memoryCaptureQualifier(
  owner: SyntheticReadOwner,
  executor: object,
): ((capture: unknown) => Qualification) | undefined {
  const registration = registered.get(executor);
  return registration?.owner === owner ? registration.describe : undefined;
}

interface MemoryInput {
  readonly content: string;
  readonly resourceRef: string;
}
interface MemorySnapshot extends MemoryInput {
  readonly resourceRevision: string;
}
interface Capture {
  readonly generation: bigint;
  readonly memory: MemorySnapshot;
  readonly bytes: string;
}
export interface MemoryReadParameters {
  readonly resourceRef: string;
}
export interface MemoryReplacement {
  readonly policy?: StrictPermissionState;
  readonly authority?: AuthorityStampV1;
  readonly coverage?: CoverageV1;
  readonly memory?: MemoryInput;
  readonly policyAvailable?: boolean;
  readonly authorityAvailable?: boolean;
  readonly cwd?: string;
  readonly workspaceRef?: string;
}

/** One exclusive owner replaces all policy/authority/resource snapshots synchronously. */
export class DisposableMemoryReadOwner implements SyntheticReadOwner {
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly withOwnership: SyntheticReadOwner["withOwnership"];
  readonly executor: SyntheticReadExecutor<MemoryReadParameters, object>;
  readonly source: StrictPermissionSource;
  readonly #abort = new AbortController();
  readonly #ownerRef = `disposable-memory:${processRef}:${++ownerSequence}`;
  readonly #qualification: CoverageV1;
  readonly #assertLease: (action: ActionEvidenceV1) => void;
  readonly #captures = new WeakMap<object, Capture>();
  #generation = 0n;
  #memoryRevision = 0n;
  #snapshot: SyntheticReadOwnerSnapshot;
  #policy: StrictPermissionState;
  #memory: MemorySnapshot;
  #policyAvailable = true;
  #authorityAvailable = true;
  #entries = 0;
  #reads = 0;

  constructor(options: {
    clock: Clock;
    snapshot: SyntheticReadOwnerSnapshot;
    withOwnership: SyntheticReadOwner["withOwnership"];
    memory: MemoryInput;
    assertLease(action: ActionEvidenceV1): void;
    policy(resource: ActionResourceV1, snapshot: SyntheticReadOwnerSnapshot): StrictPermissionState;
    onDispatch(action: ActionEvidenceV1, evidenceRef: string): Promise<void>;
    onRead(action: ActionEvidenceV1, evidenceRef: string): Promise<void>;
    respond(content: string): Promise<void>;
  }) {
    this.signal = this.#abort.signal;
    this.clock = Object.freeze({
      now: options.clock.now.bind(options.clock),
      isoNow: options.clock.isoNow.bind(options.clock),
    });
    this.withOwnership = options.withOwnership.bind(options);
    this.#assertLease = options.assertLease.bind(options);
    this.#memory = immutable({
      ...this.validateMemory(options.memory),
      resourceRevision: `${this.#ownerRef}:resource:0`,
    });
    this.#qualification = immutable({
      version: 1,
      coverageId: `${this.#ownerRef}:qualification/v1`,
      boundaryId: "orca-disposable-memory-read-v1",
      provider: "disposable-memory",
      providerVersion: "1",
      adapterVersion: "1",
      tool: "memory.readText",
      toolSchemaVersion: "1",
      hostId: options.snapshot.invocation.hostId,
      platform: "in-process-memory",
      level: "policy-per-ask",
      evidence: {
        sourceRefs: ["packages/engine/src/disposable-memory-read.ts"],
        installedRefs: [],
        independentlyObservedEffects: false,
      },
      negotiatedHook: { state: "complete", value: `${this.#ownerRef}:registered-capability` },
      protectedConfiguration: { state: "complete", value: `${this.#ownerRef}:immutable-owner/v1` },
      guaranteedEffects: ["retained-disposable-memory-read"],
      unsupportedPaths: [
        "physical-filesystem",
        "native-shell",
        "descendants",
        "alternate-mcp",
        "installed-provider",
        "remote-host",
      ],
    });
    this.#snapshot = immutable({ ...options.snapshot, coverage: this.#qualification });
    this.#snapshot = this.nextSnapshot();
    this.#policy = immutable(options.policy(this.resource(), this.#snapshot));
    this.#policy = immutable({ ...this.#policy, authority: this.#snapshot.authority });
    const onDispatch = options.onDispatch.bind(options);
    const onRead = options.onRead.bind(options);
    const respond = options.respond.bind(options);
    const retained = (capture: unknown): Capture => {
      if (!capture || typeof capture !== "object") throw refuse();
      const entry = this.#captures.get(capture);
      if (!entry || entry.generation !== this.#generation || entry.memory !== this.#memory || this.signal.aborted)
        throw refuse();
      return entry;
    };
    this.executor = Object.freeze({
      codecVersion: "orca-disposable-memory-read-v1",
      capture: (parameters: MemoryReadParameters): object => {
        const descriptor = parameters && Object.getOwnPropertyDescriptor(parameters, "resourceRef");
        if (
          !parameters ||
          typeof parameters !== "object" ||
          Array.isArray(parameters) ||
          Reflect.ownKeys(parameters).length !== 1 ||
          !descriptor ||
          !("value" in descriptor) ||
          descriptor.value !== this.#memory.resourceRef
        )
          throw refuse();
        this.signal.throwIfAborted();
        const handle = Object.freeze({});
        const bytes = JSON.stringify({
          codec: "orca-disposable-memory-read-v1",
          ownerRef: this.#ownerRef,
          generation: String(this.#generation),
          resourceRef: this.#memory.resourceRef,
          resourceRevision: this.#memory.resourceRevision,
        });
        this.#captures.set(handle, { generation: this.#generation, memory: this.#memory, bytes });
        return handle;
      },
      encode: (capture: object) => retained(capture).bytes,
      execute: (capture: object, action: ActionEvidenceV1, evidenceRef: string): Promise<void> => {
        const entry = retained(capture);
        this.assertCurrent(action);
        this.#entries++;
        const dispatch = onDispatch(action, evidenceRef);
        // Recheck after trusted synchronous instrumentation, then read the retained private cell.
        retained(capture);
        this.assertCurrent(action);
        const content = entry.memory.content;
        this.#reads++;
        const effect = onRead(action, evidenceRef);
        return Promise.all([dispatch, effect]).then(async () => {
          await respond(content);
        });
      },
    });
    registered.set(this.executor, {
      owner: this,
      describe: (capture) => {
        retained(capture);
        return immutable({
          operation: "memory.readText",
          profileRef: "orca-disposable-memory-read-v1",
          resources: { state: "complete", value: [this.resource()] },
          rawDuplicateKeyValidation: {
            state: "absent",
            reason: "Structured in-process parameters; no raw JSON was parsed",
          },
        });
      },
    });
    this.source = Object.freeze({
      readCurrent: async (_action: ActionEvidenceV1, signal: AbortSignal) => {
        signal.throwIfAborted();
        this.signal.throwIfAborted();
        this.assertCurrent(_action);
        if (!this.#policyAvailable) throw refuse();
        return this.#policy; // Deep immutable; callers never receive mutable backing state.
      },
    });
    Object.freeze(this);
  }

  private validateMemory(value: MemoryInput): MemoryInput {
    if (!text(value.resourceRef) || typeof value.content !== "string" || Buffer.byteLength(value.content) > 65_536)
      throw refuse();
    return immutable(value);
  }
  private resource(): ActionResourceV1 {
    return {
      operation: "memory.readText",
      targetKind: "disposable-memory",
      ownerRef: this.#ownerRef,
      resourceRef: this.#memory.resourceRef,
      resourceRevision: this.#memory.resourceRevision,
    };
  }
  private nextSnapshot(): SyntheticReadOwnerSnapshot {
    return immutable({
      ...this.#snapshot,
      authority: { ...this.#snapshot.authority, capturedGeneration: `${this.#ownerRef}:${this.#generation}` },
      relevantStateRefs: [this.#memory.resourceRef, this.#memory.resourceRevision],
    });
  }
  /** Every replacement, including identical values and availability recovery, advances generation. */
  replace(replacement: MemoryReplacement): void {
    this.signal.throwIfAborted();
    const patch = immutable(replacement);
    const memory = patch.memory
      ? immutable({
          ...this.validateMemory(patch.memory),
          resourceRevision: `${this.#ownerRef}:resource:${this.#memoryRevision + 1n}`,
        })
      : this.#memory;
    const policy = patch.policy ?? this.#policy;
    const snapshot = immutable({
      ...this.#snapshot,
      authority: patch.authority ?? policy.authority,
      coverage: patch.coverage ?? this.#snapshot.coverage,
      cwd: patch.cwd ?? this.#snapshot.cwd,
      workspaceRef: patch.workspaceRef ?? this.#snapshot.workspaceRef,
    });
    const nextGeneration = this.#generation + 1n;
    const nextSnapshot = immutable({
      ...snapshot,
      authority: { ...snapshot.authority, capturedGeneration: `${this.#ownerRef}:${nextGeneration}` },
      relevantStateRefs: [memory.resourceRef, memory.resourceRevision],
    });
    const nextPolicy = immutable({ ...policy, authority: nextSnapshot.authority });
    // All validation and copying finishes before the synchronous commit; no await or callbacks here.
    this.#memory = memory;
    if (patch.memory) this.#memoryRevision++;
    this.#generation = nextGeneration;
    this.#snapshot = nextSnapshot;
    this.#policyAvailable = patch.policyAvailable ?? this.#policyAvailable;
    this.#authorityAvailable = patch.authorityAvailable ?? this.#authorityAvailable;
    this.#policy = nextPolicy;
  }

  snapshot(): SyntheticReadOwnerSnapshot {
    return this.#snapshot;
  }
  async authorize(action: ActionEvidenceV1, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.assertCurrent(action);
  }
  assertCurrent(action: ActionEvidenceV1): void {
    this.signal.throwIfAborted();
    this.#assertLease(action);
    if (!isDeepStrictEqual(this.#snapshot.coverage, this.#qualification)) throw refuse();
    if (
      !this.#policyAvailable ||
      !this.#authorityAvailable ||
      this.clock.now() >= Date.parse(this.#snapshot.expiresAt) ||
      !isDeepStrictEqual(action.authority, this.#snapshot.authority) ||
      !isDeepStrictEqual(action.invocation, this.#snapshot.invocation) ||
      !isDeepStrictEqual(action.coverage, this.#snapshot.coverage) ||
      action.effectiveCwd.state !== "complete" ||
      action.effectiveCwd.value !== this.#snapshot.cwd ||
      action.workspaceRef.state !== "complete" ||
      action.workspaceRef.value !== this.#snapshot.workspaceRef ||
      action.relevantStateRefs.state !== "complete" ||
      !isDeepStrictEqual(action.relevantStateRefs.value, this.#snapshot.relevantStateRefs) ||
      action.resources.state !== "complete" ||
      !isDeepStrictEqual(action.resources.value, [this.resource()])
    )
      throw refuse();
  }
  get executorEntries(): number {
    return this.#entries;
  }
  get observedReads(): number {
    return this.#reads;
  }
  dispose(): void {
    this.#abort.abort();
  }
}
