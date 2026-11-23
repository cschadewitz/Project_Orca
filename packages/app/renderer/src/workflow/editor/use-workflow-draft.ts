/**
 * The editor's one connection to its draft (#180): open it, send edits, undo, review,
 * publish, discard - each through `window.orca.workflowDrafts`, each against the revision the
 * editor last saw.
 *
 * **Edits are sent one at a time, in order.** A drag, a rename and a connect can land within
 * a few hundred milliseconds of each other; each names the revision the previous one
 * produced, so they are queued here rather than racing to the daemon and refusing each other.
 * Every result replaces the draft wholesale - the daemon's view is the truth, including its
 * validation. A dry run (#183) is queued the same way, so it simulates exactly the revision
 * the edits before it produced.
 *
 * **A refusal keeps the draft.** `CONFIG_STALE` means another window moved the draft on: the
 * editor re-reads it and says so, rather than re-sending an edit made against bytes it no
 * longer has. Any other refusal is said in the bar and the draft is left as it was.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DraftOperation,
  DryRunFixtures,
  ProtocolError,
  WorkflowDraftDryRunResult,
  WorkflowDraftGetResult,
  WorkflowDraftPublishResult,
  WorkflowDraftReview,
  WorkflowDraftView,
} from "@orca/protocol";

export type DraftPhase =
  | { phase: "loading" }
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; error: string }
  | { phase: "ready"; draft: WorkflowDraftView };

export interface WorkflowDraftController {
  state: DraftPhase;
  /** A call is out. */
  busy: boolean;
  /** The last refusal or result, in a sentence. */
  message: string | undefined;
  /** The draft moved on in another window; the editor has re-read it. */
  conflict: string | undefined;
  apply(ops: DraftOperation[]): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  review(): Promise<WorkflowDraftReview | undefined>;
  publish(reviewToken: string): Promise<WorkflowDraftPublishResult | undefined>;
  discard(): Promise<boolean>;
  /**
   * Simulate the draft at `revision` (#183) - the one on screen when the fixtures were chosen -
   * with these fixtures. Queued behind any edit already sent; if one of those moved the draft
   * past `revision`, nothing is sent and the answer is `moved`, so the choices can be checked
   * against the new revision first. Answers once the simulation has stopped; a refusal is said
   * in the bar like any other.
   */
  dryRun(
    fixtures: DryRunFixtures,
    revision: number,
  ): Promise<{ kind: "result"; result: WorkflowDraftDryRunResult } | { kind: "moved" } | undefined>;
  reload(): Promise<void>;
  clearMessage(): void;
}

const describe = (error: ProtocolError): string => error.message || error.code;

