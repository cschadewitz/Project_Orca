/**
 * The editor's dry run (#183): simulate the draft at the revision on screen, with a choice
 * for each gate and person-made decision, and read back what happened - the choices made and
 * by whom, the branches never taken, the nodes never reached, what was assumed, what failed.
 *
 * Docked under the canvas beside the validation panel, so the canvas stays in view: the root
 * graph's unreached nodes and untaken edges are drawn on it (`traceOf`) while the result still
 * describes the revision on screen. A result for an older revision stays readable, says so,
 * and stops drawing on the canvas - it is evidence about bytes the draft no longer has.
 *
 * Nothing here pretends to be a live run: every status reads "… · dry", and the daemon's own
 * limits sentence is printed under the result, whole.
 */
import { useMemo, useState, type JSX } from "react";
import type { DryRunFixtures, DryRunReport, WorkflowDraftDryRunResult } from "@orca/protocol";
import { runUrl } from "../../route-table.js";
import { Button, Menu, StatusChip, Text, counted, textClass } from "../../ui/index.js";
import type { EditorGraph } from "./draft-model.js";

/** A gate, or a decision a person, an agent or the plan makes: what a dry run asks a fixture for. */
export interface ChoicePoint {
  id: string;
  type: "gate" | "decision";
  options: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Option ids as the definition spells them: a bare string, or an object with an `id`. */
function optionIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((option) =>
    typeof option === "string" ? [option] : isRecord(option) && typeof option.id === "string" ? [option.id] : [],
  );
}

/**
 * The graph's choice points, in file order. A decision made by an expression or an artifact
 * is evaluated in a dry run as it would be live, so it takes no fixture and is not listed.
 */
export function choicePoints(graph: EditorGraph): ChoicePoint[] {
  return graph.nodes.flatMap((node): ChoicePoint[] => {
    if (node.state === "removed") return [];
    if (node.type === "gate") return [{ id: node.id, type: "gate", options: optionIds(node.raw.options) }];
    if (node.type === "decision") {
      const kind = isRecord(node.raw.source) ? node.raw.source.kind : undefined;
      if (kind === "expression" || kind === "artifact") return [];
      return [{ id: node.id, type: "decision", options: optionIds(node.raw.options) }];
    }
    return [];
  });
}

/** What the canvas draws for a dry run of the root graph: the nodes and edges it never reached. */
export interface DryRunTrace {
  unreached: ReadonlySet<string>;
  /** `from → to` of each edge out of a reached node that was never followed. */
  untakenEdges: ReadonlySet<string>;
}

export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

export function traceOf(report: DryRunReport): DryRunTrace {
  const root = report.runId;
  return {
    unreached: new Set(report.unreachedNodes.filter((entry) => entry.runId === root).flatMap((e) => e.nodeIds)),
    untakenEdges: new Set(
      report.untakenEdges.filter((edge) => edge.runId === root).map((edge) => edgeKey(edge.from, edge.to)),
    ),
  };
}

const DEFAULT_CHOICE = "";

export interface DryRunPanelProps {
  graph: EditorGraph;
  /** The revision on screen: a result for another one is stale. */
  revision: number;
  busy: boolean;
  /** Validation errors in the draft; the daemon refuses a dry run while there are any. */
  errors: number;
  result: WorkflowDraftDryRunResult | undefined;
  /** Why the last press ran nothing: the draft moved on before it was sent. */
  notice?: string | undefined;
  onRun: (fixtures: DryRunFixtures) => void;
  onClose: () => void;
  /** Open an `orca://` URL: the dry run in the Runs surface. Absent where nothing can navigate. */
  onOpen?: ((url: string) => void) | undefined;
}

