/**
 * The relationship inspector (#171), drawn in the docked panel when the graph has a node
 * selected: what the node is blocked by, what it blocks, and the waive for each dependency
 * that is still holding something.
 *
 * It is option A's inspector kept inside option B (`docs/design/80-dependency-graph-options.md`):
 * a panel about the *relationship* rather than about the item as a row. Waiving is
 * irreversible from the app, so it is armed first, and the confirmation names what it
 * unblocks. The answer is folded straight into the graph (`onWaived`), without a re-read.
 */
import { useState, type JSX } from "react";
import type { DependencyView } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { useMethodPresent, useWritability } from "../chrome/use-connection.js";
import { Button, Text, textClass } from "../ui/index.js";
import { edgeState, fromName, isUnmet, targetName, waiveQuestion, type DepNode } from "./graph-model.js";

import { InlineConfirmation, InlineConfirmationTrigger, useInlineConfirmation } from "./inline-confirmation.js";

export interface RelationshipInspectorProps {
  planId: string;
  node: DepNode;
  blockedBy: readonly DependencyView[];
  blocks: readonly DependencyView[];
  onWaived: (dependency: DependencyView) => void;
}

export function RelationshipInspector({
  planId,
  node,
  blockedBy,
  blocks,
  onWaived,
}: RelationshipInspectorProps): JSX.Element {
  return (
    <div
      key={JSON.stringify([planId, node.id])}
      className="orca-plan__inspector"
      aria-label={`Relationships of ${node.name}`}
      tabIndex={-1}
    >
      <div className="orca-plan__section">
        <Text style="label-strong" as="h2">
          {node.title ?? node.name}
        </Text>
        <span className={`orca-plan__id ${textClass("mono-id")}`}>{node.name}</span>
      </div>
      <Relations
        label="Blocked by"
        empty="It waits for nothing."
        dependencies={blockedBy}
        name={targetName}
        planId={planId}
        onWaived={onWaived}
      />
      <Relations
        label="Blocks"
        empty="Nothing waits for it."
        dependencies={blocks}
        name={fromName}
        planId={planId}
        onWaived={onWaived}
      />
    </div>
  );
}

function Relations({
  label,
  empty,
  dependencies,
  name,
  planId,
  onWaived,
}: {
  label: string;
  empty: string;
  dependencies: readonly DependencyView[];
  name: (d: DependencyView) => string;
  planId: string;
  onWaived: (dependency: DependencyView) => void;
}): JSX.Element {
  const canWaive = useMethodPresent("dependencies.waive");
  return (
    <section className="orca-plan__section" aria-label={label}>
      <Text style="eyebrow" as="h3">
        {label}
      </Text>
      {dependencies.length === 0 ? (
        <Text style="caption">{empty}</Text>
      ) : (
        <ul className={`orca-plan__lines ${textClass("caption")}`}>
          {dependencies.map((d) => (
            <li key={d.id}>
              <span className={textClass("mono-id")}>{name(d)}</span>
              {/* Kind, then state in words (never colour alone), then the scheduler's line. */}
              <Text style="caption">{` — ${d.type}, ${edgeState(d)}: ${d.evaluation.detail}`}</Text>
              {canWaive && isUnmet(d) && (
                <Waive key={JSON.stringify([planId, d.id])} planId={planId} dependency={d} onWaived={onWaived} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Waive({
  planId,
  dependency,
  onWaived,
}: {
  planId: string;
  dependency: DependencyView;
  onWaived: (dependency: DependencyView) => void;
}): JSX.Element {
  const announce = useAnnounce();
  const writability = useWritability();
  const confirmation = useInlineConfirmation();
  const [busy, setBusy] = useState(false);
  const reason = writability.can ? undefined : writability.reason;

  const waive = (): void => {
    const owner = confirmation.question;
    if (!owner || busy) return;
    setBusy(true);
    void window.orca.plan.waive({ planId, dependencyId: dependency.id }).then((result) => {
      if (!confirmation.isMounted()) return;
      setBusy(false);
      confirmation.close(owner, !result.ok);
      if (result.ok) {
        onWaived(result.result.dependency);
        announce(`${fromName(dependency)} no longer waits for ${targetName(dependency)}.`);
      } else {
        announce(`That did not go through: ${result.error.message}`);
      }
    });
  };

  return confirmation.question ? (
    <InlineConfirmation confirmation={confirmation} label={`Waive ${dependency.id}`}>
      <Text style="caption">{waiveQuestion(dependency)}</Text>
      <div className="orca-plan__actions">
        <Button data-plan-confirm-keep="" tone="ghost" size="sm" onClick={confirmation.cancel}>
          Keep it
        </Button>
        <Button
          tone="danger"
          size="sm"
          disabled={busy || reason !== undefined}
          {...(reason === undefined ? {} : { disabledReason: reason })}
          onClick={waive}
        >
          {`Waive, unblocking ${fromName(dependency)}`}
        </Button>
      </div>
    </InlineConfirmation>
  ) : (
    <InlineConfirmationTrigger confirmation={confirmation} size="sm" tone="ghost">
      {`Waive ${targetName(dependency)}…`}
    </InlineConfirmationTrigger>
  );
}
