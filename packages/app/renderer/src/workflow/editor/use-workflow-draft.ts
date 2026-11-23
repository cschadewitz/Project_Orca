/**
 * The editor's one connection to its draft (#180): open it, send edits, undo, review,
 * publish, discard - each through `window.orca.workflowDrafts`, each against the revision the
 * editor last saw.
 *
 * **Edits are sent one at a time, in order.** A drag, a rename and a connect can land within
 * a few hundred milliseconds of each other; each names the revision the previous one
 * produced, so they are queued here rather than racing to the daemon and refusing each other.
 * Every result replaces the draft wholesale - the daemon's view is the truth, including its
 * validation.
 *
 * **A refusal keeps the draft.** `CONFIG_STALE` means another window moved the draft on: the
 * editor re-reads it and says so, rather than re-sending an edit made against bytes it no
 * longer has. Any other refusal is said in the bar and the draft is left as it was.
 *
 * **Validation is bound to a revision and a context (#182).** The findings arrive inside the
 * view, so an older view - a re-read that answers after an edit's result - never replaces a
 * newer one, and of two re-reads only the last one asked counts. Every view-producing call
 * also carries the *freshness* it was sent under: losing the daemon, a different daemon
 * behind the window, a changed configuration or another workflow moves it on, marks the
 * findings `checking`, and re-reads the draft. Any answer sent before that - an edit's reply
 * included - is dropped, so the last rows stay on screen as stale rather than an old
 * context's answer clearing the mark; only a view sent under the current freshness does.
 * Queued calls wait for that re-read first, so they name the revision it found.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DraftOperation,
  ProtocolError,
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
  /**
   * The findings on screen are not yet known to be current: the daemon went away, or the
   * configuration they were checked against changed, and the re-read has not answered.
   */
  checking: boolean;
  apply(ops: DraftOperation[]): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  review(): Promise<WorkflowDraftReview | undefined>;
  publish(reviewToken: string): Promise<WorkflowDraftPublishResult | undefined>;
  discard(): Promise<boolean>;
  reload(): Promise<void>;
  /** Mark the findings as not current and re-read the draft, which validates it again. */
  revalidate(this: void): Promise<void>;
  clearMessage(): void;
}

const describe = (error: ProtocolError): string => error.message || error.code;