export function DryRunPanel({
  graph,
  revision,
  busy,
  errors,
  result,
  notice,
  onRun,
  onClose,
  onOpen,
}: DryRunPanelProps): JSX.Element {
  const points = useMemo(() => choicePoints(graph), [graph]);
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  const fixtures = (): DryRunFixtures => {
    const chosen = Object.entries(choices).filter(
      ([id, choice]) => choice !== DEFAULT_CHOICE && points.some((p) => p.id === id && p.options.includes(choice)),
    );
    return chosen.length ? { choices: Object.fromEntries(chosen) } : {};
  };
  const stale = result !== undefined && result.run.dryRun?.draftRevision !== revision;

  return (
    <section className="orca-wfedit__dryrun" aria-labelledby="orca-wfedit-dryrun">
      <header className="orca-wfedit__validation-head">
        <h2 id="orca-wfedit-dryrun" className={`${textClass("label-strong")} orca-wfedit__heading`}>
          Dry run
        </h2>
        <Text style="caption">No agent, person, workspace or secret takes part; nothing is written.</Text>
        <span className="orca-spacer" />
        <Button
          size="sm"
          tone="primary"
          onClick={() => onRun(fixtures())}
          disabled={busy || errors > 0}
          {...(errors > 0 ? { disabledReason: "Fix the validation errors first" } : {})}
        >
          {result ? "Run it again" : "Run a dry run"}
        </Button>
        <Button size="sm" tone="ghost" onClick={onClose}>
          Close
        </Button>
      </header>

      {points.length > 0 && (
        <ul className="orca-wfedit__dryrun-choices" aria-label="Choices for the dry run">
          {points.map((point) => {
            const chosen = choices[point.id] ?? DEFAULT_CHOICE;
            return (
              <li key={point.id} className={`orca-wfedit__dryrun-choice ${textClass("caption")}`}>
                <span className={textClass("mono-id")}>{point.id}</span>
                <span>{point.type === "gate" ? "answers" : "decides"}</span>
                <Menu
                  label={`What ${point.id} ${point.type === "gate" ? "answers" : "decides"} in the dry run`}
                  items={[
                    { id: DEFAULT_CHOICE, label: "its default" },
                    ...point.options.map((option) => ({ id: option, label: option })),
                  ]}
                  onChoose={(item) => setChoices((held) => ({ ...held, [point.id]: item.id }))}
                  triggerClassName={`orca-wfedit__dryrun-pick ${textClass("mono-id")}`}
                >
                  {chosen === DEFAULT_CHOICE ? "its default" : chosen}
                </Menu>
              </li>
            );
          })}
        </ul>
      )}

      {notice !== undefined && (
        <Text style="caption" role="status">
          {notice}
        </Text>
      )}

      {result && <DryRunResult result={result} stale={stale} onOpen={onOpen} />}
    </section>
  );
}

function DryRunResult({
  result,
  stale,
  onOpen,
}: {
  result: WorkflowDraftDryRunResult;
  stale: boolean;
  onOpen?: ((url: string) => void) | undefined;
}): JSX.Element {
  const { report } = result;
  const untakenOptions = report.untakenOptions.flatMap((entry) =>
    entry.options.map((option) => `${entry.nodeId} → ${option}`),
  );
  const untakenEdges = report.untakenEdges.map((edge) => `${edge.from} → ${edge.to}`);
  const unreached = report.unreachedNodes.flatMap((entry) => entry.nodeIds);
  return (
    <div className="orca-wfedit__dryrun-result" role="status">
      <div className="orca-wfedit__dryrun-line">
        <StatusChip status={result.run.status} dry />
        <Text style="caption">
          {`${report.outcome === "failure" ? "Ended in failure" : report.outcome === "success" ? "Ended in success" : "Stopped"} · ${counted(report.runs.length, "run")} · revision ${result.run.dryRun?.draftRevision ?? "?"}`}
        </Text>
        {stale && <Text style="caption">The draft has changed since; run it again to see this revision.</Text>}
        <span className="orca-spacer" />
        {onOpen && (
          <Button size="sm" tone="ghost" onClick={() => onOpen(runUrl(result.runId))}>
            Open in Runs
          </Button>
        )}
      </div>
      <DryRunList title="Choices made" items={report.choices.map((c) => `${c.nodeId}: ${c.choice} (${c.source})`)} />
      <DryRunList title="Never taken" items={[...untakenOptions, ...untakenEdges]} empty="Every branch was taken." />
      <DryRunList title="Not reached" items={unreached} empty="Every node was reached." />
      <DryRunList title="Assumed" items={report.assumptions.map((a) => `${a.nodeId}: ${a.detail}`)} />
      <DryRunList title="Failed" items={report.failures.map((f) => `${f.nodeId}: ${f.code} - ${f.message}`)} />
      <Text style="caption">{report.limits}</Text>
    </div>
  );
}

function DryRunList({
  title,
  items,
  empty,
}: {
  title: string;
  items: readonly string[];
  empty?: string;
}): JSX.Element | null {
  if (items.length === 0 && empty === undefined) return null;
  return (
    <div className="orca-wfedit__dryrun-group">
      <h3 className={textClass("eyebrow")}>{title}</h3>
      {items.length === 0 ? (
        <Text style="caption">{empty}</Text>
      ) : (
        <ul className={`orca-wfedit__dryrun-list ${textClass("mono-id")}`}>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
