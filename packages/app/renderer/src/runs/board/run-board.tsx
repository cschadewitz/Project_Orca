/**
 * The Runs surface's board (#340): the runs that are going, side by side, each on a card that
 * says what state it is in, how far it has got in steps, what it is waiting on, when it last
 * did anything, who drives it, and how current the card itself is.
 *
 * A card is a way in, not a second detail pane: choosing one opens that run in the tree, where
 * its steps, attempts, events and artifacts already are. The board reads nothing the tree
 * would not; it follows the runs live through `use-run-board.ts`.
 */
import type { JSX, ReactNode } from "react";
import type { FollowedRun, RunSummaryView } from "@orca/protocol";
import { Button, ObjectId, StateView, StatusChip, Text, Time, textClass } from "../../ui/index.js";
import { PHASE_WORDS, ownerText, progressText, recoveryLines, waitText } from "./board-model.js";
import type { BoardRecovery } from "./use-board-recovery.js";

export interface RunBoardProps {
  runs: readonly FollowedRun[];
  live: boolean;
  filtered: boolean;
  onOpen: (runId: string) => void;
  onRetry: (runId: string) => void;
  /** Recovery previews of the stopped runs, by run (`useBoardRecovery`). */
  recovery?: ReadonlyMap<string, BoardRecovery> | undefined;
}

export function RunBoard({ runs, live, filtered, onOpen, onRetry, recovery }: RunBoardProps): JSX.Element {
  if (runs.length === 0)
    return (
      <StateView
        kind="empty"
        title="No active runs"
        body={
          filtered
            ? "Nothing the filter shows is going right now."
            : "Runs that are going appear here as they start, and stay once they finish."
        }
      />
    );
  return (
    <ul className="orca-board" aria-label="Followed runs">
      {runs.map((followed) => {
        /* Only what this board's own follower read, in its own scope: never a list row or a
           snapshot from before a workspace or authority change (use-run-board.ts). */
        const run = followed.run;
        return (
          <li key={followed.runId} className="orca-board__item">
            <BoardCard
              followed={followed}
              run={run}
              live={live}
              onOpen={onOpen}
              onRetry={onRetry}
              recovery={recovery?.get(followed.runId)}
            />
          </li>
        );
      })}
    </ul>
  );
}

interface BoardCardProps {
  followed: FollowedRun;
  run: RunSummaryView | undefined;
  live: boolean;
  onOpen: (runId: string) => void;
  onRetry: (runId: string) => void;
  recovery: BoardRecovery | undefined;
}

function BoardCard({ followed, run, live, onOpen, onRetry, recovery }: BoardCardProps): JSX.Element {
  const phase = followed.phase;
  const progress = run ? progressText(run) : undefined;
  const wait = run ? waitText(run) : undefined;
  const owner = run ? ownerText(run) : undefined;
  // The stream's newest event time, which can be past the snapshot's own watermark.
  const activity = followed.lastActivityAt ?? run?.operations?.lastActivityAt;
  const name = run?.name ?? followed.runId;
  return (
    <article className={`orca-board__card orca-board__card--${phase}`} aria-label={`${name}, ${PHASE_WORDS[phase]}`}>
      <div className="orca-board__head">
        {run && <StatusChip status={run.status} />}
        <button
          type="button"
          className={`orca-board__open ${textClass("body-strong")}`}
          onClick={() => onOpen(followed.runId)}
          title="Open in the run tree"
        >
          {name}
        </button>
        <ObjectId id={followed.runId} kind="run" />
      </div>
      <Text style="caption" as="p" className="orca-board__phase" role="status">
        {PHASE_WORDS[phase]}
        {(phase === "stale" || phase === "gone") && followed.error ? ` — ${followed.error}` : ""}
        {(phase === "stale" || phase === "gone") && (
          <>
            {" "}
            <Button size="sm" tone="ghost" onClick={() => onRetry(followed.runId)}>
              Try again
            </Button>
          </>
        )}
      </Text>
      {phase !== "gone" && (
        <dl className="orca-board__facts">
          <Fact term="Progress">{progress ?? "—"}</Fact>
          {wait && <Fact term="Waiting">{wait}</Fact>}
          <Fact term="Last activity">
            {activity ? <Time at={new Date(activity)} show={live ? "relative" : "absolute"} /> : "—"}
          </Fact>
          {owner && <Fact term="Owner">{owner}</Fact>}
          {/* Not measured per run: said, never drawn as zero (rule 12). */}
          <Fact term="Host load">unavailable</Fact>
          <Fact term="Usage">unavailable</Fact>
        </dl>
      )}
      {phase !== "gone" && recovery && (
        <RecoveryPreview recovery={recovery} onOpen={() => onOpen(followed.runId)} name={name} />
      )}
    </article>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }): JSX.Element {
  return (
    <div className="orca-board__fact">
      <Text style="caption" as="dt">
        {term}
      </Text>
      <Text style="caption" as="dd">
        {children}
      </Text>
    </div>
  );
}

/**
 * What recovering a stopped run would do (#357): the daemon's assessment in a line or three,
 * and the way to the run's own recovery section, where the options and controls are.
 */
function RecoveryPreview({
  recovery,
  onOpen,
  name,
}: {
  recovery: BoardRecovery;
  onOpen: () => void;
  name: string;
}): JSX.Element {
  return (
    <section className="orca-board__recovery" aria-label={`Recovery for ${name}`}>
      <Text style="caption" as="h3" className="orca-board__recovery-title">
        Recovery
      </Text>
      {recovery.phase === "loading" && (
        <Text style="caption" as="p">
          Checking what recovery would do
        </Text>
      )}
      {recovery.phase === "error" && (
        <Text style="caption" as="p">
          Not available: {recovery.message}
        </Text>
      )}
      {recovery.phase === "ready" &&
        recoveryLines(recovery.assessment).map((line) => (
          <Text key={line} style="caption" as="p">
            {line}
          </Text>
        ))}
      <Button size="sm" tone="ghost" onClick={onOpen}>
        Open recovery
      </Button>
    </section>
  );
}
