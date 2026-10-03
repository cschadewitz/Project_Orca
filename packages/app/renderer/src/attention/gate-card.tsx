/**
 * `GateCard` — a run parked on a human decision (#161, docs/design/20-attention-and-gates.md).
 *
 * It takes the `OpenInputView` whole rather than the design draft's eight separate fields.
 * The draft's fields *are* that view's fields, and there are two mountings of this card —
 * the Attention list and inline in a run's step detail (#158) — so passing the view is what
 * makes "identical controls and identical keyboard handling" a property of the code rather
 * than of two call sites remembering to spread the same eight things the same way.
 *
 * What the design requires a card to carry without a click is all here: the question, the
 * run and work item it belongs to, how long it has waited, the artifacts the decision is
 * about as chips that open the docked panel, and the options with their consequences.
 */
import type { JSX, Ref } from "react";
import type { OpenInputView } from "@orca/protocol";
import { ArtifactRefs } from "./artifact-refs.js";
import { textClass } from "../ui/index.js";
import { GateRevision } from "./revision-card.js";
import type { RevisionsFeed } from "./use-revisions.js";
import { AnswerCard, type AnswerRequest } from "./answer-card.js";
import { artifactsReady as artifactsAreReady, waitedLabel } from "./card-model.js";

export interface GateCardProps {
  /** The ask, as `inputs.list` and `input.opened` give it. */
  input: OpenInputView;
  placement: "inline" | "inbox";
  revisions?: RevisionsFeed | undefined;
  /**
   * Whether the artifacts the decision is about are in hand. False disables the options
   * with the reason said: the app does not let a person approve something it could not
   * show them. Derived from the ask itself when it is not given (`artifactsReady` in
   * `card-model.ts`), so the list and a step's inline mounting cannot disagree about it.
   */
  artifactsReady?: boolean;
  /** Why this app cannot write, from `useWritability()`. Absent means it can. */
  cannotWrite?: string | undefined;
  focused?: boolean;
  onAnswer: (request: AnswerRequest) => void;
  pending?: boolean;
  outcome?: string | undefined;
  goToRun?: (() => void) | undefined;
  onFocus?: () => void;
  cardRef?: Ref<HTMLElement> | undefined;
}

export function GateCard({ input, artifactsReady, revisions, ...rest }: GateCardProps): JSX.Element {
  const ready = artifactsReady ?? artifactsAreReady(input);
  return (
    <>
      <AnswerCard
        retainedAnswer={revisions?.answerDraft?.(input)}
        id={input.id}
        tone="gate"
        eyebrow={
          <>
            <span>gate</span>
            {/* `.orca-attn__age` is noted `type: mono-id` in components.css: a duration is
              machine text and takes tabular numerals (#211, rule 8). */}
            <span className={`orca-attn__age ${textClass("mono-id")}`}>{waitedLabel(input.waitingMs)}</span>
          </>
        }
        question={input.question}
        subtitle={
          <>
            <span className={`orca-id ${textClass("mono-id")}`}>{input.runName}</span>
            {input.workItem ? ` · ${input.workItem.title}` : ""}
            {input.nodeId ? ` · ${input.nodeId}` : ""}
          </>
        }
        options={input.options}
        excludedOptionId={input.revisionActionId ?? input.revision?.capability.actionId}
        artifactsReady={ready}
        refs={<ArtifactRefs input={input} ready={ready} />}
        {...rest}
      />
      <GateRevision input={input} feed={revisions} artifactsReady={ready} />
    </>
  );
}
