/**
 * Owner-local tool decisions. The log describes the ask; only this registry can
 * deliver its answer to the original callback. A workflow gate still parks.
 */
import { randomUUID } from "node:crypto";
import { OrcaError, type MutationActor, type OrcaEventInput } from "@orca/core";
import { HumanInputPending, type HumanInputPort, type HumanInputQuery } from "./human-input.js";

export interface LiveDecisionIdentity {
  instanceId: string;
  sessionId: string;
  turnId: string;
  invocationId: string;
}

export interface LiveDecisionTarget extends LiveDecisionIdentity {
  runId: string;
  stepRunId: string;
  requestId: string;
}

export interface LiveInputBinding {
  identity: LiveDecisionIdentity;
  /** Run ownership, agent/turn lifetime and current execution authority, never UI lifetime. */
  signal: AbortSignal;
  /** Uses the already-held interpreter lease, including its mutation mutex. */
  withOwnership<T>(operation: () => Promise<T>): Promise<T>;
  /** Only called within withOwnership; must update both private/public projections. */
  emitOwned(event: Omit<OrcaEventInput, "runId">): Promise<unknown>;
}

/** Explicit execution attachment, distinct from one-time input-answer authority. */
export interface ExecutionResumeOrigin {
  rootId: string;
  workflowId: string;
  request: boolean;
  actor: MutationActor;
}
export interface ExecutionResumeAuthority {
  actor: MutationActor;
  /** Server-owned capability; rechecked inside the acquired execution lease. */
  authorize(origin: ExecutionResumeOrigin): Promise<void>;
}

export interface LiveAnswerAuthority {
  /** Server-verified actor; not a field in the answer command. */
  actor: MutationActor;
  /** Revalidate current credential, exact resource and (separately) standing-rule authority. */
  authorize(this: void, target: LiveDecisionTarget, standing: boolean): Promise<void>;
}

export interface LiveAnswer {
  target: LiveDecisionTarget;
  optionId: string;
  note?: string;
  /** False/no-resume is unsupported: a live answer means delivering to this turn. */
  standing?: boolean;
}

export type LiveInputState = "pending" | "accepting" | "expired" | "owner-unavailable";

interface Pending {
  query: HumanInputQuery;
  binding: LiveInputBinding;
  target: LiveDecisionTarget;
  state: "pending" | "accepting";
  resolve(answer: string | undefined): void;
  reject(error: unknown): void;
  dispose(invalidated?: boolean): void;
}

const IDENTITY_KEYS = ["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId", "requestId"] as const;

/** Existing RUN_STATE envelope, with a machine-readable lifetime reason. No alternate error hierarchy. */
function unavailable(state: LiveInputState): OrcaError {
  return new OrcaError("RUN_STATE", `live permission callback is ${state}`, { liveInputState: state });
}

/** Internal daemon activity gate, with no authority/grant or durable state semantics. */
export interface ExecutionActivity {
  enter(reason: "execution" | "callback" | "renewal" | "dispatch" | "continuation" | "recovery"): () => void;
}
export class LiveHumanInput implements HumanInputPort {
  runtimeActivity?: ExecutionActivity;
  get pendingCount(): number {
    return this.pending.size;
  }
  get available(): boolean {
    return !this.closed;
  }
  private readonly pending = new Map<string, Pending>();
  private readonly invalidations = new Set<(target: LiveDecisionTarget) => void>();
  private readonly observationIncarnation = randomUUID();
  private observationCounter = 0n;
  private closed = false;

  constructor(readonly instanceId: string) {
    if (!instanceId) throw new OrcaError("CONFIG_INVALID", "live inputs require a daemon boot identity");
  }

  /** Internal observation token, never execution authority or a durable event cursor. */
  get observationRevision(): string {
    return JSON.stringify([this.instanceId, this.observationIncarnation, this.observationCounter.toString()]);
  }

  recordsAnswer(query: HumanInputQuery): boolean {
    return query.kind === "permission" && query.live !== undefined;
  }

  ask(query: HumanInputQuery): Promise<string | undefined> {
    if (query.kind !== "permission") return Promise.reject(new HumanInputPending(query));
    const binding = query.live;
    // Unsupported transports retain PausingHumanInput's conservative cancellation.
    if (!binding) return Promise.resolve(undefined);
    if (this.closed || binding.signal.aborted || query.signal?.aborted) return Promise.resolve(undefined);
    if (binding.identity.instanceId !== this.instanceId) return Promise.reject(unavailable("owner-unavailable"));
    if (this.pending.has(query.requestId)) return Promise.reject(unavailable("accepting"));
    const release = this.runtimeActivity?.enter("callback");
    return new Promise((resolve, reject) => {
      const expire = () => {
        entry.dispose(true);
        resolve(undefined);
      };
      const entry: Pending = {
        query: { ...query, options: structuredClone(query.options) },
        binding,
        target: { ...binding.identity, runId: query.runId, stepRunId: query.stepRunId, requestId: query.requestId },
        state: "pending",
        resolve,
        reject,
        dispose: (invalidated = false) => {
          const removed = this.pending.get(query.requestId) === entry;
          if (removed) {
            this.pending.delete(query.requestId);
            this.observationCounter++;
            release?.();
          }
          binding.signal.removeEventListener("abort", expire);
          query.signal?.removeEventListener("abort", expire);
          // Ephemeral, owner-local state only. Lease loss cannot append an event, and a
          // broken observer must never prevent the original callback settling.
          if (removed && invalidated)
            for (const listener of [...this.invalidations]) {
              try {
                listener({ ...entry.target });
              } catch {
                /* Observation is never execution authority. */
              }
            }
        },
      };
      this.pending.set(query.requestId, entry);
      this.observationCounter++;
      binding.signal.addEventListener("abort", expire, { once: true });
      query.signal?.addEventListener("abort", expire, { once: true });
    });
  }

