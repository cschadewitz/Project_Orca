/** Current correction metadata is a separate, bounded feed. It never contributes to waiting. */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OpenInputView,
  PendingRevisionSummary,
  PendingRevisionTarget,
  PendingRevisionView,
  RevisionCommand,
  ReplacePendingRevisionCommand,
  RevisionResult,
  RunsEventsResult,
} from "@orca/protocol";
import { INPUTS_REVISION_RUN_LIMIT } from "@orca/protocol";
import { useConnection, useSubscriptionGeneration } from "../chrome/use-connection.js";
import { useWorkspace } from "../chrome/use-workspace.js";
import type { AnswerRequest } from "./answer-card.js";
import { useNotifications } from "../notifications-context.js";
import { pendingTarget } from "./revision-input-model.js";

export interface AttentionRevision {
  summary: PendingRevisionSummary;
  /** Only a successful current protected read supplies content and the replacement boundary. */
  pending?: PendingRevisionView;
  input?: OpenInputView;
  /** Association learned only from an authorized boundary, never inferred from a destination. */
  stepRunId?: string | undefined;
  reading: boolean;
  error?: string;
}
export type AnswerHandoff = <T extends { ok: boolean }>(
  input: OpenInputView,
  selected: AnswerRequest,
  invoke: () => Promise<T>,
) => Promise<T | undefined>;
interface AnswerPause {
  input: Pick<OpenInputView, "runId" | "stepRunId" | "id">;
  scope: string;
  issued: boolean;
  settled: boolean;
  accepted: boolean;
  draft: AnswerRequest;
  released: boolean;
  release(): void;
  wait: Promise<void>;
  cancel(): void;
  cancelled: Promise<void>;
  creationId?: string;
  creationSeq?: number;
  startSeq?: number;
  seenSeq?: number;
  answeredSeq?: number | undefined;
  verifiedScope?: string;
  checkedScope?: string;
  checking: boolean;
}
const progressEvents = new Set(["run.resumed", "run.completed", "run.failed", "run.cancelled"]);
const historyTypes = ["run.created", "human.answered", ...progressEvents];
function creation(page: RunsEventsResult, runId: string) {
  if (page.hasMore || page.events.length !== 1) return undefined;
  const event = page.events[0];
  return event?.type === "run.created" && event.runId === runId && page.lastSeq >= event.seq ? event : undefined;
}
/** One complete filtered snapshot, never partial pages or a guessed current run status. */
function answerProgress(page: RunsEventsResult, pause: AnswerPause) {
  if (page.hasMore || pause.startSeq === undefined) return undefined;
  let last = -1;
  for (const event of page.events) {
    if (event.runId !== pause.input.runId || event.seq <= last || !historyTypes.includes(event.type)) return undefined;
    last = event.seq;
  }
  if (page.lastSeq < last) return undefined;
  const created = page.events.filter((event) => event.type === "run.created");
  if (created.length !== 1 || created[0]!.id !== pause.creationId || created[0]!.seq !== pause.creationSeq)
    return undefined;
  const answered = page.events.find(
    (event) =>
      event.type === "human.answered" &&
      event.seq > pause.startSeq! &&
      event.payload.requestId === pause.input.id &&
      event.payload.stepRunId === pause.input.stepRunId,
  );
  const progressed =
    answered && page.events.some((event) => event.seq > answered.seq && progressEvents.has(event.type));
  return { answeredSeq: answered?.seq, progressed: Boolean(progressed), lastSeq: page.lastSeq };
}

export interface RevisionsFeed {
  scope: string;
  supported: boolean;
  items: readonly AttentionRevision[];
  notice?: string;
  observeInputs: (inputs: readonly OpenInputView[]) => void;
  withAnswer?: AnswerHandoff;
  answerDraft?: (input: OpenInputView) => AnswerRequest | undefined;
  answerNotice?: string;
  checkPendingAnswer?: () => void;
  refresh: (runId?: string) => void;
  submit: (command: RevisionCommand, key: string) => Promise<RevisionResult>;
  replace: (command: ReplacePendingRevisionCommand, key: string) => Promise<RevisionResult>;
}

