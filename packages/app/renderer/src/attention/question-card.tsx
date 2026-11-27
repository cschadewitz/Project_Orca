/**
 * `QuestionCard` — an agent asking the person something mid-turn (#1133, #1169): Claude's
 * `AskUserQuestion`, a Codex question, or an MCP server's form, as ACP form elicitation.
 *
 * It is the answer-card shell with a form in place of the option buttons, because the answer
 * is the form's content rather than one option. What it shares with a permission ask is the
 * tier: the agent's turn is held open on it, so it says who is asking, it can only be answered
 * while that turn's callback is pending, and it offers no "always" (a question is never
 * permission authority). Declining is an answer too: the agent is told the person would not
 * answer, rather than the turn being cancelled.
 *
 * The form is ORCA's checked subset of the agent's schema (`ElicitationFormSchema`), carried
 * in the ask's `context`. The daemon checks the answer against the form the agent sent, so
 * this card's own checks are for the person, not for safety.
 */
import { useState, type JSX, type Ref } from "react";
import {
  ELICITATION_DECLINE,
  encodeElicitationAnswer,
  type ElicitationField,
  type ElicitationForm,
  type ElicitationValue,
  type OpenInputView,
} from "@orca/protocol";
import { Button, ObjectId, Text, textClass } from "../ui/index.js";
import { AnswerCard, type AnswerRequest } from "./answer-card.js";
import { WaitedAge } from "./waited-age.js";

export interface QuestionCardProps {
  input: OpenInputView;
  form: ElicitationForm;
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

export function QuestionCard({ input, form, ...rest }: QuestionCardProps): JSX.Element {
  const agent = input.agent;
  const cannotWrite =
    rest.cannotWrite ??
    (rest.pending
      ? "this answer is still with the daemon"
      : !input.live
        ? "The agent's question is no longer open."
        : input.live.state !== "pending"
          ? `The agent's question is ${input.live.state}; this answer cannot be delivered.`
          : undefined);
  return (
    <AnswerCard
      id={input.id}
      tone="permission"
      eyebrow={
        <>
          <span>question</span>
          <WaitedAge input={input} />
        </>
      }
      question={input.question}
      subtitle={
        <>
          <span>{input.runName}</span>
          {" · "}
          <span className={`orca-id ${textClass("mono-id")}`}>{agent?.id ?? "agent"}</span>
          {agent?.hostId ? ` on ${agent.hostId}` : ""}
          {` · step `}
          <span className={`orca-id ${textClass("mono-id")}`}>
            {input.nodeId ?? <ObjectId id={input.stepRunId} kind="step" />}
          </span>
        </>
      }
      options={[]}
      {...rest}
      cannotWrite={cannotWrite}
      answerForm={
        <QuestionForm
          key={input.id}
          form={form}
          blocked={cannotWrite}
          pending={rest.pending ?? false}
          outcome={rest.outcome}
          onAnswer={rest.onAnswer}
        />
      }
    />
  );
}

type Values = Record<string, ElicitationValue | undefined>;

function initialValues(form: ElicitationForm): Values {
  const values: Values = {};
  for (const field of form.fields)
    if (field.default !== undefined) values[field.key] = field.kind === "multi" ? [...field.default] : field.default;
  return values;
}

/** Why the form cannot be sent yet, for the person: a required field left empty. */
function missing(form: ElicitationForm, values: Values): string | undefined {
  for (const field of form.fields) {
    const value = values[field.key];
    const empty =
      value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || Number.isNaN(value);
    if (field.required && empty) return `answer "${field.title ?? field.key}" first`;
  }
  return undefined;
}

function QuestionForm({
  form,
  blocked,
  pending,
  outcome,
  onAnswer,
}: {
  form: ElicitationForm;
  blocked: string | undefined;
  pending: boolean;
  outcome: string | undefined;
  onAnswer: (request: AnswerRequest) => void;
}): JSX.Element {
  const [values, setValues] = useState<Values>(() => initialValues(form));
  const set = (key: string, value: ElicitationValue | undefined) => setValues((v) => ({ ...v, [key]: value }));
  const answerBlocked = blocked ?? missing(form, values);
  const send = () => {
    if (answerBlocked !== undefined) return;
    const content: Record<string, ElicitationValue> = {};
    for (const field of form.fields) {
      const value = values[field.key];
      if (value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value))) continue;
      content[field.key] = value;
    }
    onAnswer({ optionId: encodeElicitationAnswer({ action: "accept", content }) });
  };
  return (
    <form
      className="orca-attn__form"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {form.fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key]}
          disabled={blocked !== undefined}
          onChange={(value) => set(field.key, value)}
        />
      ))}
      <div className="orca-card__options">
        <span className="orca-spacer" />
        <Button
          size="sm"
          disabled={blocked !== undefined}
          {...(blocked !== undefined ? { disabledReason: blocked } : {})}
          onClick={() => onAnswer({ optionId: ELICITATION_DECLINE })}
        >
          Decline
        </Button>
        <Button
          size="sm"
          tone="primary"
          onClick={send}
          disabled={answerBlocked !== undefined}
          {...(answerBlocked !== undefined ? { disabledReason: answerBlocked } : {})}
        >
          {pending ? "Answering…" : "Answer"}
        </Button>
      </div>
      {outcome !== undefined && (
        <p className={`orca-card__hint ${textClass("caption")}`} role="status">
          {outcome}
        </p>
      )}
      <p className={`orca-card__hint ${textClass("caption")}`}>
        Your answer goes to the agent and is recorded in the run&rsquo;s log. Decline tells the agent you would not
        answer.
      </p>
    </form>
  );
}