  /** Internal feed. Every recipient must be authorized for the exact run before delivery. */
  onInvalidated(listener: (target: LiveDecisionTarget) => void): () => void {
    this.invalidations.add(listener);
    return () => void this.invalidations.delete(listener);
  }

  /** Called only after the reader has authorized this exact input's run. No global public list. */
  inspect(target: LiveDecisionTarget): LiveInputState {
    if (target.instanceId !== this.instanceId) return "owner-unavailable";
    const entry = this.pending.get(target.requestId);
    return entry && IDENTITY_KEYS.every((key) => entry.target[key] === target[key]) ? entry.state : "expired";
  }

  async answer(
    command: LiveAnswer,
    authority: LiveAnswerAuthority,
    /** Standing writes happen after durable acceptance under the very same lease. */
    afterAnswer?: () => Promise<void>,
  ): Promise<{ answerRecorded: true; delivered: boolean }> {
    const release = this.runtimeActivity?.enter("callback");
    try {
      return await this.performAnswer(command, authority, afterAnswer);
    } finally {
      release?.();
    }
  }
  private async performAnswer(
    command: LiveAnswer,
    authority: LiveAnswerAuthority,
    afterAnswer?: () => Promise<void>,
  ): Promise<{ answerRecorded: true; delivered: boolean }> {
    // Snapshot the command across awaits; caller mutation must not substitute another target/choice.
    const answer = structuredClone(command);
    const actor = { ...authority.actor };
    await authority.authorize(answer.target, answer.standing === true);
    const entry = this.pending.get(answer.target.requestId);
    const state = this.inspect(answer.target);
    if (state !== "pending" || !entry) throw unavailable(state);
    if (!entry.query.options.some((option) => option.id === answer.optionId))
      throw new OrcaError("RUN_STATE", "the answer is not an offered option");
    if ((answer.standing === true) !== Boolean(afterAnswer))
      throw new OrcaError("NOT_SUPPORTED", "standing answer requires its authorized writer");
    // Claim synchronously before any await, so concurrent responders cannot both enter.
    entry.state = "accepting";
    this.observationCounter++;
    let recorded = false;
    let attemptedWrite = false;
    try {
      return await entry.binding.withOwnership(async () => {
        await authority.authorize(answer.target, answer.standing === true);
        if (this.pending.get(entry.target.requestId) !== entry || entry.binding.signal.aborted)
          throw unavailable("expired");
        attemptedWrite = true;
        await entry.binding.emitOwned({
          type: "human.answered",
          payload: {
            stepRunId: entry.target.stepRunId,
            requestId: entry.target.requestId,
            answer: answer.optionId,
            actor,
            ...(answer.note ? { note: answer.note } : {}),
          },
        });
        recorded = true;
        try {
          await afterAnswer?.();
        } catch {
          entry.dispose(true);
          // Propagate to the owning prompt, so its interpreter parks rather than retrying
          // or executing an accepted tool after a failed standing write.
          entry.reject(new HumanInputPending(entry.query));
          throw new OrcaError("INTERNAL", "answer recorded; standing permission failed; run must remain paused", {
            answerRecorded: true,
            runId: entry.target.runId,
            requestId: entry.target.requestId,
          });
        }
        const delivered = this.pending.get(entry.target.requestId) === entry && !entry.binding.signal.aborted;
        entry.dispose();
        entry.resolve(delivered ? answer.optionId : undefined);
        return { answerRecorded: true, delivered };
      });
    } catch (error) {
      if (!recorded && this.pending.get(entry.target.requestId) === entry) {
        if (attemptedWrite) {
          // An append may have reached disk before reporting failure. Never reopen that
          // identity for a second answer, and never write policy after an uncertain append.
          entry.dispose(true);
          entry.reject(error);
          throw error;
        }
        // A refused responder does not consume an otherwise live question. Loss of the
        // owning lease does, even when its heartbeat has not fired yet.
        if (error instanceof OrcaError && error.code === "RUN_LEASED") {
          entry.dispose(true);
          entry.resolve(undefined);
        } else {
          entry.state = "pending";
          this.observationCounter++;
        }
      }
      throw error;
    }
  }

  /** Daemon shutdown; no persistence, approval, or cancellation of durable workflow gates. */
  close(): void {
    if (!this.closed) this.observationCounter++;
    this.closed = true;
    for (const entry of this.pending.values()) {
      entry.dispose(true);
      entry.resolve(undefined);
    }
  }
}