/** Read synchronously too: a response cannot cross a workspace/transport/authority switch before React rerenders. */
function currentScope(): string {
  const connection = window.orca.connection.read();
  const workspace = window.orca.workspace.read();
  return JSON.stringify([
    workspace.path,
    workspace.source,
    workspace.readOnly,
    connection.generation ?? 0,
    connection.capabilities ?? [],
    connection.methods ?? [],
  ]);
}
export function revisionSlotKey(target: PendingRevisionTarget): string {
  return JSON.stringify([target.runId, target.destinationId, target.attemptId]);
}
export function revisionTargetKey(target: PendingRevisionTarget): string {
  return JSON.stringify([target.runId, target.revisionId, target.destinationId, target.attemptId]);
}
const unsupported = () => Promise.reject(new Error("Explicit revision input is unavailable."));
interface Controller {
  observe: RevisionsFeed["observeInputs"];
  refresh: RevisionsFeed["refresh"];
  submit: RevisionsFeed["submit"];
  replace: RevisionsFeed["replace"];
  withAnswer: AnswerHandoff;
  checkPendingAnswer(): void;
  recheckAnswers(): void;
}
const EMPTY: Controller = {
  observe: () => {},
  refresh: () => {},
  submit: unsupported,
  replace: unsupported,
  withAnswer: async () => undefined,
  checkPendingAnswer: () => {},
  recheckAnswers: () => {},
};

