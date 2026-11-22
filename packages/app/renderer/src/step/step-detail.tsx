/**
 * `StepDetail` — what one step run did: its header, what it produced, what it called, and
 * what it said.
 *
 * It is the pane beside the run tree, and it has two readings. With a step selected it is
 * the step: node, attempt, agent, host and duration; the artifacts it produced as chips
 * that open the docked panel; its tool calls; and its output. With a run selected and no
 * step it is a minimal run summary — the run's variables, its artifacts and its error — in
 * the same pane, because an empty detail pane beside a selected run is a dead end and the
 * three things a run has that its steps do not are worth exactly that much room.
 *
 * Two things the header deliberately does not say:
 *
 * - **No cost, and no token count.** ACP does not necessarily carry it and the ORCA model
 *   does not mention it, so there is nothing to render and approximating it is what rule 12
 *   forbids. docs/design/60-implementation.md leaves room for exactly one more metric here
 *   and this is it; the row below is laid out so that adding it is adding a cell.
 * - **No progress and no estimate**, for the same reason, everywhere in the app.
 *
 * The host is not on `StepView`; it is in `agent.session.opened`, which comes back with the
 * one `runs.events({ stepRunId })` page the output pane already reads (`step-facts.ts`).
 * That is why this file holds one hook and hands its parts to three renderers rather than
 * each of them reading for itself.
 */
import { useCallback, useMemo, useRef, useState, type JSX, type RefObject } from "react";
import type { ConnectionState, RunStatus } from "@orca/design";
import type { ArtifactView, RunsGetResult, StepView } from "@orca/protocol";
import { StepAsks } from "../attention/inline-asks.js";
import { useArtifactPanel } from "../artifacts/panel-context.js";
import { useArtifactsList } from "../artifacts/use-artifacts.js";
import { Duration, KeyValueList, ObjectId, StateView, StatusChip, Text, textClass } from "../ui/index.js";
import { OutputPane, outputLabel, type OutputPaneHandle } from "./output-pane.js";
import { RunRecovery } from "./run-recovery.js";
import { sessionOf } from "./step-facts.js";
import { ToolCallRow } from "./tool-call-row.js";
import { useStepLog } from "./use-step-log.js";
import "./step.css";

export interface StepDetailProps {
  /** The run, whole, as `runs.get` answered it — the run tree already holds one. */
  detail: RunsGetResult;
  /** The step to show. Absent renders the run summary in the same pane. */
  stepRunId?: string | undefined;
  connection: ConnectionState;
  /** Select another run: where a recovery action's new attempt is opened (#357). */
  onOpenRun?: ((runId: string) => void) | undefined;
}

export function StepDetail({ detail, stepRunId, connection, onOpenRun }: StepDetailProps): JSX.Element {
  const step = stepRunId === undefined ? undefined : detail.steps.find((s) => s.id === stepRunId);
  if (step === undefined) return <RunSummary detail={detail} connection={connection} onOpenRun={onOpenRun} />;
  // Keyed on the step so the log hook's buffer, the selection and the search field all
  // start again rather than being carried across to a different step's output.
  return <Step key={step.id} detail={detail} step={step} connection={connection} />;
}

/* ---------- a step ---------- */

