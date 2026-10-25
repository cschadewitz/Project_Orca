/**
 * The Config surface's data: one `config.get` on mount, then `config.changed` for
 * everything after it, and the draft a person is holding in between.
 *
 * Current structured/raw Config writes belong to ConfigurationStudioProvider; this feed
 * supplies its target-bound reads. The legacy writes below serve the sidecar and previews.
 *
 * Six decisions about those legacy writes worth knowing before changing anything here:
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
 * - **`expectedRevision` is the revision of the document the draft is sent onto**, and a
 *   refused write keeps the draft. `CONFIG_STALE` means somebody else wrote the file, which
 *   is a thing to tell a person about and never a reason to throw away what they typed: the
 *   bar shows the conflict with **Reload**, the reload brings the new revision, and the same
 *   draft can then be sent against it. The sidecar's draft is its grant edits, one agent at a
 *   time (`policy-model.ts`), so it is composed onto the file at the moment it is sent, and a
 *   `CONFIG_STALE` there is answered by reading again and composing again: the daemon writes
 *   that file on every "allow always", and only a change to an agent the person also edited
 *   is a conflict to show.
 * - **Whatever was typed while a write was out stays.** The draft is cleared only if it is
 *   still the one that was sent, and Discard waits for the write rather than pretending to
 *   stop it.
 * - **Validation errors are the daemon's, placed by path.** `validateOnly` asks the same
 *   questions a write asks and writes nothing; a refused write reports the same list under
 *   `CONFIG_INVALID`'s `details.errors`, so both paths end with a list keyed by path.
 * - **The save announces, because nothing else will.** There is no notification for "your
 *   write was refused", and the one that follows a write that landed says only that the
 *   file moved. So the hook says the sentence itself, into the app's one live region
 *   (`a11y/announce.ts`).
 */
import { useUpdateDraft } from "../update-drafts.js";
import type { EditorTarget } from "../../../src/configuration-launch-contract.js";
import type { BridgeResult } from "../../../src/bridge.js";
import { currentEditorTarget, sameEditorTarget } from "./configuration-adapter.js";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfigDocument,
  ConfigDocumentView,
  ConfigGetResult,
  ConfigSetParams,
  ConfigSetResult,
  ConfigValidationError,
  ProtocolError,
} from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { useNotifications } from "../notifications-context.js";
import { patchFrom, type Draft } from "./config-model.js";
import {
  composeGrants,
  grantsAfterWrite,
  parseSidecar,
  rebaseGrants,
  serializeSidecar,
  withGrantEdit,
  type GrantDrafts,
  type SidecarRule,
} from "./policy-model.js";

export type ConfigState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | { phase: "ready"; data: ConfigGetResult; target?: EditorTarget };

/**
 * What is unsaved for one document. `form` and `raw` are the two writes `config.set` takes;
 * `grants` is the sidecar's, held as the agents a person edited and sent as `text` once it is
 * composed onto the file (`composeGrants`).
 */
export type DocumentDraft =
  { kind: "form"; fields: Draft } | { kind: "raw"; text: string } | { kind: "grants"; agents: GrantDrafts };

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
  /**
   * Replace one agent's written grants in the sidecar's draft. `onDisk` is that agent's rules
   * as the file has them; it becomes the agent's base at its first edit and is ignored after.
   */
  setGrants: (agentId: string, onDisk: readonly SidecarRule[], rules: readonly SidecarRule[]) => void;
  /**
   * The conflict's **Reload**: re-read both documents and keep the draft. A grant draft also
   * takes what the sidecar now holds as what its edits were made against, since the person has
   * been told that it changed, so the Save after it writes their grants.
   */
  reloadDraft: (document: ConfigDocument) => void;
  discard: (document: ConfigDocument) => void;
  validate: (document: ConfigDocument) => void;
  save: (document: ConfigDocument) => void;
}

type Drafts = { [D in ConfigDocument]?: DocumentDraft | undefined };
type SaveStates = Partial<Record<ConfigDocument, SaveState>>;

/** How many times a grant draft is read and composed again after `CONFIG_STALE` before saying so. */
const STALE_RETRIES = 2;