export function useRevisions(onAnswered: (requestId: string) => void): RevisionsFeed {
  const connection = useConnection();
  const generation = useSubscriptionGeneration();
  const workspace = useWorkspace();
  const stream = useNotifications();
  // Unlike old ordinary controls, this feature has no coarse runs.control fallback.
  const readable = connection.methods.includes("inputs.revisionPending") && !!window.orca.inputs.revisionPending;
  const supported =
    readable &&
    connection.methods.includes("inputs.revise") &&
    connection.methods.includes("inputs.replaceRevision") &&
    !!window.orca.inputs.revise &&
    !!window.orca.inputs.replaceRevision &&
    !workspace.readOnly &&
    connection.state !== "file";
  const scope = currentScope();
  const [snapshot, setSnapshot] = useState<{ scope: string; items: readonly AttentionRevision[]; notice?: string }>({
    scope,
    items: [],
  });
  const controller = useRef<Controller>(EMPTY);
  // Discovery can enrich gates outside revisionRunIds, including child runs. Serialize
  // all protected reads in this feed, across effect restarts and reconnects too.
  const protectedReads = useRef<Promise<void>>(Promise.resolve());
  const activeProtectedRead = useRef<Promise<unknown> | undefined>(undefined);
  const answerPauses = useRef(new Set<AnswerPause>());
  const [, setAnswerVersion] = useState(0);
  const answerChanged = useCallback(() => setAnswerVersion((value) => value + 1), []);
  const retained = useRef<
    | {
        scope: string;
        entries: Map<string, AttentionRevision>;
        contexts: Map<string, OpenInputView>;
        knownRuns: Set<string>;
        currentTargets: Map<string, string>;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    let live = true;
    const active = () => live && currentScope() === scope;
    const previous = retained.current?.scope === scope ? retained.current : undefined;
    const entries = previous?.entries ?? new Map<string, AttentionRevision>();
    const contexts = previous?.contexts ?? new Map<string, OpenInputView>();
    const knownRuns = previous?.knownRuns ?? new Set<string>();
    const currentTargets = previous?.currentTargets ?? new Map<string, string>();
    retained.current = { scope, entries, contexts, knownRuns, currentTargets };
    if (connection.state !== "live") {
      for (const [key, entry] of entries)
        entries.set(key, {
          summary: entry.summary,
          reading: false,
          error: "The current correction cannot be confirmed while disconnected.",
          ...(entry.stepRunId ? { stepRunId: entry.stepRunId } : {}),
        });
    }
    const discoveryVersions = new Map<string, number>();
    const pendingVersions = new Map<string, number>();
    const writes = new Set<string>();
    const protectedRead = <T>(current: () => boolean, read: () => Promise<T>) => {
      const result = protectedReads.current.then(async () => {
        if (!active() || !current()) return undefined;
        while ([...answerPauses.current].some((pause) => !pause.released)) {
          await Promise.all([...answerPauses.current].filter((pause) => !pause.released).map((pause) => pause.wait));
          if (!active() || !current()) return undefined;
        }
        const response = read();
        activeProtectedRead.current = response;
        try {
          return await response;
        } finally {
          if (activeProtectedRead.current === response) activeProtectedRead.current = undefined;
        }
      });
      // A refused or rejected read releases the lane, without scheduling a retry.
      protectedReads.current = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    let pageNotice: string | undefined;
    const runNotices = new Map<string, string>();
    const publish = () => {
      const notice = [...new Set([pageNotice, ...runNotices.values()].filter(Boolean))].join(" ");
      if (active())
        setSnapshot({
          scope,
          items: [...entries.values()].filter(
            (entry) =>
              currentTargets.get(revisionSlotKey(entry.summary.target)) === revisionTargetKey(entry.summary.target),
          ),
          ...(notice ? { notice } : {}),
        });
    };
    const contextFor = (pending: PendingRevisionView) =>
      pending.boundary
        ? contexts.get(JSON.stringify([pending.boundary.target.runId, pending.boundary.target.requestId]))
        : undefined;
    const discardSuperseded = (target: PendingRevisionTarget) => {
      // A receipt or discovery advances the current slot, never an unbounded history.
      for (const [key, entry] of entries) {
        if (key !== revisionTargetKey(target) && revisionSlotKey(entry.summary.target) === revisionSlotKey(target)) {
          entries.delete(key);
          pendingVersions.delete(key); // A late response cannot restore the superseded identity.
        }
      }
    };
    const readPending = (summary: PendingRevisionSummary) => {
      const key = revisionTargetKey(summary.target);
      const version = (pendingVersions.get(key) ?? 0) + 1;
      pendingVersions.set(key, version);
      const previous =
        entries.get(key) ??
        [...entries.values()].find(
          (entry) => revisionSlotKey(entry.summary.target) === revisionSlotKey(summary.target),
        );
      entries.set(key, {
        summary,
        reading: true,
        ...(previous?.input ? { input: previous.input } : {}),
        ...(previous?.stepRunId ? { stepRunId: previous.stepRunId } : {}),
      });
      discardSuperseded(summary.target);
      publish();
      const read = window.orca.inputs.revisionPending;
      if (!readable || !read) {
        entries.set(key, { summary, reading: false, error: "Correction content is unavailable on this connection." });
        publish();
        return;
      }
      const current = () =>
        pendingVersions.get(key) === version && currentTargets.get(revisionSlotKey(summary.target)) === key;
      void protectedRead(current, () => read({ target: summary.target }))
        .then((result) => {
          if (!result || !active() || !current()) return;
          if (!result.ok || revisionTargetKey(result.result.target) !== key) {
            entries.set(key, {
              summary,
              reading: false,
              ...(previous?.stepRunId ? { stepRunId: previous.stepRunId } : {}),
              error: "The current correction could not be confirmed. Content and replacement are unavailable.",
            });
          } else {
            const pending = result.result;
            const input = contextFor(pending) ?? previous?.input;
            entries.set(key, {
              summary: {
                target: pending.target,
                expectedRevision: pending.expectedRevision,
                state: pending.state,
                ...(pending.unavailableReason ? { unavailableReason: pending.unavailableReason } : {}),
              },
              pending,
              ...((pending.boundary?.target.stepRunId ?? previous?.stepRunId)
                ? { stepRunId: pending.boundary?.target.stepRunId ?? previous?.stepRunId }
                : {}),
              reading: false,
              ...(input ? { input } : {}),
            });
          }
          publish();
        })
        .catch(() => {
          if (!active() || !current()) return;
          entries.set(key, {
            summary,
            reading: false,
            ...(previous?.stepRunId ? { stepRunId: previous.stepRunId } : {}),
            error: "The current correction could not be confirmed. Content and replacement are unavailable.",
          });
          publish();
        });
    };
    const discover = (runIds: readonly string[]) => {
      if (!active() || !readable || connection.state !== "live") return;
      const ids = [...new Set(runIds)];
      for (let offset = 0; offset < ids.length; offset += INPUTS_REVISION_RUN_LIMIT) {
        const batch = ids.slice(offset, offset + INPUTS_REVISION_RUN_LIMIT);
        const versions = new Map(
          batch.map((id) => {
            knownRuns.add(id);
            const version = (discoveryVersions.get(id) ?? 0) + 1;
            discoveryVersions.set(id, version);
            return [id, version];
          }),
        );
        // Revoke stale protected content as soon as its currentness is invalidated.
        for (const [key, entry] of entries) {
          if (batch.includes(entry.summary.target.runId)) {
            pendingVersions.set(key, (pendingVersions.get(key) ?? 0) + 1);
            entries.set(key, {
              summary: entry.summary,
              reading: true,
              ...(entry.input ? { input: entry.input } : {}),
              ...(entry.stepRunId ? { stepRunId: entry.stepRunId } : {}),
            });
          }
        }
        publish();
        const currentRuns = () => batch.filter((id) => discoveryVersions.get(id) === versions.get(id));
        void protectedRead(
          () => currentRuns().length > 0,
          () => window.orca.inputs.list({ revisionRunIds: currentRuns() }),
        )
          .then((result) => {
            if (!result || !active()) return;
            const runs = currentRuns();
            if (runs.length === 0) return;
            const projection = result.ok ? result.result.pendingRevisions : undefined;
            if (!projection) {
              const notice = result.ok
                ? "Pending correction discovery is unavailable on this daemon."
                : "Pending corrections could not be refreshed. Their absence is not confirmed. Choose Refresh corrections to try again.";
              for (const runId of runs) runNotices.set(runId, notice);
              for (const [key, entry] of entries)
                if (runs.includes(entry.summary.target.runId))
                  entries.set(key, {
                    summary: entry.summary,
                    reading: false,
                    error: notice,
                    ...(entry.stepRunId ? { stepRunId: entry.stepRunId } : {}),
                  });
              publish();
              return;
            }
            for (const runId of runs) {
              if (projection.incomplete)
                runNotices.set(
                  runId,
                  "Only part of the pending correction list is available. Open the relevant run to review its corrections.",
                );
              else runNotices.delete(runId);
            }
            const seen = new Set<string>();
            for (const summary of projection.items) {
              if (!runs.includes(summary.target.runId)) continue;
              seen.add(revisionTargetKey(summary.target));
              currentTargets.set(revisionSlotKey(summary.target), revisionTargetKey(summary.target));
              readPending(summary);
            }
            // Omission never proves delivery or cancellation. Retain known identities and inspect them.
            for (const [key, entry] of entries)
              if (runs.includes(entry.summary.target.runId) && !seen.has(key)) readPending(entry.summary);
            publish();
          })
          .catch(() => {
            if (!active()) return;
            const notice =
              "Pending corrections could not be refreshed. Their absence is not confirmed. Choose Refresh corrections to try again.";
            for (const runId of batch)
              if (discoveryVersions.get(runId) === versions.get(runId)) runNotices.set(runId, notice);
            for (const [key, entry] of entries)
              if (
                batch.includes(entry.summary.target.runId) &&
                discoveryVersions.get(entry.summary.target.runId) === versions.get(entry.summary.target.runId)
              )
                entries.set(key, {
                  summary: entry.summary,
                  reading: false,
                  error: notice,
                  ...(entry.stepRunId ? { stepRunId: entry.stepRunId } : {}),
                });
            publish();
          });
      }
    };
    const record = (result: RevisionResult) => {
      if (!active() || result.state !== "resolved") return;
      const receipt = result.result;
      const target = pendingTarget(receipt);
      currentTargets.set(revisionSlotKey(target), revisionTargetKey(target));
      const input = contexts.get(JSON.stringify([receipt.target.runId, receipt.target.requestId]));
      entries.set(revisionTargetKey(target), {
        summary: { target, expectedRevision: receipt.expectedRevision, state: receipt.state },
        reading: true,
        stepRunId: receipt.target.stepRunId,
        ...(input ? { input } : {}),
      });
      discardSuperseded(target);
      onAnswered(receipt.target.requestId);
      discover([target.runId]);
    };
    const write = async (command: RevisionCommand | ReplacePendingRevisionCommand, key: string, replace: boolean) => {
      if (!active() || !supported || window.orca.connection.read().state !== "live")
        throw new Error("Explicit revision input is unavailable.");
      if (replace) {
        const replacement = command as ReplacePendingRevisionCommand;
        const entry = entries.get(revisionTargetKey(replacement.target));
        if (
          !entry?.pending?.boundary ||
          !entry.pending.payload ||
          !entry.pending.replacementAllowed ||
          entry.pending.state !== "pending" ||
          entry.reading ||
          entry.error ||
          entry.pending.expectedRevision !== replacement.expectedRevision ||
          currentTargets.get(revisionSlotKey(replacement.target)) !== revisionTargetKey(replacement.target)
        ) {
          throw Object.assign(new Error("Review the current correction before replacing it."), {
            code: "REVISION_STALE",
          });
        }
      } else {
        const revision = command as RevisionCommand;
        const input = contexts.get(JSON.stringify([revision.target.runId, revision.target.requestId]));
        if (
          !input?.revision ||
          JSON.stringify(input.revision.target) !== JSON.stringify(revision.target) ||
          input.revision.capability.actionId !== revision.actionId
        ) {
          throw Object.assign(new Error("Review the current gate before requesting changes."), {
            code: "REVISION_STALE",
          });
        }
      }
      const id = JSON.stringify([command.target.runId, command.target.destinationId]);
      if (writes.has(id)) throw new Error("A correction request is already in progress.");
      writes.add(id);
      try {
        const result = replace
          ? await window.orca.inputs.replaceRevision!({
              command: command as ReplacePendingRevisionCommand,
              retry: { idempotencyKey: key },
            })
          : await window.orca.inputs.revise!({ command: command as RevisionCommand, retry: { idempotencyKey: key } });
        if (!active()) throw new Error("The correction belongs to a previous connection.");
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
        record(result.result);
        return result.result;
      } finally {
        writes.delete(id);
      }
    };
    // One authorized run page, never a history scan or invented pagination cursor.
    const loadPage = () => {
      if (!readable || connection.state !== "live") return;
      void window.orca.runs
        .list({
          limit: INPUTS_REVISION_RUN_LIMIT,
          status: ["running", "waiting", "held", "blocked", "stale", "failed"],
        })
        .then((result) => {
          if (!active()) return;
          if (!result.ok) {
            pageNotice = "The run page for pending corrections could not be loaded.";
            publish();
            return;
          }
          pageNotice =
            result.result.total > result.result.runs.length
              ? "Only the loaded active or paused run page is covered. Open another run to review its pending corrections."
              : undefined;
          discover(result.result.runs.map((run) => run.id));
          publish();
        })
        .catch(() => {
          if (active()) {
            pageNotice = "The run page for pending corrections could not be loaded.";
            publish();
          }
        });
    };
    const checkAnswers = async (explicit: boolean) => {
      for (const pause of answerPauses.current) {
        if (!pause.creationId || pause.checking || (!explicit && pause.checkedScope === scope)) continue;
        pause.checkedScope = scope;
        delete pause.verifiedScope;
        pause.checking = true;
        answerChanged();
        try {
          // This existing read uses current authorization and takes no revision lease.
          const result = await window.orca.runs.events({ runId: pause.input.runId, types: historyTypes, limit: 500 });
          if (!active() || !result.ok) continue;
          const proof = answerProgress(result.result, pause);
          if (!proof) continue;
          pause.verifiedScope = scope;
          pause.answeredSeq = proof.answeredSeq;
          pause.seenSeq = proof.lastSeq;
          if (proof.progressed) pause.release();
        } catch {
          /* Unavailable history is uncertainty, never permission to resend. */
        } finally {
          pause.checking = false;
          answerChanged();
          if (!active()) controller.current.recheckAnswers();
        }
      }
    };
    const withAnswer: AnswerHandoff = async (input, selected, invoke) => {
      if (!active() || window.orca.connection.read().state !== "live") return undefined;
      if (!readable || input.live || input.kind === "permission") return invoke();
      const existing = [...answerPauses.current].filter(
        (pause) => pause.input.runId === input.runId && pause.input.id === input.id,
      );
      if (existing.some((pause) => !pause.settled)) return undefined;
      for (const previous of existing) answerPauses.current.delete(previous);
      let release!: () => void;
      let cancel!: () => void;
      const pause: AnswerPause = {
        input: { runId: input.runId, stepRunId: input.stepRunId, id: input.id },
        scope,
        issued: false,
        settled: false,
        accepted: false,
        draft: structuredClone(selected),
        released: false,
        checking: false,
        wait: new Promise<void>((done) => {
          release = done;
        }),
        cancelled: new Promise<void>((done) => {
          cancel = done;
        }),
        release: () => {
          if (!pause.released) {
            pause.released = true;
            release();
            answerChanged();
          }
        },
        cancel: () => {
          if (!pause.issued) {
            cancel();
            pause.release();
          }
        },
      };
      answerPauses.current.add(pause);
      answerChanged();
      try {
        // Only already-forwarded reads need draining. Other ordinary answers and live
        // permission callbacks remain independent; queued reads wait for every pause.
        const draining = activeProtectedRead.current?.then(
          () => {},
          () => {},
        );
        const identityRead = window.orca.runs
          .events({ runId: input.runId, types: ["run.created"], limit: 2 })
          .then((result) => {
            if (!active()) return false;
            const identity = result.ok ? creation(result.result, input.runId) : undefined;
            if (!identity || !result.ok) return false;
            pause.creationId = identity.id;
            pause.creationSeq = identity.seq;
            pause.startSeq = result.result.lastSeq;
            pause.seenSeq = result.result.lastSeq;
            pause.verifiedScope = scope;
            pause.checkedScope = scope;
            return true;
          });
        const prepared = await Promise.race([
          Promise.all([draining, identityRead]),
          pause.cancelled.then(() => undefined),
        ]);
        if (!active()) return undefined;
        if (!prepared?.[1])
          throw new Error(
            "Answer was not sent because the current run identity could not be verified. Your note is preserved.",
          );
        pause.issued = true;
        answerChanged();
        const response = await invoke();
        pause.accepted = response.ok;
        return active() ? response : undefined;
      } catch (error) {
        if (!active()) return undefined;
        throw error;
      } finally {
        pause.settled = true;
        pause.release();
        if (pause.accepted) answerPauses.current.delete(pause);
        answerChanged();
      }
    };
    controller.current = {
      withAnswer,
      recheckAnswers: () => {
        void checkAnswers(false);
      },
      checkPendingAnswer: () => {
        void checkAnswers(true);
      },
      observe: (inputs) => {
        const newRuns = new Set<string>();
        for (const input of inputs) {
          contexts.set(JSON.stringify([input.runId, input.id]), input);
          if (!knownRuns.has(input.runId)) newRuns.add(input.runId);
        }
        discover([...newRuns]);
      },
      refresh: (runId) => {
        if (runId) discover([runId]);
        else {
          discover([...knownRuns]);
          loadPage();
        }
      },
      submit: (command, key) => write(command, key, false),
      replace: (command, key) => write(command, key, true),
    };
    publish();
    loadPage();
    const off = [
      stream.on("input.answered", (event) => {
        for (const pause of answerPauses.current) {
          if (
            !pause.issued ||
            pause.released ||
            pause.verifiedScope !== scope ||
            event.runId !== pause.input.runId ||
            event.seq <= (pause.seenSeq ?? -1)
          )
            continue;
          pause.seenSeq = event.seq;
          if (
            event.requestId === pause.input.id &&
            event.stepRunId === pause.input.stepRunId &&
            event.seq > (pause.startSeq ?? Infinity)
          )
            pause.answeredSeq = event.seq;
        }
        if (knownRuns.has(event.runId)) discover([event.runId]);
      }),
      stream.on("run.changed", (event) => {
        for (const pause of answerPauses.current) {
          if (
            !pause.issued ||
            pause.released ||
            pause.verifiedScope !== scope ||
            event.runId !== pause.input.runId ||
            event.seq <= (pause.seenSeq ?? -1)
          )
            continue;
          pause.seenSeq = event.seq;
          if (pause.answeredSeq !== undefined && event.seq > pause.answeredSeq && progressEvents.has(event.event))
            pause.release();
        }
        if (knownRuns.has(event.runId)) discover([event.runId]);
      }),
      stream.on("event.appended", ({ runId, event }) => {
        if (knownRuns.has(runId) && event.type.startsWith("revision.")) discover([runId]);
      }),
    ];
    void checkAnswers(false);
    return () => {
      live = false;
      for (const pause of answerPauses.current) if (pause.scope === scope && !pause.issued) pause.cancel();
      controller.current = EMPTY;
      off.forEach((remove) => remove());
    };
  }, [scope, readable, supported, connection.state, stream, onAnswered, generation]);

  const withAnswer = useCallback<AnswerHandoff>(
    (input, selected, invoke) => controller.current.withAnswer(input, selected, invoke),
    [],
  );
  const answerDraft = (input: OpenInputView) => {
    const pause = [...answerPauses.current].find(
      (entry) =>
        entry.verifiedScope === currentScope() &&
        entry.input.runId === input.runId &&
        entry.input.id === input.id &&
        entry.input.stepRunId === input.stepRunId,
    );
    return pause?.draft;
  };
  const checkPendingAnswer = useCallback(() => controller.current.checkPendingAnswer(), []);
  const outstandingAnswers = [...answerPauses.current];
  const answerNotice =
    outstandingAnswers.length === 0
      ? undefined
      : outstandingAnswers.some((pause) => pause.checking)
        ? "Checking the earlier answer against current run history. No answer will be resent."
        : outstandingAnswers.some((pause) => pause.issued && !pause.released)
          ? "An earlier answer is still unconfirmed. Correction details are paused; other controls and permission answers remain available. Check pending answer to inspect the run history."
          : outstandingAnswers.some((pause) => !pause.issued && !pause.settled)
            ? "Waiting for read verification before sending the selected answer. Your note is retained."
            : outstandingAnswers.some((pause) => !pause.issued)
              ? "An earlier answer was not sent. Its note is retained; review the current gate before sending."
              : outstandingAnswers.some((pause) => !pause.settled)
                ? "Run progress was verified, but the earlier answer response is still pending. No answer will be resent."
                : "The earlier answer could not be confirmed. Your note is retained; review the current gate before answering again.";
  const observeInputs = useCallback<RevisionsFeed["observeInputs"]>((inputs) => controller.current.observe(inputs), []);
  const refresh = useCallback<RevisionsFeed["refresh"]>((runId) => controller.current.refresh(runId), []);
  const submit = useCallback<RevisionsFeed["submit"]>(
    (command, key) => {
      if (currentScope() !== scope) return unsupported();
      return controller.current.submit(command, key);
    },
    [scope],
  );
  const replace = useCallback<RevisionsFeed["replace"]>(
    (command, key) => {
      if (currentScope() !== scope) return unsupported();
      return controller.current.replace(command, key);
    },
    [scope],
  );
  return {
    scope,
    supported,
    items: snapshot.scope === scope ? snapshot.items : [],
    ...(snapshot.scope === scope && snapshot.notice ? { notice: snapshot.notice } : {}),
    observeInputs,
    withAnswer,
    answerDraft,
    checkPendingAnswer,
    ...(answerNotice ? { answerNotice } : {}),
    refresh,
    submit,
    replace,
  };
}
