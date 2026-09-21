/**
 * The Config surface's data: one `config.get` on mount, then `config.changed` for
 * everything after it, and the draft a person is holding in between.
 *
 * Five decisions worth knowing before changing anything here:
 *
 * - **One read, then pushes. Never a poll.** `config.changed` carries the document and its
 *   new `revision` but not the document's contents, so a push that matters is followed by
 *   one `config.get` — and a push whose revision is one this hook already holds is *its
 *   own write coming back* and is dropped. Without that test every save would re-read the
 *   file it just wrote and throw away the form's scroll position for nothing.
 * - **A draft is one document's, and it is either the form's or the raw view's.** They are
 *   two different writes — a `patch` keeps the file's comments, a `text` replaces the bytes
 *   — and there is no merge of the two that is not a guess about which the person meant. So
 *   the last edited wins by construction: editing a field drops a raw draft, editing the
 *   raw text drops the field edits, and the bar says so before it happens rather than
 *   afterwards.
 * - **`expectedRevision` is the revision this draft was made against**, and a refused write
 *   keeps the draft. `CONFIG_STALE` means somebody else wrote the file, which is a thing to
 *   tell a person about and never a reason to throw away what they typed: the bar shows the
 *   conflict with **Reload**, the reload brings the new revision, and the same draft can
 *   then be sent against it.
 * - **Validation errors are the daemon's, placed by path.** `validateOnly` asks the same
 *   questions a write asks and writes nothing; a refused write reports the same list under
 *   `CONFIG_INVALID`'s `details.errors`, so both paths end with a list keyed by path.
 * - **The save announces, because nothing else will.** There is no notification for "your
 *   write was refused", and the one that follows a write that landed says only that the
 *   file moved. So the hook says the sentence itself, into the app's one live region
 *   (`a11y/announce.ts`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfigDocument,
  ConfigGetResult,
  ConfigSetParams,
  ConfigValidationError,
  ProtocolError,
} from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { useNotifications } from "../notifications-context.js";
import { patchFrom, type Draft } from "./config-model.js";

export type ConfigState =
  { phase: "loading" } | { phase: "error"; error: ProtocolError } | { phase: "ready"; data: ConfigGetResult };

/** What is unsaved for one document. The two shapes are the two writes `config.set` takes. */
export type DocumentDraft = { kind: "form"; fields: Draft } | { kind: "raw"; text: string };

/** What the last Validate or Save said about one document. */
export interface SaveState {
  /** True while a call is out: the bar's buttons wait rather than queueing a second write. */
  busy: boolean;
  errors: readonly ConfigValidationError[];
  /** Set when the file moved under this draft. The draft is kept; the bar offers Reload. */
  conflict?: string;
  /** The last outcome in words, shown in the bar. */
  message?: string;
}

const IDLE: SaveState = { busy: false, errors: [] };

export interface ConfigFeed {
  state: ConfigState;
  /** Re-read both documents: the error state's retry, and the conflict's Reload. */
  reload: () => void;
  draftOf: (document: ConfigDocument) => DocumentDraft | undefined;
  saveStateOf: (document: ConfigDocument) => SaveState;
  /** Edit one field. `undefined` deletes the key, which is what clearing an optional field means. */
  setField: (document: ConfigDocument, path: string, value: unknown) => void;
  /** Replace the raw text. Drops any field edits on that document — last edited wins. */
  setText: (document: ConfigDocument, text: string) => void;
  discard: (document: ConfigDocument) => void;
  validate: (document: ConfigDocument) => void;
  save: (document: ConfigDocument) => void;
}

type Drafts = Partial<Record<ConfigDocument, DocumentDraft>>;
type SaveStates = Partial<Record<ConfigDocument, SaveState>>;

/** `CONFIG_INVALID` carries the same list `validateOnly` reports, under `details.errors`. */
function errorsIn(error: ProtocolError): readonly ConfigValidationError[] {
  const listed = error.details?.["errors"];
  if (!Array.isArray(listed)) return [];
  return listed.filter(
    (entry): entry is ConfigValidationError =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ConfigValidationError).path === "string" &&
      typeof (entry as ConfigValidationError).message === "string",
  );
}

/**
 * The feed itself. It is called in exactly one place — `ConfigProvider` — and every screen
 * reads the result through `useConfig()` (`config-context.tsx`), so that a draft outlives
 * the surface it was typed on and there is one answer to "what is unsaved".
 */