function Step({
  detail,
  step,
  connection,
}: {
  detail: RunsGetResult;
  step: StepView;
  connection: ConnectionState;
}): JSX.Element {
  const pane = useRef<OutputPaneHandle>(null);
  const onPrepend = useCallback((rows: number) => pane.current?.shiftBy(rows), []);

  const running = step.status === "running" || step.status === "waiting";
  const log = useStepLog(detail.run.id, step.id, {
    connection,
    // A finished step opens held at the top: there is nothing arriving to follow, and its
    // beginning is where the reason it finished that way usually is.
    openHeld: !running,
    onPrepend,
  });

  const session = useMemo(() => sessionOf(log.events), [log.events]);
  const calls = log.toolCalls;
  const status: RunStatus = step.status;

  return (
    <div className="orca-inspector orca-step">
      <div className="orca-inspector__head">
        <StatusChip status={status} />
        {/* Truncates at its end in a narrow pane, so the whole id is in its title. */}
        <span className={`orca-inspector__title ${textClass("mono-strong")}`} title={step.nodeId}>
          {step.nodeId}
        </span>
        <Text style="caption" className="orca-faint">
          {`attempt ${step.attempt}`}
        </Text>
      </div>

      <div className="orca-step__metrics">
        <Metric label="node">
          <Text style="mono-id">{step.nodeType}</Text>
        </Metric>
        <Metric label="attempt">
          <Text style="mono-id">{String(step.attempt)}</Text>
        </Metric>
        <Metric label="agent">
          <Text style="mono-id">{step.agentId ?? session.agentId ?? unknown}</Text>
        </Metric>
        <Metric label="host">
          <Text style="mono-id">{session.hostId ?? unknown}</Text>
        </Metric>
        <Metric label="duration">
          {/* A duration accruing against a daemon that is not talking is an invented
              number: the clock stops when the connection does. */}
          {step.startedAt !== undefined && step.finishedAt === undefined && connection === "live" ? (
            <Duration since={new Date(step.startedAt)} />
          ) : (
            <Duration ms={step.durationMs ?? 0} />
          )}
        </Metric>
        {/* Exactly one more metric fits here, and it is cost. ORCA cannot supply it
            (rule 12), so the cell is absent rather than empty or approximated. */}
      </div>

      {step.error !== undefined && (
        <Text style="label" as="div" className="orca-step__error">
          {`${step.error.code}: ${step.error.message}`}
        </Text>
      )}
      {session.error !== undefined && step.error === undefined && (
        <Text style="label" as="div" className="orca-step__error">
          {`${session.error.code}: ${session.error.message}`}
        </Text>
      )}

      {/* Where a checkpoint attempt's reused step came from, and an operator's review of a
          step that may have acted outside ORCA (#357): both are facts of the run's history
          that the status chip cannot say. */}
      {step.reusedFrom !== undefined && (
        <Text style="caption" as="div" className="orca-step__note">
          Reused from <ObjectId id={step.reusedFrom.runId} kind="run" />; it did not run here.
        </Text>
      )}
      {step.effectReview !== undefined && (
        <Text style="caption" as="div" className="orca-step__note">
          {(step.effectReview.decision === "run-again"
            ? "Effect reviewed: marked to run again."
            : "Effect reviewed: abandoned; the run ended here.") +
            (step.effectReview.note ? ` ${step.effectReview.note}` : "")}
        </Text>
      )}

      {/* Whatever this step is waiting on a person for, as the same card the Attention
          list draws (#161). Nothing on most steps; on a parked one it is the reason the
          run has stopped, so it sits above the artifacts rather than below the log. */}
      <StepAsks runId={detail.run.id} stepRunId={step.id} />

      <StepArtifacts runId={detail.run.id} stepRunId={step.id} />

      {calls.length > 0 && (
        <div className="orca-step__tools">
          <Text style="eyebrow" as="div" className="orca-inspector__group">
            Tool calls
          </Text>
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} />
          ))}
        </div>
      )}

      <Output log={log} step={step} running={running} paneRef={pane} />
    </div>
  );
}

const unknown = "—";

function Metric({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="orca-step__metric">
      <Text style="eyebrow" as="div" className="orca-faint">
        {label}
      </Text>
      {children}
    </div>
  );
}

function Output({
  log,
  step,
  running,
  paneRef,
}: {
  log: ReturnType<typeof useStepLog>;
  step: StepView;
  running: boolean;
  paneRef: RefObject<OutputPaneHandle | null>;
}): JSX.Element {
  if (log.phase === "loading") return <StateView kind="loading" title="Loading output" className="orca-step__output" />;
  if (log.phase === "error") {
    return (
      <StateView
        kind="error"
        title="Could not read this step's output"
        body={log.error ? `${log.error.code}: ${log.error.message}` : "The daemon answered badly."}
        className="orca-step__output"
      />
    );
  }
  return (
    <OutputPane
      className="orca-step__output"
      label={outputLabel(step.nodeId, step.attempt)}
      rows={log.rows}
      streaming={running}
      mode={log.following ? "following" : "held"}
      pending={log.pending}
      {...(log.earlierBefore === undefined ? {} : { trimmedBefore: log.earlierBefore })}
      loadingEarlier={log.loadingEarlier}
      onJumpToLatest={log.follow}
      onHold={log.hold}
      onLoadEarlier={log.loadEarlier}
      ref={paneRef}
    />
  );
}

/* ---------- the artifacts a step produced ---------- */