/** What one draft sends onto the document as `view` has it, or why it cannot be sent there. */
type Body = Pick<ConfigSetParams, "text" | "patch"> | { refusal: string; conflict: boolean };

function bodyOf(draft: DocumentDraft, view: ConfigDocumentView): Body {
  if (draft.kind === "raw") return { text: draft.text };
  if (draft.kind === "form") return { patch: patchFrom(draft.fields, view.parsed) };
  const onDisk = parseSidecar(view.text);
  if (onDisk === undefined) {
    return { refusal: `${view.path} is not valid JSON, so no grant can be written into it`, conflict: false };
  }
  const { document, conflicts } = composeGrants(onDisk, draft.agents);
  if (conflicts.length > 0) {
    return { refusal: `the grants for ${conflicts.join(", ")} changed while you were editing them`, conflict: true };
  }
  return { text: serializeSidecar(document) };
}

/** The sidecar's draft over these agents, or none once no agent has an edit left. */
const grantsDraft = (agents: GrantDrafts | undefined): DocumentDraft | undefined =>
  agents === undefined ? undefined : { kind: "grants", agents };

/** What is left of a draft once `sent` is written: only what was typed while it was out. */
function afterWrite(current: DocumentDraft | undefined, sent: DocumentDraft): DocumentDraft | undefined {
  if (current === sent) return undefined;
  if (sent.kind !== "grants" || (current !== undefined && current.kind !== "grants")) return current;
  return grantsDraft(grantsAfterWrite(current?.agents, sent.agents));
}

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
  useUpdateDraft(Object.values(drafts).some(Boolean));
  const [saves, setSaves] = useState<SaveStates>({});

  /* The revisions held right now, off React state: the `config.changed` listener has to
     compare against them without being re-subscribed on every read. */
  const revisions = useRef<Partial<Record<ConfigDocument, string>>>({});

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /** One read's answer, held: the documents, and the revisions a push is compared with. */
  const hold = useCallback((data: ConfigGetResult, target: EditorTarget | undefined) => {
    revisions.current = { config: data.config.revision, permissions: data.permissions.revision };
    setState({ phase: "ready", data, ...(target ? { target } : {}) });
  }, []);

  useEffect(() => {
    let live = true;
    const target = currentEditorTarget(window.orca);
    void window.orca.config.get().then((result) => {
      if (!live) return;
      const currentTarget = currentEditorTarget(window.orca);
      if ((target || currentTarget) && !sameEditorTarget(target, currentTarget)) return;
      if (!result.ok) {
        setState({ phase: "error", error: result.error });
        return;
      }
      hold(result.result, target);
    });
    return () => {
      live = false;
    };
  }, [attempt, hold]);

  useEffect(() => {
    let observed = currentEditorTarget(window.orca);
    return window.orca.daemonConnection?.subscribe(() => {
      const target = currentEditorTarget(window.orca);
      if (target && !sameEditorTarget(target, observed)) reload();
      observed = target;
    });
  }, [reload]);

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

  const setGrants = useCallback((agentId: string, onDisk: readonly SidecarRule[], rules: readonly SidecarRule[]) => {
    setDrafts((current) => {
      const held = current.permissions;
      const agents = held?.kind === "grants" ? held.agents : undefined;
      return { ...current, permissions: grantsDraft(withGrantEdit(agents, agentId, onDisk, rules)) };
    });
  }, []);

  const reloadDraft = useCallback(
    (document: ConfigDocument) => {
      const onDisk =
        document === "permissions" && state.phase === "ready" ? parseSidecar(state.data.permissions.text) : undefined;
      if (onDisk !== undefined && drafts[document]?.kind === "grants") {
        setDrafts((current) => {
          const held = current[document];
          if (held?.kind !== "grants") return current;
          return { ...current, [document]: grantsDraft(rebaseGrants(held.agents, onDisk)) };
        });
        setSaves((current) => ({
          ...current,
          [document]: {
            busy: false,
            errors: [],
            message: "Reloaded. Save writes your grants over the ones that changed.",
          },
        }));
      }
      reload();
    },
    [drafts, reload, state],
  );

  const discard = useCallback(
    (document: ConfigDocument) => {
      // A write that is out cannot be called back, so Discard waits for it rather than pretend.
      if (saves[document]?.busy) return;
      setDrafts((current) => ({ ...current, [document]: undefined }));
      setSaves((current) => ({ ...current, [document]: IDLE }));
    },
    [saves],
  );

  /**
   * One `config.set`, for both buttons. `validateOnly` is the whole of the difference: the
   * daemon builds the same text, parses it and checks it either way, so a Validate that
   * passed and a Save that failed would be a daemon bug rather than two code paths here.
   */
  const write = useCallback(
    (document: ConfigDocument, validateOnly: boolean) => {
      if (state.phase !== "ready") return;
      const view = document === "config" ? state.data.config : state.data.permissions;
      const sent = drafts[document];
      if (!sent) return;
      if (saves[document]?.busy) return;

      /* Not sent, and said: the draft stays for the person to see to. */
      const refuse = (refusal: string, conflict: boolean): void => {
        setSaves((current) => ({
          ...current,
          [document]: { busy: false, errors: [], ...(conflict ? { conflict: refusal } : {}), message: refusal },
        }));
        announce(validateOnly ? `Config not valid: ${refusal}` : `Config not saved: ${refusal}`);
      };

      const body = bodyOf(sent, view);
      if ("refusal" in body) {
        refuse(body.refusal, body.conflict);
        return;
      }
      if (body.patch?.length === 0) return;

      const sendOnto = (onto: ConfigDocumentView, edit: Pick<ConfigSetParams, "text" | "patch">) =>
        window.orca.config.set({
          document,
          expectedRevision: onto.revision,
          ...edit,
          ...(validateOnly ? { validateOnly: true } : {}),
        });

      /* A grant draft is edits, so a sidecar that moved under it is not yet a conflict: the
         daemon writes that file on every "allow always". Read it again and compose the edits
         onto what it holds now; only a change to an agent the person edited too is one, and
         `bodyOf` refuses that rather than writing over it. `undefined` is that refusal, said. */
      const recompose = async (
        result: BridgeResult<ConfigSetResult>,
        retries: number,
      ): Promise<BridgeResult<ConfigSetResult> | undefined> => {
        if (result.ok || result.error.code !== "CONFIG_STALE" || sent.kind !== "grants" || retries === 0) return result;
        const target = currentEditorTarget(window.orca);
        const read = await window.orca.config.get();
        const currentTarget = currentEditorTarget(window.orca);
        if (!read.ok || ((target || currentTarget) && !sameEditorTarget(target, currentTarget))) return result;
        hold(read.result, target);
        const again = bodyOf(sent, read.result[document]);
        if ("refusal" in again) {
          refuse(again.refusal, again.conflict);
          return undefined;
        }
        return recompose(await sendOnto(read.result[document], again), retries - 1);
      };

      setSaves((current) => ({ ...current, [document]: { busy: true, errors: [] } }));
      void sendOnto(view, body)
        .then((result) => recompose(result, STALE_RETRIES))
        .then((result) => {
          if (result === undefined) return;
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

          /* Written. The draft is gone because it is now the file — all but what was typed
             while the write was out (`afterWrite`) — and the document in hand is the one the
             daemon answered with rather than a guess at what it became, the new revision
             included, which is what makes the `config.changed` that follows this write
             recognisable as our own. */
          revisions.current = { ...revisions.current, [document]: result.result.document.revision };
          setState((current) =>
            current.phase === "ready"
              ? { phase: "ready", data: { ...current.data, [document]: result.result.document } }
              : current,
          );
          setDrafts((current) => ({ ...current, [document]: afterWrite(current[document], sent) }));
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
    [announce, drafts, hold, reload, saves, state],
  );

  const validate = useCallback((document: ConfigDocument) => write(document, true), [write]);
  const save = useCallback((document: ConfigDocument) => write(document, false), [write]);

  return { state, reload, draftOf, saveStateOf, setField, setText, setGrants, reloadDraft, discard, validate, save };
}
