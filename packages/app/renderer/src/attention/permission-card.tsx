/**
 * `PermissionCard` — an agent blocked mid-turn, wanting to run a command or write a file
 * (#161, tier 1 of docs/design/20-attention-and-gates.md).
 *
 * The same component as the gate card underneath, with three differences that are all the
 * tier's:
 *
 * - **The subject is verbatim, in mono, never summarised.** It comes out of the ask's
 *   `context`, which is a free record the asking step attached (`permissionSubject`). When
 *   there is nothing in it, the card shows the question alone rather than inventing a
 *   command from it (rule 12).
 * - **It offers "always".** A permission answer may write a standing rule into the workspace
 *   sidecar, shown first with its lifetime and saved only from that review (#702), and the
 *   two buttons say which way that rule goes, because ORCA will not read an
 *   agent's own option ids and guess (#160, ADR 0009). What was written comes back on the
 *   result and is reported verbatim.
 * - **It says who is asking.** The agent and its host are what makes "allow always" a
 *   decision a person can size, and they come off the ask itself: `OpenInputView.agent` as
 *   of protocol 1.6 (#248), filled by the daemon from the session that opened the ask. A
 *   `decision` or `question` gate has no agent and this card is not used for one; an ask
 *   recorded before 1.6 has none either, and then the card says the run rather than
 *   guessing a process.
 * - **It says what the judge said**, when a plain-language rule's judge looked at the call
 *   before the person was asked (#701): advice on an edit or a command, or why it did not
 *   allow a read or an MCP call. The person answers either way.
 */
import type { JSX, Ref } from "react";
import type { OpenInputView } from "@orca/protocol";
import { ObjectId, textClass } from "../ui/index.js";
import { AnswerCard, type AnswerRequest } from "./answer-card.js";
import { permissionSubject } from "./card-model.js";
import { WaitedAge } from "./waited-age.js";
import { JudgeNote, judgeAskNote } from "./judge-note.js";
import { ScopedRuleChoices } from "./scoped-rule-choices.js";
import { scopedRulePort } from "./scoped-rule-port.js";
import type { ScopedRuleReviewPort } from "./scoped-rule-review.js";

export interface PermissionCardProps {
  /** Inactive owner-injected seam. No production caller supplies this until integration acceptance. */
  scopedRuleReview?: ScopedRuleReviewPort | undefined;
  input: OpenInputView;
  placement: "inline" | "inbox";
  cannotWrite?: string | undefined;
  focused?: boolean;
  onAnswer: (request: AnswerRequest) => void;
  pending?: boolean;
  outcome?: string | undefined;
  goToRun?: (() => void) | undefined;
  onFocus?: () => void;
  cardRef?: Ref<HTMLElement> | undefined;
}

/**
 * Said beside a permission ask's note (#1122): on a Claude Agent SDK session a decline also
 * tells Claude the note. Over ACP it only goes to the log, which the first line already says.
 */
export const PERMISSION_NOTE_REACH =
  "If this agent runs through the Claude Agent SDK, declining also sends this note to Claude. Do not put a password, key or other secret in it.";

export function PermissionCard({ input, scopedRuleReview, ...rest }: PermissionCardProps): JSX.Element {
  scopedRuleReview ??=
    input.live && typeof window !== "undefined" && window.orca?.connection
      ? scopedRulePort(window.orca, input.live.target)
      : undefined;
  const subject = permissionSubject(input.context);
  const judge = judgeAskNote(input.context);
  const agent = input.agent;
  return (
    <AnswerCard
      id={input.id}
      tone="permission"
      eyebrow={
        <>
          <span>permission</span>
          <WaitedAge input={input} />
        </>
      }
      question={scopedRuleReview ? "Review scoped tool permission" : input.question}
      subtitle={
        scopedRuleReview ? (
          "Exact scope is available only through the reviewed disclosure."
        ) : (
          <>
            {/* The run the ask belongs to, first: two asks of the same shape from two runs
                read the same otherwise, and a person could not tell which one they were
                allowing (#1194). Then the work item, as a gate card names it. */}
            {agent ? (
              <>
                <span>{input.runName}</span>
                {input.workItem && input.workItem.title !== input.runName ? ` · ${input.workItem.title}` : ""}
                {" · "}
              </>
            ) : null}
            <span className={`orca-id ${textClass("mono-id")}`}>{agent?.id ?? input.runName}</span>
            {agent?.hostId ? ` on ${agent.hostId}` : ""}
            {` · step `}
            {/* The node's name when the ask carries one; its step's id token when it does not. */}
            <span className={`orca-id ${textClass("mono-id")}`}>
              {input.nodeId ?? <ObjectId id={input.stepRunId} kind="step" />}
            </span>
          </>
        )
      }
      command={scopedRuleReview ? undefined : subject}
      judgeNote={!scopedRuleReview && judge ? <JudgeNote note={judge} /> : undefined}
      // The card cannot tell which way the agent is driven, so it says when the note goes further.
      noteReach={PERMISSION_NOTE_REACH}
      options={input.options}
      offerAlways
      standing={input.standing}
      standingAgentId={agent?.id}
      {...rest}
      answerForm={
        scopedRuleReview ? (
          <ScopedRuleChoices
            key={JSON.stringify([
              scopedRuleReview.scopeKey,
              input.id,
              input.runId,
              input.stepRunId,
              input.live?.target,
              input.live?.state,
            ])}
            port={scopedRuleReview}
            cannotWrite={
              rest.cannotWrite ??
              (rest.pending
                ? "This input already has a pending answer."
                : input.kind !== "permission" || input.revisionActionId !== undefined || input.revision !== undefined
                  ? "Use the explicit input or revision surface for this request."
                  : input.live?.state !== "pending"
                    ? "Permission callback is unavailable or no longer pending."
                    : undefined)
            }
          />
        ) : undefined
      }
      cannotWrite={
        rest.cannotWrite ??
        (!input.live
          ? "Permission callback is unavailable."
          : input.live.state !== "pending"
            ? `Permission callback is ${input.live.state}; this answer cannot be delivered.`
            : undefined)
      }
    />
  );
}