function StepArtifacts({ runId, stepRunId }: { runId: string; stepRunId: string }): JSX.Element | null {
  const { artifacts } = useArtifactsList({ runId, producedByStepRunId: stepRunId });
  if (artifacts.length === 0) return null;
  return (
    <div className="orca-step__artifacts">
      <Text style="eyebrow" as="div" className="orca-inspector__group">
        Produced
      </Text>
      <div className="orca-chips">
        {artifacts.map((artifact) => (
          <ArtifactChip key={artifact.id} runId={runId} artifact={artifact} />
        ))}
      </div>
    </div>
  );
}

/**
 * The chip, its click and the panel's open state are one seam: clicking opens the docked
 * panel *and* puts this artifact in it, which is why the target lives in a context above
 * every surface rather than in this one (`artifacts/panel-context.tsx`).
 *
 * A name longer than the pane truncates at its end inside the chip, whole in its title and
 * in its accessible name, rather than being a chip wider than the run of chips it is in.
 */
export function ArtifactChip({ runId, artifact }: { runId: string; artifact: ArtifactView }): JSX.Element {
  const panel = useArtifactPanel();
  const label = `${artifact.name}@v${artifact.version}`;
  return (
    <button
      type="button"
      className={`orca-ref ${textClass("mono-id")}`}
      title={label}
      onClick={() => panel.open({ runId, name: artifact.name, version: artifact.version })}
    >
      <span className="orca-ref__label">{label}</span>
    </button>
  );
}

/* ---------- a run, with no step selected ---------- */

/**
 * The three things a run has that its steps do not: the variables it was started with, the
 * artifacts it produced between them, and the error it ended on. It is deliberately
 * *minimal* — the run tree above it already says what happened, and a second, fuller run
 * screen here would be a rival to it.
 *
 * The variables are a `KeyValueList`, the one display a node's configuration in the
 * Workflows inspector and a launch's review card use too, so a value reads the same in all
 * three: a scalar on the line, an object as its indented JSON in a well.
 */
function RunSummary({
  detail,
  connection,
  onOpenRun,
}: {
  detail: RunsGetResult;
  connection: ConnectionState;
  onOpenRun?: ((runId: string) => void) | undefined;
}): JSX.Element {
  const [showVars, setShowVars] = useState(true);
  const count = Object.keys(detail.vars).length;
  const status: RunStatus = detail.run.status;

  return (
    <div className="orca-inspector orca-step">
      {/* The chip and the name, and no third thing: the caption that followed them was the
          status word again, which the chip had already said. A step's head has a caption
          there because it says something the chip does not — the attempt. */}
      <div className="orca-inspector__head">
        <StatusChip status={status} />
        <span className={`orca-inspector__title ${textClass("mono-strong")}`} title={detail.run.name}>
          {detail.run.name}
        </span>
      </div>

      {detail.run.error !== undefined && (
        <Text style="label" as="div" className="orca-step__error">
          {`${detail.run.error.code}: ${detail.run.error.message}`}
        </Text>
      )}

      <div className="orca-inspector__body">
        <details open={showVars} onToggle={(event) => setShowVars(event.currentTarget.open)}>
          <summary className={`orca-inspector__group ${textClass("eyebrow")}`}>{`Variables (${count})`}</summary>
          {count === 0 ? (
            <Text style="caption" className="orca-faint">
              This run was started with none.
            </Text>
          ) : (
            <KeyValueList values={detail.vars} />
          )}
        </details>

        <Text style="eyebrow" as="div" className="orca-inspector__group">
          {`Artifacts (${detail.artifacts.length})`}
        </Text>
        <div className="orca-chips">
          {detail.artifacts.map((artifact) => (
            <ArtifactChip key={artifact.id} runId={detail.run.id} artifact={artifact} />
          ))}
        </div>

        {detail.run.checkpoint !== undefined && (
          <Text style="caption" as="div" className="orca-step__note">
            A checkpoint attempt of <ObjectId id={detail.run.checkpoint.runId} kind="run" />, started after step{" "}
            <ObjectId id={detail.run.checkpoint.stepRunId} kind="step" />.
          </Text>
        )}

        <RunRecovery detail={detail} onOpenRun={onOpenRun} />

        {connection !== "live" && (
          <Text style="caption" className="orca-faint" as="div">
            Not connected — this is the last the daemon sent.
          </Text>
        )}
      </div>
    </div>
  );
}
