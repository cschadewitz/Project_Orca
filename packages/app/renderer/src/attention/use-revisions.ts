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
} from "@orca/protocol";
import { INPUTS_REVISION_RUN_LIMIT } from "@orca/protocol";
import { useConnection, useSubscriptionGeneration } from "../chrome/use-connection.js";
import { useWorkspace } from "../chrome/use-workspace.js";
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
export interface RevisionsFeed {
  scope: string;
  supported: boolean;
  items: readonly AttentionRevision[];
  notice?: string;
  observeInputs: (inputs: readonly OpenInputView[]) => void;
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
}
const EMPTY: Controller = { observe: () => {}, refresh: () => {}, submit: unsupported, replace: unsupported };

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
      const result = protectedReads.current.then(() => (active() && current() ? read() : undefined));
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
                : "Pending corrections could not be refreshed. Their absence is not confirmed.";
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
            const notice = "Pending corrections could not be refreshed. Their absence is not confirmed.";
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
    controller.current = {
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
      stream.on("input.answered", ({ runId }) => {
        if (knownRuns.has(runId)) discover([runId]);
      }),
      stream.on("run.changed", ({ runId }) => {
        if (knownRuns.has(runId)) discover([runId]);
      }),
      stream.on("event.appended", ({ runId, event }) => {
        if (knownRuns.has(runId) && event.type.startsWith("revision.")) discover([runId]);
      }),
    ];
    return () => {
      live = false;
      controller.current = EMPTY;
      off.forEach((remove) => remove());
    };
  }, [scope, readable, supported, connection.state, stream, onAnswered, generation]);

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
    refresh,
    submit,
    replace,
  };
}