function Field({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ElicitationField;
  value: ElicitationValue | undefined;
  disabled: boolean;
  onChange: (value: ElicitationValue | undefined) => void;
}): JSX.Element {
  const title = field.title ?? field.key;
  const heading = (
    <>
      <Text style="body-strong">
        {title}
        {field.required ? " (required)" : ""}
      </Text>
      {field.description ? <Text style="caption">{field.description}</Text> : null}
    </>
  );
  switch (field.kind) {
    case "choice":
    case "multi": {
      const multi = field.kind === "multi";
      const picked = multi ? (Array.isArray(value) ? value : []) : value;
      return (
        <fieldset className="orca-attn__field" disabled={disabled}>
          <legend className="orca-attn__legend">{heading}</legend>
          {field.options.map((option) => {
            const checked = multi ? (picked as string[]).includes(option.value) : picked === option.value;
            return (
              <label key={option.value} className="orca-attn__option">
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={field.key}
                  value={option.value}
                  checked={checked}
                  onChange={(event) => {
                    if (!multi) onChange(option.value);
                    else {
                      const list = (picked as string[]).filter((v) => v !== option.value);
                      onChange(event.target.checked ? [...list, option.value] : list);
                    }
                  }}
                />
                <span className="orca-attn__option-text">
                  <Text style="body">{option.label}</Text>
                  {option.description ? <Text style="caption">{option.description}</Text> : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      );
    }
    case "boolean":
      return (
        <label className="orca-attn__option orca-attn__field">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="orca-attn__option-text">{heading}</span>
        </label>
      );
    case "number":
      return (
        <label className="orca-attn__free orca-attn__field">
          {heading}
          <input
            className={`orca-input ${textClass("body")}`}
            type="number"
            disabled={disabled}
            aria-label={title}
            {...(field.integer ? { step: 1 } : {})}
            {...(field.minimum !== undefined ? { min: field.minimum } : {})}
            {...(field.maximum !== undefined ? { max: field.maximum } : {})}
            value={typeof value === "number" && !Number.isNaN(value) ? value : ""}
            onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
          />
        </label>
      );
    case "text":
      return (
        <label className="orca-attn__free orca-attn__field">
          {heading}
          <input
            className={`orca-input ${textClass("body")}`}
            type="text"
            disabled={disabled}
            aria-label={title}
            maxLength={Math.min(field.maxLength ?? 4000, 4000)}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      );
  }
}
