/** One mounting contract for Attention and step detail, with no invented replacement capability. */
import { useRef, useState, type JSX } from "react";
import type { OpenInputView, RevisionBoundaryView } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { Button, Card, ObjectId, Text, Well, textClass } from "../ui/index.js";
import { ArtifactRefs } from "./artifact-refs.js";
import { artifactsReady } from "./card-model.js";
import { RevisionInputCard } from "./revision-input-card.js";
import { REVISION_LABELS, REVISION_REASONS, revisionDraftScope } from "./revision-input-model.js";
import type { AttentionRevision, RevisionsFeed } from "./use-revisions.js";

export function GateRevision({
  input,
  feed,
  artifactsReady,
}: {
  input: OpenInputView;
  feed?: RevisionsFeed | undefined;
  artifactsReady: boolean;
}): JSX.Element | null {
  const announce = useAnnounce();
  if (!input.revision)
    return input.revisionActionId ? (
      <Text style="caption">Request changes is unavailable until the current revision boundary can be confirmed.</Text>
    ) : null;
  if (!feed?.supported || !artifactsReady)
    return (
      <Text style="caption">
        {!artifactsReady
          ? "Request changes is unavailable until the decision artifacts have loaded."
          : "Request changes is unavailable on this connection."}
      </Text>
    );
  return (
    <RevisionInputCard
      key={revisionDraftScope(feed.scope, input.revision)}
      boundary={input.revision}
      connectionScope={feed.scope}
      supported={feed.supported}
      onSubmit={feed.submit}
      onReplace={feed.replace}
      onRefresh={() => feed.refresh(input.runId)}
      onReceipt={() => {}}
      announce={announce}
    />
  );
}

export function PendingCorrection({ entry, feed }: { entry: AttentionRevision; feed: RevisionsFeed }): JSX.Element {
  const announce = useAnnounce();
  const pending = entry.pending;
  // The original gate's boundary is not authority to replace. Only this protected read is.
  const lastBoundary = useRef<RevisionBoundaryView | undefined>(undefined);
  const [draftVersion, setDraftVersion] = useState(0);
  if (pending?.boundary && pending.payload && pending.replacementAllowed && pending.state === "pending")
    lastBoundary.current = pending.boundary;
  const boundary = lastBoundary.current;
  const editable =
    !entry.reading &&
    !entry.error &&
    feed.supported &&
    pending?.state === "pending" &&
    pending.replacementAllowed &&
    pending.payload &&
    pending.boundary;
  return (
    <section aria-label="Recorded correction" className="orca-attn__cards">
      {entry.input && (
        <div>
          <Text style="body-strong">{entry.input.question}</Text>
          <Text style="mono-id">{entry.input.runName}</Text>
          <ArtifactRefs input={entry.input} ready={artifactsReady(entry.input)} />
        </div>
      )}
      {boundary ? (
        <>
          {entry.reading && <Text style="caption">Checking the current correction. Your draft is preserved.</Text>}
          {entry.error && <Text style="caption">{entry.error} Your draft is preserved.</Text>}
          <fieldset disabled={!editable} style={{ display: "contents" }} aria-label="Correction editor">
            <RevisionInputCard
              key={draftVersion}
              boundary={boundary}
              connectionScope={feed.scope}
              pending={
                pending
                  ? { ...pending, replacementAllowed: Boolean(editable) }
                  : { ...entry.summary, replacementAllowed: false }
              }
              supported={feed.supported}
              onSubmit={feed.submit}
              onReplace={feed.replace}
              onRefresh={() => feed.refresh(entry.summary.target.runId)}
              onReceipt={() => {}}
              announce={announce}
            />
          </fieldset>
          <Button onClick={() => feed.refresh(entry.summary.target.runId)}>Refresh correction</Button>
          <Button
            onClick={() => {
              lastBoundary.current = undefined;
              setDraftVersion((version) => version + 1);
            }}
          >
            Discard correction draft
          </Button>
        </>
      ) : (
        <Card tone="gate" eyebrow="Recorded correction">
          <div className="orca-attn__card-body">
            <Text style="caption">{REVISION_LABELS[entry.summary.state]} correction</Text>
            {/* A read-only summary, so the whole id, with its tail lifted out of it. */}
            <Text style="mono-id">
              Run: <ObjectId id={entry.summary.target.runId} kind="run" variant="full" />
            </Text>
            <Text style="mono-id">Destination: {entry.summary.target.destinationId}</Text>
            <Text style="mono-id">Attempt: {entry.summary.target.attemptId}</Text>
            <Text style="caption">Read-only correction summary. This is separate from an unanswered gate.</Text>
            {entry.reading && (
              <Text style="caption">Checking the current correction. Replacement is unavailable until confirmed.</Text>
            )}
            {entry.error && <Text style="caption">{entry.error}</Text>}
            {entry.summary.unavailableReason && (
              <Text style="caption">{REVISION_REASONS[entry.summary.unavailableReason]}</Text>
            )}
            {/* Text a person wrote is prose, and stays sans; values are machine text, and are
                their indented JSON in a well (rule 8). */}
            {pending?.payload ? (
              pending.payload.kind === "text" ? (
                <pre className={textClass("body")} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {pending.payload.text}
                </pre>
              ) : (
                <Well>{JSON.stringify(pending.payload.values, null, 2)}</Well>
              )
            ) : (
              !entry.reading && <Text style="caption">Correction content is unavailable.</Text>
            )}
            <Button onClick={() => feed.refresh(entry.summary.target.runId)}>Refresh correction</Button>
          </div>
        </Card>
      )}
    </section>
  );
}