/** Open (or resume) the draft of `workflowId` and keep it current. */
export function useWorkflowDraft(workflowId: string): WorkflowDraftController {
  const [state, setState] = useState<DraftPhase>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  /** The draft every queued call reads its revision from: the latest, not the one rendered. */
  const latest = useRef<WorkflowDraftView | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const live = useRef(true);
  /** Which re-read is the last one asked: an earlier one that answers late is dropped. */
  const reads = useRef(0);
  /** The context every view-producing call is sent under; see the header. */
  const freshness = useRef(0);
  /** The re-read a revalidation started, which queued calls wait for. */
  const settling = useRef<Promise<void>>(Promise.resolve());

  /**
   * Hold `draft` unless it is older than the one already held - the same draft (same
   * creation) at a lower revision. A draft discarded and opened again starts its revisions
   * over, so a different `createdAt` is always newer news.
   */
  const accept = useCallback((draft: WorkflowDraftView): boolean => {
    const held = latest.current;
    if (
      held &&
      held.workflowId === draft.workflowId &&
      held.createdAt === draft.createdAt &&
      draft.revision < held.revision
    )
      return false;
    latest.current = draft;
    if (live.current) setState({ phase: "ready", draft });
    return true;
  }, []);

  /** Take a view sent under `sentUnder`: dropped when the context has moved on since. */
  const take = useCallback(
    (draft: WorkflowDraftView, sentUnder: number): boolean => {
      if (sentUnder !== freshness.current) return false;
      if (accept(draft)) setChecking(false);
      return true;
    },
    [accept],
  );

  const reload = useCallback(async () => {
    const bridge = window.orca.workflowDrafts;
    if (!bridge) return;
    const ticket = ++reads.current;
    const sentUnder = freshness.current;
    const result = await bridge.call("workflowDrafts.get", { workflowId });
    if (!live.current || ticket !== reads.current || sentUnder !== freshness.current) return;
    if (!result.ok) {
      setMessage(describe(result.error));
      return;
    }
    const got: WorkflowDraftGetResult = result.result;
    // A re-read answers with the draft as validated now. If an edit's result has already
    // brought a newer revision, that one was validated by the same daemon later still.
    if (got.draft) {
      accept(got.draft);
      setChecking(false);
    }
  }, [workflowId, accept]);

  /** The context changed: nothing sent before now may clear `checking`. */
  const invalidate = useCallback(() => {
    freshness.current += 1;
    setChecking(true);
  }, []);

  const revalidate = useCallback(async () => {
    invalidate();
    const read = reload();
    settling.current = read.catch(() => undefined);
    await read;
  }, [invalidate, reload]);

  useEffect(() => {
    live.current = true;
    const bridge = window.orca.workflowDrafts;
    if (!bridge) {
      setState({ phase: "unavailable", reason: "This app cannot edit workflows on this daemon." });
      return;
    }
    setState({ phase: "loading" });
    // Another workflow is another context: nothing the previous one sent may land here.
    latest.current = undefined;
    freshness.current += 1;
    const sentUnder = freshness.current;
    let mine = true;
    void bridge.call("workflowDrafts.open", { workflowId }).then((result) => {
      if (!live.current || !mine) return;
      if (!result.ok) {
        setState({ phase: "error", error: describe(result.error) });
        return;
      }
      // The first view is all there is to draw. If the context moved while it was out, it
      // stays marked `checking` until the re-read that move started answers.
      if (sentUnder === freshness.current) take(result.result, sentUnder);
      else accept(result.result);
    });
    return () => {
      mine = false;
      live.current = false;
    };
  }, [workflowId, accept, take]);

  /* The daemon going away makes the findings unverified; its return, or a different daemon
     behind the same window, validates the draft again. Anything else the connection pushes
     (methods, capabilities) leaves them alone. */
  useEffect(() => {
    const connection = window.orca.connection;
    let was = connection.read();
    return connection.subscribe((now) => {
      const before = was;
      was = now;
      if (now.state !== "live") {
        if (before.state === "live") invalidate();
        return;
      }
      if (before.state !== "live" || now.generation !== before.generation) void revalidate();
    });
  }, [revalidate, invalidate]);
  useEffect(() => {
    const target = window.orca.daemonConnection;
    if (!target) return;
    let epoch = target.read().epoch;
    return target.subscribe((now) => {
      if (now.epoch === epoch) return;
      epoch = now.epoch;
      void revalidate();
    });
  }, [revalidate]);

  /** Run `call` after everything already queued, with the busy flag and the refusal handling. */
  const enqueue = useCallback(<T>(call: (draft: WorkflowDraftView) => Promise<T>): Promise<T | undefined> => {
    const next = queue.current.then(async () => {
      await settling.current;
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
        const sentUnder = freshness.current;
        const result = await window.orca.workflowDrafts!.call(method, {
          workflowId,
          expectedRevision: draft.revision,
        });
        if (result.ok) {
          setConflict(undefined);
          setMessage(undefined);
          take(result.result, sentUnder);
        } else await refused(result.error);
      }),
    [enqueue, workflowId, take, refused],
  );

  const apply = useCallback(
    async (ops: DraftOperation[]): Promise<boolean> =>
      (await enqueue(async (draft) => {
        const sentUnder = freshness.current;
        const result = await window.orca.workflowDrafts!.call("workflowDrafts.apply", {
          workflowId,
          expectedRevision: draft.revision,
          ops,
        });
        if (result.ok) {
          setConflict(undefined);
          setMessage(undefined);
          // Applied either way; a reply from an older context waits for the re-read to show it.
          take(result.result, sentUnder);
          return true;
        }
        await refused(result.error);
        return false;
      })) ?? false,
    [enqueue, workflowId, take, refused],
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

  return {
    state,
    busy,
    message,
    conflict,
    checking,
    apply,
    undo: async () => void (await mutate("workflowDrafts.undo")),
    redo: async () => void (await mutate("workflowDrafts.redo")),
    review,
    publish,
    discard,
    reload,
    revalidate,
    clearMessage: () => {
      setMessage(undefined);
      setConflict(undefined);
    },
  };
}
