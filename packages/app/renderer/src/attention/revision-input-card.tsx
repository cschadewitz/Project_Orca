/** Explicit correction card shared by inbox and step detail. The parent retains it after the originating gate closes. */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type {
  RevisionBoundaryView,
  PendingRevisionView,
  RevisionCommand,
  ReplacePendingRevisionCommand,
  RevisionPayload,
  RevisionResult,
} from "../../../../protocol/src/revision-input.js";
import { Button, Card, Text, Well, textClass, unit } from "../ui/index.js";
import { useWritability } from "../chrome/use-connection.js";
import { useUpdateDraft } from "../update-drafts.js";
import { diffText, gutterFor, type DiffLine } from "../artifacts/diff.js";
import {
  addToDraft,
  composeModes,
  composeRevisionText,
  recordRevisionVersion,
  revisionDraftScope,
  revisionDraftPayload,
  revisionPayloadText,
  REVISION_LABELS,
  REVISION_REASONS,
  type RevisionComposeMode,
  type RevisionVersionSeen,
  stripImported,
} from "./revision-input-model.js";

export interface RevisionInputCardProps {
  boundary: RevisionBoundaryView;
  /** Workspace identity + connection epoch, captured by the existing connection provider. */
  connectionScope: string;
  /** Current service projection; refreshed by notifications/reconnect and after each mutation, never polling. */
  pending?: PendingRevisionView;
  supported: boolean;
  onSubmit: (command: RevisionCommand, key: string) => Promise<RevisionResult>;
  onReplace: (command: ReplacePendingRevisionCommand, key: string) => Promise<RevisionResult>;
  onRefresh: () => void;
  onReceipt: (result: RevisionResult) => void;
  announce: (message: string) => void;
}
export function RevisionInputCard(props: RevisionInputCardProps): JSX.Element {
  const scope = revisionDraftScope(props.connectionScope, props.boundary);
  const [draftScope, setDraftScope] = useState(scope);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [stale, setStale] = useState(false);
  const [chosenMode, setMode] = useState<RevisionComposeMode>("replace");
  const [history, setHistory] = useState<readonly RevisionVersionSeen[]>(() =>
    recordRevisionVersion([], props.pending),
  );
  // Text copied into the draft from the protected read (current or earlier versions), verbatim.
  const [imported, setImported] = useState<readonly string[]>([]);
  const [sourceScope, setSourceScope] = useState(scope);
  const [revoked, setRevoked] = useState(0);
  const intent = useRef<{ command: string; key: string } | undefined>(undefined);
  // History and copied text are protected content like the read they came from. When that read
  // stops supplying content (denied, unavailable) or the connection/target changes, both go in
  // this same render, before anything commits, and the retry intent that may carry them with it.
  const authorized = Boolean(props.pending?.payload) && sourceScope === scope;
  if (!authorized) {
    if (history.length) setHistory([]);
    if (imported.length) {
      setText((draft) => stripImported(draft, imported));
      setImported([]);
      setRevoked((count) => count + 1);
      intent.current = undefined;
    }
    if (sourceScope !== scope) setSourceScope(scope);
  } else {
    const next = recordRevisionVersion(history, props.pending);
    if (next !== history) setHistory(next);
  }
  useEffect(() => {
    if (!revoked) return;
    setOutcome("Copied correction text was removed because it is no longer available. Your own text is kept.");
    props.announce("Copied correction text removed. Your own text is kept.");
  }, [revoked]);
  const [reviewedVersion, setReviewedVersion] = useState(
    props.pending?.expectedRevision ?? props.boundary.target.expectedRevision,
  );
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useUpdateDraft(Boolean(text));
  const writable = useWritability();
  const version = props.pending?.expectedRevision ?? props.boundary.target.expectedRevision;
  const kind = props.boundary.capability.payload.kind;
  const pendingPayload = props.pending?.payload;
  const modes = composeModes(kind, pendingPayload);
  const mode = modes.includes(chosenMode) ? chosenMode : modes[0]!;
  // The one payload the next agent receives: composed from the pending correction on screen now,
  // which is the version the submit is checked against (expectedRevision), never an older copy.
  const composed = props.pending ? composeRevisionText(pendingPayload, text, mode) : text;
  const result = useMemo((): { payload?: RevisionPayload; error?: string } => {
    if (!text.trim()) return {};
    try {
      return { payload: revisionDraftPayload(composed, kind, props.boundary.capability.payload.maxBytes) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [composed, kind, text, props.boundary.capability.payload.maxBytes]);
  const currentKey = props.pending
    ? JSON.stringify([props.pending.target.revisionId, props.pending.expectedRevision])
    : undefined;
  const earlier = authorized ? history.filter((entry) => entry.key !== currentKey) : [];
  const moved = scope !== draftScope;
  const reason = !writable.can
    ? writable.reason
    : !props.supported
      ? "This adapter does not support explicit revision input."
      : moved
        ? "This draft belongs to a different connection or target. Start a new correction to use this target."
        : busy
          ? "This correction is still with the daemon."
          : stale || reviewedVersion !== version
            ? "Review the current destination and pending correction before submitting again."
            : props.pending && (!props.pending.replacementAllowed || !props.pending.payload)
              ? props.pending.unavailableReason
                ? REVISION_REASONS[props.pending.unavailableReason]
                : "Correction content or replacement permission is unavailable."
              : undefined;
  const submit = async () => {
    if (reason) return;
    let payload;
    try {
      payload = revisionDraftPayload(composed, kind, props.boundary.capability.payload.maxBytes);
    } catch (error) {
      setOutcome((error as Error).message);
      return;
    }
    const command = props.pending
      ? { target: props.pending.target, expectedRevision: props.pending.expectedRevision, payload }
      : { target: props.boundary.target, actionId: props.boundary.capability.actionId, payload };
    const comparison = JSON.stringify(command);
    if (!intent.current || intent.current.command !== comparison)
      intent.current = { command: comparison, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const result = props.pending
        ? await props.onReplace(command as ReplacePendingRevisionCommand, intent.current.key)
        : await props.onSubmit(command as RevisionCommand, intent.current.key);
      if (!mounted.current || activeScope.current !== scope) return;
      props.onReceipt(result);
      if (result.state === "resolved") {
        setText("");
        setImported([]);
        intent.current = undefined;
        setOutcome(
          `${REVISION_LABELS[result.result.state]} correction. It applies only to the displayed destination and attempt.`,
        );
        setStale(true); // Wait for the authoritative pending read before another edit.
        props.announce("Correction recorded.");
        props.onRefresh();
      } else setOutcome("Correction is being recorded. Retry this same intent to inspect its result.");
    } catch (error) {
      if (!mounted.current || activeScope.current !== scope) return;
      const code = (error as { code?: string }).code;
      if (code === "REVISION_STALE") {
        setStale(true);
        props.onRefresh();
      }
      setOutcome(
        code === "REVISION_STALE"
          ? "The correction changed. Your draft is preserved; review the current correction."
          : "The correction could not be confirmed. Your draft and retry identity are preserved.",
      );
      props.announce("Correction not confirmed. Draft preserved.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Card tone="gate" eyebrow="Request changes">
      <div className="orca-attn__card-body">
        <Text style="body-strong">Destination: {props.boundary.destinationDescription}</Text>
        <Text style="caption">
          Takes the declared revision branch once. The correction applies to one intended attempt; it grants no tool
          permission.
        </Text>
        {props.pending && (
          <>
            <Text style="caption">{REVISION_LABELS[props.pending.state]}</Text>
            <Text style="caption">Current correction</Text>
            {/* Values are machine text, so their indented JSON is in a well (rule 8); a person's
                text, and the sentence said when there is none, stay sans. */}
            {props.pending.payload?.kind === "values" ? (
              <Well>{JSON.stringify(props.pending.payload.values, null, 2)}</Well>
            ) : (
              <pre className={textClass("body")} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {props.pending.payload?.kind === "text"
                  ? props.pending.payload.text
                  : "Correction content is unavailable."}
              </pre>
            )}
            {props.pending.unavailableReason && (
              <Text style="caption">{REVISION_REASONS[props.pending.unavailableReason]}</Text>
            )}
          </>
        )}
        {props.pending && pendingPayload && !moved && (
          <ComposeControls
            modes={modes}
            mode={mode}
            disabled={busy}
            onMode={(next) => {
              setMode(next);
              props.announce(
                next === "append"
                  ? "Your draft will be added after the pending correction."
                  : "Your draft will replace the pending correction.",
              );
            }}
            onCopyCurrent={() => {
              if (kind === "values" && text.trim()) return;
              const copied = revisionPayloadText(pendingPayload);
              setText(addToDraft(text, copied));
              setImported((segments) => [...segments, copied]);
              setMode("replace");
              props.announce("Current correction copied into the draft. Submitting replaces the pending correction.");
            }}
            copyDisabledReason={
              kind === "values" && text.trim() ? "Clear the draft to start from the current values." : undefined
            }
          />
        )}
        <label className="orca-attn__free">
          <Text style="caption">
            {props.boundary.capability.payload.kind === "text" ? "Correction" : "Correction values (JSON)"}
          </Text>
          <textarea
            className={`orca-input ${textClass("body")}`}
            aria-label="Correction"
            value={text}
            readOnly={busy}
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              // Emptying the draft empties what was copied into it. A copied segment the person
              // edited stays tracked, so losing its source clears the draft (stripImported).
              setImported((segments) => (next.trim() ? segments : []));
            }}
          />
        </label>
        {result.error && <Text style="caption">{result.error}</Text>}
        {result.payload && props.pending && !moved && (
          <ComposedPreview payload={result.payload} pending={pendingPayload} mode={mode} />
        )}
        <Button
          tone="primary"
          disabled={reason !== undefined || !text.trim() || result.error !== undefined}
          disabledReason={reason ?? result.error ?? "Enter a correction first."}
          onClick={() => void submit()}
        >
          {!props.pending
            ? "Request changes"
            : mode === "append"
              ? "Add to pending correction"
              : "Replace pending correction"}
        </Button>
        {!moved && (stale || reviewedVersion !== version) && (
          <Button
            onClick={() => {
              setReviewedVersion(version);
              setStale(false);
              intent.current = undefined;
            }}
          >
            Use reviewed correction version
          </Button>
        )}
        {moved && (
          <Button
            disabled={busy}
            disabledReason="Wait for the outstanding correction request."
            onClick={() => {
              setText("");
              setImported([]);
              setDraftScope(scope);
              setStale(false);
              setReviewedVersion(version);
              intent.current = undefined;
              setOutcome("");
            }}
          >
            Discard draft and start new correction
          </Button>
        )}
        {outcome && <Text style="caption">{outcome}</Text>}
        {earlier.length > 0 && !moved && (
          <EarlierVersions
            versions={earlier}
            disabled={busy}
            draftEmpty={!text.trim()}
            onUse={(entry) => {
              if (entry.payload.kind === "values" && text.trim()) return;
              const copied = revisionPayloadText(entry.payload);
              setText(addToDraft(text, copied));
              setImported((segments) => [...segments, copied]);
              props.announce("Earlier correction added to the draft. Nothing is sent until you submit.");
            }}
          />
        )}
      </div>
    </Card>
  );
}

const MODE_LABELS: Record<RevisionComposeMode, string> = {
  append: "Add after pending",
  replace: "Replace pending",
};

/** Two explicit ways the draft meets the pending correction. Neither sends anything. */
function ComposeControls(props: {
  modes: readonly RevisionComposeMode[];
  mode: RevisionComposeMode;
  disabled: boolean;
  onMode: (mode: RevisionComposeMode) => void;
  onCopyCurrent: () => void;
  copyDisabledReason: string | undefined;
}): JSX.Element {
  return (
    <div className="orca-attn__compose">
      {props.modes.length > 1 && (
        <div className="orca-seg" role="group" aria-label="How the draft meets the pending correction">
          {props.modes.map((option) => (
            <button
              key={option}
              type="button"
              className={`orca-seg__btn ${textClass("label")}`}
              aria-pressed={option === props.mode}
              disabled={props.disabled}
              onClick={() => props.onMode(option)}
            >
              {MODE_LABELS[option]}
            </button>
          ))}
        </div>
      )}
      <Button
        size="sm"
        disabled={props.disabled || props.copyDisabledReason !== undefined}
        disabledReason={props.copyDisabledReason ?? "This correction is still with the daemon."}
        onClick={props.onCopyCurrent}
      >
        Edit a copy of the current correction
      </Button>
    </div>
  );
}

/** The whole payload the next agent receives, and what changes from the pending one. */
function ComposedPreview(props: {
  payload: RevisionPayload;
  pending: RevisionPayload | undefined;
  mode: RevisionComposeMode;
}): JSX.Element {
  const after = revisionPayloadText(props.payload);
  const diff = useMemo(
    () => (props.pending ? diffText(revisionPayloadText(props.pending), after) : undefined),
    [props.pending, after],
  );
  return (
    <section className="orca-attn__compose-preview" aria-label="What the agent will receive">
      <Text style="caption">
        {props.mode === "append"
          ? "The agent will receive the pending correction with your draft after it:"
          : "The agent will receive only this, in place of the pending correction:"}
      </Text>
      {props.payload.kind === "values" ? (
        <Well>{after}</Well>
      ) : (
        <pre className={textClass("body")} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {after}
        </pre>
      )}
      {diff && (
        <div role="group" aria-label="Changes from the pending correction" className={textClass("mono-body")}>
          <Text style="caption">
            Changes from the pending correction: {unit(diff.added, "added")}, {unit(diff.removed, "removed")}
          </Text>
          {diff.lines.map((line, index) => (
            <DiffRow key={`${line.op}-${index}`} line={line} />
          ))}
        </div>
      )}
    </section>
  );
}

function DiffRow({ line }: { line: DiffLine }): JSX.Element {
  const modifier = line.op === "add" ? " orca-diff__line--add" : line.op === "del" ? " orca-diff__line--del" : "";
  return (
    <span className={`orca-diff__line orca-attn__diff-line${modifier}`}>
      <span className="orca-attn__diff-gutter" aria-hidden="true">
        {gutterFor(line.op)}
      </span>
      {line.op !== "same" && (
        <span className="orca-visually-hidden">{line.op === "add" ? "Added: " : "Removed: "}</span>
      )}
      {line.text}
    </span>
  );
}

/** Versions this window has read. Copying one into the draft never resubmits it or edits history. */
function EarlierVersions(props: {
  versions: readonly RevisionVersionSeen[];
  disabled: boolean;
  draftEmpty: boolean;
  onUse: (entry: RevisionVersionSeen) => void;
}): JSX.Element {
  return (
    <section aria-label="Earlier corrections" className="orca-attn__compose-history">
      <Text style="caption">Earlier corrections read in this window (not stored)</Text>
      <ul className="orca-attn__compose-list">
        {props.versions.map((entry) => {
          const blocked = entry.payload.kind === "values" && !props.draftEmpty;
          return (
            <li key={entry.key}>
              <Text style="caption">Read as {REVISION_LABELS[entry.state].toLowerCase()}</Text>
              {entry.payload.kind === "values" ? (
                <Well>{revisionPayloadText(entry.payload)}</Well>
              ) : (
                <pre className={textClass("body")} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {entry.payload.text}
                </pre>
              )}
              <Button
                size="sm"
                disabled={props.disabled || blocked}
                disabledReason={
                  blocked ? "Clear the draft to start from these values." : "This correction is still with the daemon."
                }
                onClick={() => props.onUse(entry)}
              >
                {entry.payload.kind === "values" ? "Use as draft" : "Add to draft"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
