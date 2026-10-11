/** Explicit correction card shared by inbox and step detail. The parent retains it after the originating gate closes. */
import { useEffect, useRef, useState, type JSX } from "react";
import type {
  RevisionBoundaryView,
  PendingRevisionView,
  RevisionCommand,
  ReplacePendingRevisionCommand,
  RevisionResult,
} from "../../../../protocol/src/revision-input.js";
import { Button, Card, Text, Well, textClass } from "../ui/index.js";
import { useWritability } from "../chrome/use-connection.js";
import { useUpdateDraft } from "../update-drafts.js";
import { revisionDraftScope, revisionDraftPayload, REVISION_LABELS, REVISION_REASONS } from "./revision-input-model.js";

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
  const [reviewedVersion, setReviewedVersion] = useState(
    props.pending?.expectedRevision ?? props.boundary.target.expectedRevision,
  );
  const intent = useRef<{ command: string; key: string } | undefined>(undefined);
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
      payload = revisionDraftPayload(
        text,
        props.boundary.capability.payload.kind,
        props.boundary.capability.payload.maxBytes,
      );
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
        <label className="orca-attn__free">
          <Text style="caption">
            {props.boundary.capability.payload.kind === "text" ? "Correction" : "Correction values (JSON)"}
          </Text>
          <textarea
            className={`orca-input ${textClass("body")}`}
            aria-label="Correction"
            value={text}
            readOnly={busy}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <Button
          tone="primary"
          disabled={reason !== undefined || !text.trim()}
          disabledReason={reason ?? "Enter a correction first."}
          onClick={() => void submit()}
        >
          {props.pending ? "Replace pending correction" : "Request changes"}
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
      </div>
    </Card>
  );
}