/** Open (or resume) the draft of `workflowId` and keep it current. */
export function useWorkflowDraft(workflowId: string): WorkflowDraftController {
  const [state, setState] = useState<DraftPhase>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  /** The draft every queued call reads its revision from: the latest, not the one rendered. */
  const latest = useRef<WorkflowDraftView | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const live = useRef(true);

  const accept = useCallback((draft: WorkflowDraftView) => {
    latest.current = draft;
    if (live.current) setState({ phase: "ready", draft });
  }, []);

  const reload = useCallback(async () => {
    const bridge = window.orca.workflowDrafts;
    if (!bridge) return;
    const result = await bridge.call("workflowDrafts.get", { workflowId });
    if (!live.current) return;
    if (!result.ok) {
      setMessage(describe(result.error));
      return;
    }
    const got: WorkflowDraftGetResult = result.result;
    if (got.draft) accept(got.draft);
  }, [workflowId, accept]);

  useEffect(() => {
    live.current = true;
    const bridge = window.orca.workflowDrafts;
    if (!bridge) {
      setState({ phase: "unavailable", reason: "This app cannot edit workflows on this daemon." });
      return;
    }
    setState({ phase: "loading" });
    void bridge.call("workflowDrafts.open", { workflowId }).then((result) => {
      if (!live.current) return;
      if (result.ok) accept(result.result);
      else setState({ phase: "error", error: describe(result.error) });
    });
    return () => {
      live.current = false;
    };
  }, [workflowId, accept]);

  /** Run `call` after everything already queued, with the busy flag and the refusal handling. */
  const enqueue = useCallback(<T>(call: (draft: WorkflowDraftView) => Promise<T>): Promise<T | undefined> => {
    const next = queue.current.then(async () => {
      const draft = latest.current;
      if (!draft || !live.current) return undefined;
      setBusy(true);
      try {
        return await call(draft);
      } finally {
        if (live.current) setBusy(false);
      }
    });
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  /** A refusal: re-read on a conflict, otherwise say it. */
  const refused = useCallback(
    async (error: ProtocolError) => {
      if (error.code === "CONFIG_STALE") {
        setConflict(describe(error));
        await reload();
      } else setMessage(describe(error));
    },
    [reload],
  );

  const mutate = useCallback(
    (method: "workflowDrafts.undo" | "workflowDrafts.redo") =>
      enqueue(async (draft) => {
        const result = await window.orca.workflowDrafts!.call(method, {
          workflowId,
          expectedRevision: draft.revision,
        });
        if (result.ok) {
          setConflict(undefined);
          setMessage(undefined);
          accept(result.result);
        } else await refused(result.error);
      }),
    [enqueue, workflowId, accept, refused],
  );

  const apply = useCallback(
    async (ops: DraftOperation[]): Promise<boolean> =>
      (await enqueue(async (draft) => {
        const result = await window.orca.workflowDrafts!.call("workflowDrafts.apply", {
          workflowId,
          expectedRevision: draft.revision,
          ops,
        });
        if (result.ok) {
          setConflict(undefined);
          setMessage(undefined);
          accept(result.result);
          return true;
        }
        await refused(result.error);
        return false;
      })) ?? false,
    [enqueue, workflowId, accept, refused],
  );

  const review = useCallback(
    () =>
      enqueue(async (draft) => {
        const result = await window.orca.workflowDrafts!.call("workflowDrafts.review", {
          workflowId,
          expectedRevision: draft.revision,
        });
        if (result.ok) return result.result;
        await refused(result.error);
        return undefined;
      }),
    [enqueue, workflowId, refused],
  );

  const publish = useCallback(
    (reviewToken: string) =>
      enqueue(async (draft) => {
        const result = await window.orca.workflowDrafts!.call("workflowDrafts.publish", {
          workflowId,
          expectedRevision: draft.revision,
          reviewToken,
        });
        if (result.ok) {
          latest.current = undefined;
          return result.result;
        }
        await refused(result.error);
        return undefined;
      }),
    [enqueue, workflowId, refused],
  );

  const discard = useCallback(
    async (): Promise<boolean> =>
      (await enqueue(async (draft) => {
        const result = await window.orca.workflowDrafts!.call("workflowDrafts.discard", {
          workflowId,
          expectedRevision: draft.revision,
        });
        if (result.ok) {
          latest.current = undefined;
          return true;
        }
        await refused(result.error);
        return false;
      })) ?? false,
    [enqueue, workflowId, refused],
  );

  const dryRun = useCallback(
    (fixtures: DryRunFixtures, revision: number) =>
      enqueue(
        async (
          draft,
        ): Promise<{ kind: "result"; result: WorkflowDraftDryRunResult } | { kind: "moved" } | undefined> => {
          if (draft.revision !== revision) return { kind: "moved" };
          const result = await window.orca.workflowDrafts!.call("workflowDrafts.dryRun", {
            workflowId,
            expectedRevision: revision,
            fixtures,
          });
          if (result.ok) {
            setMessage(undefined);
            return { kind: "result", result: result.result };
          }
          await refused(result.error);
          return undefined;
        },
      ),
    [enqueue, workflowId, refused],
  );

  return {
    state,
    busy,
    message,
    conflict,
    apply,
    undo: async () => void (await mutate("workflowDrafts.undo")),
    redo: async () => void (await mutate("workflowDrafts.redo")),
    review,
    publish,
    discard,
    dryRun,
    reload,
    clearMessage: () => {
      setMessage(undefined);
      setConflict(undefined);
    },
  };
}
