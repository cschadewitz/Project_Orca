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
 *   sidecar, and the two buttons say which way that rule goes, because ORCA will not read an
 *   agent's own option ids and guess (#160, ADR 0009). What was written comes back on the
 *   result and is reported verbatim.
 * - **It says who is asking.** The agent and its host are what makes "allow always" a
 *   decision a person can size, and they come off the ask itself: `OpenInputView.agent` as
 *   of protocol 1.6 (#248), filled by the daemon from the session that opened the ask. A
 *   `decision` or `question` gate has no agent and this card is not used for one; an ask
 *   recorded before 1.6 has none either, and then the card says the run rather than
 *   guessing a process.
 */
import type { JSX, Ref } from "react";
import type { OpenInputView } from "@orca/protocol";
import { textClass } from "../ui/index.js";
import { AnswerCard, type AnswerRequest } from "./answer-card.js";
import { permissionSubject, waitedLabel } from "./card-model.js";

export interface PermissionCardProps {
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

export function PermissionCard({ input, ...rest }: PermissionCardProps): JSX.Element {
  const subject = permissionSubject(input.context);
  const agent = input.agent;
  return (
    <AnswerCard
      id={input.id}
      tone="permission"
      eyebrow={
        <>
          <span>permission</span>
          {/* `.orca-attn__age` is noted `type: mono-id` in components.css: a duration is
              machine text and takes tabular numerals (#211, rule 8). */}
          <span className={`orca-attn__age ${textClass("mono-id")}`}>{waitedLabel(input.waitingMs)}</span>
        </>
      }
      question={input.question}
      subtitle={
        <>
          <span className={`orca-id ${textClass("mono-id")}`}>{agent?.id ?? input.runName}</span>
          {agent?.hostId ? ` on ${agent.hostId}` : ""}
          {` · step `}
          <span className={`orca-id ${textClass("mono-id")}`}>{input.nodeId ?? input.stepRunId}</span>
        </>
      }
      command={subject}
      options={input.options}
      offerAlways
      {...rest}
    />
  );
}