export function useConfigFeed(): ConfigFeed {
  const stream = useNotifications();
  const announce = useAnnounce();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ConfigState>({ phase: "loading" });
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saves, setSaves] = useState<SaveStates>({});

  /* The revisions held right now, off React state: the `config.changed` listener has to
     compare against them without being re-subscribed on every read. */
  const revisions = useRef<Partial<Record<ConfigDocument, string>>>({});

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void window.orca.config.get().then((result) => {
      if (!live) return;
      if (!result.ok) {
        setState({ phase: "error", error: result.error });
        return;
      }
      revisions.current = {
        config: result.result.config.revision,
        permissions: result.result.permissions.revision,
      };
      setState({ phase: "ready", data: result.result });
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    /* No `runId` filter: `config.changed` is about a file in the workspace and carries no
       run, so it reaches the store-wide subscription the main process holds. */
    return stream.on("config.changed", (params) => {
      // Our own write, echoed back. The document already says this; re-reading it would
      // throw away the form's scroll position to arrive where it already is.
      if (revisions.current[params.document] === params.revision) return;
      reload();
    });
  }, [reload, stream]);

  const draftOf = useCallback((document: ConfigDocument) => drafts[document], [drafts]);
  const saveStateOf = useCallback((document: ConfigDocument) => saves[document] ?? IDLE, [saves]);

  const setField = useCallback((document: ConfigDocument, path: string, value: unknown) => {
    setDrafts((current) => {
      const held = current[document];
      // A raw draft is dropped rather than merged: the two are different writes.
      const fields = new Map(held?.kind === "form" ? held.fields : []);
      fields.set(path, value);
      return { ...current, [document]: { kind: "form", fields } };
    });
  }, []);

  const setText = useCallback((document: ConfigDocument, text: string) => {
    setDrafts((current) => ({ ...current, [document]: { kind: "raw", text } }));
  }, []);

  const discard = useCallback((document: ConfigDocument) => {
    setDrafts((current) => ({ ...current, [document]: undefined }));
    setSaves((current) => ({ ...current, [document]: IDLE }));
  }, []);

  /**
   * One `config.set`, for both buttons. `validateOnly` is the whole of the difference: the
   * daemon builds the same text, parses it and checks it either way, so a Validate that
   * passed and a Save that failed would be a daemon bug rather than two code paths here.
   */
  const write = useCallback(
    (document: ConfigDocument, validateOnly: boolean) => {
      if (state.phase !== "ready") return;
      const view = document === "config" ? state.data.config : state.data.permissions;
      const draft = drafts[document];
      if (!draft) return;
      if (saves[document]?.busy) return;

      const body: Pick<ConfigSetParams, "text" | "patch"> =
        draft.kind === "raw" ? { text: draft.text } : { patch: patchFrom(draft.fields, view.parsed) };
      if (body.patch?.length === 0) return;

      setSaves((current) => ({ ...current, [document]: { busy: true, errors: [] } }));
      void window.orca.config
        .set({
          document,
          expectedRevision: view.revision,
          ...body,
          ...(validateOnly ? { validateOnly: true } : {}),
        })
        .then((result) => {
          if (!result.ok) {
            const errors = errorsIn(result.error);
            const stale = result.error.code === "CONFIG_STALE";
            setSaves((current) => ({
              ...current,
              [document]: {
                busy: false,
                errors,
                ...(stale ? { conflict: result.error.message } : {}),
                /* The sentence, not the code: `CONFIG_INVALID` is for a log and a bug
                   report, and a person reading a bar wants what is wrong (RULES.md
                   rule 13). The code is still on the wire for whoever needs it. */
                message: result.error.message,
              },
            }));
            announce(
              validateOnly
                ? `Config not valid: ${errors[0]?.message ?? result.error.message}`
                : `Config not saved: ${errors[0]?.message ?? result.error.message}`,
            );
            return;
          }

          const errors = result.result.validation?.errors ?? [];
          if (validateOnly) {
            setSaves((current) => ({
              ...current,
              [document]: {
                busy: false,
                errors,
                message: errors.length === 0 ? "No errors." : `${errors.length} to fix.`,
              },
            }));
            /* The fields carry their errors but do not interrupt (RULES.md rule 11): an
               error on the field somebody is editing is in front of them already. The
               announcer says the first one once, which is what a person who pressed
               Validate and cannot see the form is owed. */
            if (errors.length > 0) announce(`Config not valid: ${errors[0]?.message ?? "see the form"}`);
            return;
          }

          /* Written. The draft is gone because it is now the file, and the document in hand
             is the one the daemon answered with rather than a guess at what it became — the
             new revision included, which is what makes the `config.changed` that follows
             this write recognisable as our own. */
          revisions.current = { ...revisions.current, [document]: result.result.document.revision };
          setState((current) =>
            current.phase === "ready"
              ? { phase: "ready", data: { ...current.data, [document]: result.result.document } }
              : current,
          );
          setDrafts((current) => ({ ...current, [document]: undefined }));
          setSaves((current) => ({ ...current, [document]: { busy: false, errors: [], message: "Saved." } }));
          announce("Config saved");
          /* And then one read, because a write changes more than the document it names: the
             effective permission policy and the schema's own defaults are computed by the
             daemon over both files, and `config.set` answers with neither. The
             `config.changed` this write provokes is still dropped as our own echo — this is
             the read that echo would have been, asked for once and on purpose. */
          reload();
        });
    },
    [announce, drafts, reload, saves, state],
  );

  const validate = useCallback((document: ConfigDocument) => write(document, true), [write]);
  const save = useCallback((document: ConfigDocument) => write(document, false), [write]);

  return { state, reload, draftOf, saveStateOf, setField, setText, discard, validate, save };
}
