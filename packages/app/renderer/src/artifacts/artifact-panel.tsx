/**
 * `ArtifactPanel` — one artifact in the docked panel: its versions, its body, and what read
 * it.
 *
 * Artifacts are the hand-off between agents (ADR 0002), so the panel answers the two
 * questions that makes a person ask: what did this say, and what changed since last time.
 * The version strip is `artifacts.list` by run and name; the body is `artifacts.get`; and
 * a comparison is a second `get` and a line diff done here (`diff.ts`), because the wire
 * carries bodies and not diffs.
 *
 * Four decisions written down because each of them is a thing not to re-open casually:
 *
 * - **Markdown is raw, permanently for now, and there is no toggle (#245).** A markdown
 *   renderer is a dependency decision — `packages/app` takes `react`, `zod` and the two
 *   `@orca/*` workspaces and nothing else — and the input is untrusted: agents write the
 *   bodies. Rule 8 settles it as well: an artifact is machine output and stays in mono.
 *   Reopening this means naming the sanitising renderer in a new issue, not adding a
 *   toggle.
 * - **An omitted body shows its reason where the body would be.** `artifacts.get` declines
 *   a binary or oversized blob with `omitted: { reason, detail }`, and `detail` is written
 *   in words for exactly this spot. It is not an error state: nothing failed, and a retry
 *   button would be a lie.
 * - **`[` and `]` are the panel's, in the `panel` scope.** The docked panel marks that
 *   scope (`chrome/docked-panel.tsx`), so the two keys only step versions while focus is
 *   in here — and they are on the `KeyboardMap`, so the command palette lists them.
 * - **Diff gutters are text, never colour alone** (rule 4). `+` and `−` are in the line;
 *   `.orca-diff__line--add` / `--del` tint it as the third channel.
 */
import { useEffect, useLayoutEffect, useMemo, useState, type JSX } from "react";
import type { RunsGetResult } from "@orca/protocol";
import { useKeyboard } from "../keyboard-context.js";
import { Menu, ObjectId, StateView, Text, Time, textClass, unit, type MenuItem } from "../ui/index.js";
import { diffText, gutterFor, type DiffLine } from "./diff.js";
import { useArtifactPanel, type ArtifactTarget } from "./panel-context.js";
import { useArtifactBody, useArtifactsList } from "./use-artifacts.js";
import "./artifacts.css";

export interface ArtifactPanelProps {
  target: ArtifactTarget;
}

/**
 * The run the artifact belongs to, for the consumed-by links and nothing else. It is read
 * here rather than taken as a prop because the panel is opened from four places and one of
 * them — `orca://artifact/spec.md@v3` — has nothing but the address; a run that cannot be
 * read is a panel with no consumed-by section, not a panel that fails.
 */
function useRunSteps(runId: string): RunsGetResult | undefined {
  const [run, setRun] = useState<RunsGetResult | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setRun(undefined);
    void window.orca.runs.get({ runId }).then((answer) => {
      if (live && answer.ok) setRun(answer.result);
    });
    return () => {
      live = false;
    };
  }, [runId]);
  return run;
}

export function ArtifactPanel({ target }: ArtifactPanelProps): JSX.Element {
  const run = useRunSteps(target.runId);
  const panel = useArtifactPanel();
  const keyboard = useKeyboard();
  const {
    artifacts,
    loading: loadingVersions,
    error: listError,
  } = useArtifactsList({
    runId: target.runId,
    name: target.name,
  });

  const versions = useMemo(() => [...artifacts].sort((a, b) => a.version - b.version), [artifacts]);
  const current = versions.find((a) => a.version === target.version);
  const body = useArtifactBody(target.runId, target.name, target.version);
  const against = useArtifactBody(target.runId, target.name, target.compareWith);

  /* `[` and `]` step the version. Registered in the `panel` scope for as long as the panel
     is showing an artifact, so they cannot collide with a list's keys underneath and so
     the palette lists them with the rest. The map listens outside React, so refresh its
     closures during layout: a key after commit must see the versions on screen, even
     before passive effects flush. */
  useLayoutEffect(() => {
    const at = versions.findIndex((a) => a.version === target.version);
    const step = (delta: number): void => {
      const next = versions[at + delta];
      if (next) panel.select(next.version);
    };
    const off = [
      keyboard.register({ scope: "panel", key: "[", label: "Previous artifact version", action: () => step(-1) }),
      keyboard.register({ scope: "panel", key: "]", label: "Next artifact version", action: () => step(1) }),
    ];
    return () => off.forEach((u) => u());
  }, [keyboard, panel, versions, target.version]);

  const consumers = useMemo(() => consumedBy(run, current?.id), [run, current?.id]);
  const producer = useMemo(
    () => run?.steps.find((step) => step.id === current?.producedByStepRunId),
    [run, current?.producedByStepRunId],
  );

  const compareItems = useMemo<MenuItem[]>(
    () => [
      { id: "none", label: "No comparison" },
      ...versions
        .filter((a) => a.version !== target.version)
        .map((a) => ({ id: String(a.version), label: `Compare with v${a.version}` })),
    ],
    [versions, target.version],
  );

  return (
    <div className="orca-artifact">
      <div className="orca-artifact__head">
        <span className={`orca-artifact__name ${textClass("mono-strong")}`}>{target.name}</span>
        <div className="orca-vers" role="group" aria-label="Artifact versions">
          {versions.map((a) => (
            <button
              key={a.version}
              type="button"
              className={`orca-vers__btn ${textClass("mono-id")}`}
              aria-pressed={a.version === target.version}
              aria-label={`Version ${a.version}`}
              onClick={() => panel.select(a.version)}
            >
              {`v${a.version}`}
            </button>
          ))}
        </div>
        <span className="orca-spacer" />
        {/* A popover is a `Menu`, always: the roving focus, the layer stack and the
            keyboard contract live in one place (#202). */}
        <Menu
          label={
            target.compareWith === undefined ? "Compare with another version" : `Comparing with v${target.compareWith}`
          }
          items={compareItems}
          triggerClassName={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
          onChoose={(item) => panel.compare(item.id === "none" ? undefined : Number(item.id))}
        >
          {target.compareWith === undefined ? "Compare" : `vs v${target.compareWith}`}
        </Menu>
      </div>

      {/* Metadata status belongs to the version choices, independently of immutable body reads. */}
      {loadingVersions && (
        <Text style="caption" as="div" className="orca-artifact__prov">
          Loading artifact versions
        </Text>
      )}
      {listError !== undefined && (
        <div className="orca-artifact__prov">
          <Text style="caption" as="div">
            Could not read artifact versions
          </Text>
          <Text style="mono-id" as="div">
            {`${listError.code}: ${listError.message}`}
          </Text>
        </div>
      )}

      <Provenance target={target} current={current} consumers={consumers} producer={producer} />

      <Body
        loading={body.loading || against.loading}
        error={body.error}
        text={body.text}
        omitted={body.omitted}
        {...(target.compareWith === undefined ? {} : { againstText: against.text ?? "" })}
        compareWith={target.compareWith}
        currentVersion={target.version}
      />
    </div>
  );
}

/** Where the artifact came from, and what read it. Both are links a person follows. */
function Provenance({
  target,
  current,
  consumers,
  producer,
}: {
  target: ArtifactTarget;
  current: ReturnType<typeof useArtifactsList>["artifacts"][number] | undefined;
  consumers: readonly { stepId: string; nodeId: string; attempt: number }[];
  /** The step that wrote this version, when it is one of this run's. */
  producer: { nodeId: string; attempt: number } | undefined;
}): JSX.Element {
  return (
    <div className={`orca-artifact__prov ${textClass("caption")}`}>
      <span className={`orca-id ${textClass("mono-id")}`}>{`${target.name}@v${target.version}`}</span>
      {current !== undefined && (
        <>
          {" · "}
          <Time at={new Date(current.createdAt)} show="absolute" />
          {current.producedByStepRunId !== undefined && (
            <>
              {" · produced by "}
              {/* The step by its node and attempt, the way "read by" names its steps, then its
                  id token; the token alone when this run's steps do not include it. */}
              <span className={`orca-id ${textClass("mono-id")}`}>
                <ObjectId
                  id={current.producedByStepRunId}
                  kind="step"
                  {...(producer === undefined ? {} : { name: `${producer.nodeId} (attempt ${producer.attempt})` })}
                />
              </span>
            </>
          )}
          {current.path !== undefined && (
            <>
              {" · "}
              <span className={`orca-id ${textClass("mono-id")}`}>{current.path}</span>
            </>
          )}
        </>
      )}
      {consumers.length > 0 && (
        <div className="orca-artifact__consumers">
          {"read by "}
          {consumers.map((step, i) => (
            <span key={step.stepId}>
              {i > 0 && ", "}
              <span className={`orca-id ${textClass("mono-id")}`}>{`${step.nodeId} (attempt ${step.attempt})`}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface BodyProps {
  loading: boolean;
  error?: { code: string; message: string } | undefined;
  text?: string | undefined;
  omitted?: { reason: string; detail: string } | undefined;
  againstText?: string;
  compareWith?: number | undefined;
  currentVersion: number;
}

function Body(props: BodyProps): JSX.Element {
  const { loading, error, text, omitted, againstText, compareWith, currentVersion } = props;

  if (loading) return <StateView kind="loading" title="Loading the artifact" />;
  if (error) {
    return <StateView kind="error" title="Could not read this artifact" body={`${error.code}: ${error.message}`} />;
  }
  if (omitted) {
    /* Not an error: the body exists and the daemon has said, in words, why it is not
       sending it. That sentence goes exactly where the body would have been. */
    return (
      <div className={`orca-artifact__body ${textClass("mono-body")}`}>
        <Text style="label" as="div">
          {`This body is not shown (${omitted.reason}).`}
        </Text>
        <Text style="caption" className="orca-faint" as="div">
          {omitted.detail}
        </Text>
      </div>
    );
  }
  if (text === undefined) {
    return <StateView kind="empty" title="No body" body="The daemon answered with neither a body nor a reason." />;
  }
  if (compareWith !== undefined && againstText !== undefined) {
    return <DiffBody from={againstText} to={text} fromVersion={compareWith} toVersion={currentVersion} />;
  }

  /* Raw, and only raw. There is no rendered toggle here, and its absence is the design:
     a markdown renderer is a dependency this package has not taken. */
  return <pre className={`orca-artifact__body ${textClass("mono-body")}`}>{text}</pre>;
}

function DiffBody({
  from,
  to,
  fromVersion,
  toVersion,
}: {
  from: string;
  to: string;
  fromVersion: number;
  toVersion: number;
}): JSX.Element {
  const diff = useMemo(() => diffText(from, to), [from, to]);

  return (
    <div className={`orca-artifact__body ${textClass("mono-body")}`}>
      <Text style="caption" className="orca-faint" as="div">
        {`v${fromVersion} → v${toVersion}: ${unit(diff.added, "added")}, ${unit(diff.removed, "removed")}`}
        {diff.coarse && " — too far apart to line up, shown as a whole-file replacement"}
      </Text>
      <div role="group" aria-label={`Diff of v${fromVersion} and v${toVersion}`}>
        {diff.lines.map((line, i) => (
          <DiffRow key={`${line.op}-${i}`} line={line} />
        ))}
      </div>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }): JSX.Element {
  const modifier = line.op === "add" ? " orca-diff__line--add" : line.op === "del" ? " orca-diff__line--del" : "";
  return (
    <span className={`orca-diff__line${modifier}`}>
      {/* The gutter is in the text, not in a colour: a diff has to survive greyscale and
          a copy-paste (rule 4). */}
      <span className="orca-diff__gutter" aria-hidden="true">
        {gutterFor(line.op)}
      </span>
      {line.text}
    </span>
  );
}

/** The steps of this run that read the artifact — `StepView.inputArtifactIds`, folded. */
function consumedBy(
  run: RunsGetResult | undefined,
  artifactId: string | undefined,
): { stepId: string; nodeId: string; attempt: number }[] {
  if (!run || artifactId === undefined) return [];
  return run.steps
    .filter((step) => step.inputArtifactIds.includes(artifactId))
    .map((step) => ({ stepId: step.id, nodeId: step.nodeId, attempt: step.attempt }));
}
