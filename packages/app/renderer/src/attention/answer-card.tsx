/**
 * The shell both interruption cards are: the question, what it is about, the options with
 * their consequences, and the one control that sends an answer.
 *
 * `GateCard` and `PermissionCard` are the two tones of this with different bodies. They are
 * one component underneath because the *behaviour* is the part the design pins — "the same
 * `GateCard` / `PermissionCard` component renders in the Attention list and inline in the
 * run, with identical controls and identical keyboard handling" — and two implementations
 * of that behaviour would be two chances to get the destructive-option rule wrong.
 *
 * Four things here are not decoration:
 *
 * - **The destructive option is never on `1` and never selected.** That is `card-model.ts`,
 *   with its own test; this file only draws what it says.
 * - **Options are disabled with the reason on the control**, never disabled and silent. Two
 *   reasons reach it: the artifacts the decision is about have not loaded (the app does not
 *   let a person approve something it could not show them), and the connection cannot write
 *   (`useWritability()`, whose sentence is shaped for `Button`'s `disabledReason` so that a
 *   control never composes its own).
 * - **A note is not something the run recorded.** `human.answered` has no field for it, so
 *   the daemon writes it to the operator log and returns it (#238) — and the field says so
 *   rather than letting a person believe the workflow will see it.
 * - **"Always" is stated, not inferred.** ORCA will not read an agent's option ids and guess
 *   that `allow_always` means allow, so the two always-buttons say which way the rule goes;
 *   what they wrote comes back in `permission` and is reported verbatim (`alwaysOutcome`).
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type Ref } from "react";
import { Button, Card, Text, textClass } from "../ui/index.js";
import { scopeProps } from "../keyboard-map.js";
import { bindOptions, defaultSelection, isFreeText, type GateOption } from "./card-model.js";
import { useCardKeys } from "./use-card-keys.js";

/** What a card sends. `optionId` is an option's id, or the text of a free-text answer. */
export interface AnswerRequest {
  optionId: string;
  note?: string;
  /** Only ever set from the two always-buttons, and only on a permission ask. */
  always?: { decision: "allow" | "deny" };
}

export interface AnswerCardProps {
  /** The input's id: the card's DOM id, and what an answer names. */
  id: string;
  tone: "gate" | "permission";
  /** The kicker: the tier's word and how long it has waited. */
  eyebrow: ReactNode;
  question: string;
  /** One line under the question: where it came from. */
  subtitle: ReactNode;
  /** The exact command or path, verbatim and in mono. Permission asks only. */
  command?: string | undefined;
  options: readonly GateOption[];
  /** The artifacts the decision is about, as chips that open the docked panel. */
  refs?: ReactNode;
  /**
   * Rendered inline in a run, or in the attention list. Behaviour is identical; the only
   * difference is that the list's card announces itself and the replayed inline one may not.
   */
  placement: "inline" | "inbox";
  /** True when the artifacts are in hand. False disables the options, with the reason said. */
  artifactsReady?: boolean;
  /** Why this app cannot write right now, from `useWritability()`. Absent means it can. */
  cannotWrite?: string | undefined;
  /** This card has the keyboard: it registers `1`–`9`, `Enter`, `⇧Enter` and `G`. */
  focused?: boolean;
  /** Offer "always": a permission ask can write a standing rule, a gate cannot. */
  offerAlways?: boolean;
  onAnswer: (request: AnswerRequest) => void;
  /** An answer is in flight; the controls wait rather than being pressed twice. */
  pending?: boolean;
  /** What the daemon said afterwards — what an "always" wrote, or why the answer failed. */
  outcome?: string | undefined;
  /** `G`, and the run link. Absent until there is a route table to open one (#165). */
  goToRun?: (() => void) | undefined;
  onFocus?: () => void;
  /** The card body, so a list can move focus between cards. A callback ref is fine. */
  cardRef?: Ref<HTMLElement> | undefined;
}

export function AnswerCard({
  id,
  tone,
  eyebrow,
  question,
  subtitle,
  command,
  options,
  refs,
  placement,
  artifactsReady = true,
  cannotWrite,
  focused = false,
  offerAlways = false,
  onAnswer,
  pending = false,
  outcome,
  goToRun,
  onFocus,
  cardRef,
}: AnswerCardProps): JSX.Element {
  /* Memoised on the options themselves: the bound list is what `useCardKeys` registers
     from, and a new array each render would mean four shortcuts unregistered and
     re-registered on every push. */
  const bound = useMemo(() => bindOptions(options), [options]);
  const [selected, setSelected] = useState<string | undefined>(() => defaultSelection(options));
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [text, setText] = useState("");
  const noteField = useRef<HTMLInputElement | null>(null);

  /* The options can change under a card: an ask re-read after a reconnection comes back as
     a new object, and an option the workflow reworded is a different label for the same id.
     Selection follows the ids rather than the array, so a re-read does not silently move
     what `Enter` would send. */
  const ids = options.map((o) => o.id).join("|");
  useEffect(() => {
    setSelected((current) => (current && ids.split("|").includes(current) ? current : defaultSelection(options)));
    // `ids` is what this depends on; `options` is listed because it is read, and a re-read
    // that produced the same ids produces the same selection, so the extra run is a no-op.
  }, [ids, options]);

  useEffect(() => {
    if (noteOpen) noteField.current?.focus();
  }, [noteOpen]);

  const free = isFreeText(options);
  const answerValue = free ? text.trim() : selected;

  /* Two reasons, and they disable different things. `blocked` is about the card as a whole
     — there is nothing to answer *with*, or nothing to answer *to* — so it takes the option
     buttons down with it. Not having chosen yet is only a reason the submit cannot go, and
     disabling the options for it would be a card that cannot be answered at all. */
  const blocked = !artifactsReady
    ? "the artifacts this decision is about have not loaded; ORCA will not offer an answer it cannot show the basis for"
    : cannotWrite !== undefined
      ? cannotWrite
      : pending
        ? "this answer is still with the daemon"
        : undefined;
  const submitBlocked = blocked ?? (answerValue ? undefined : free ? "type an answer first" : "choose an option first");

  const send = (over: Partial<AnswerRequest> = {}): void => {
    if (submitBlocked !== undefined || !answerValue) return;
    onAnswer({ optionId: answerValue, ...(note.trim() ? { note: note.trim() } : {}), ...over });
  };

  useCardKeys(bound, focused && !pending, {
    select: setSelected,
    submit: () => send(),
    submitWithNote: () => (noteOpen && note.trim() ? send() : setNoteOpen(true)),
    ...(goToRun ? { goToRun } : {}),
  });

  return (
    <Card
      tone={tone}
      eyebrow={eyebrow}
      /* Assertive when it is genuinely asking (rule 11, and the one interruption the design
         intends). A card replayed inline in a finished run is not asking anybody. */
      interrupt={placement === "inbox"}
      className="orca-attn__card"
    >
      {/* The card owns the `card` scope, so a keypress anywhere inside it — including on an
          option button — resolves to this card's keys before the list's (#149). A single
          tab stop on the card itself is what `J`/`K` move between. */}
      <section
        {...scopeProps("card")}
        id={`attention-card-${id}`}
        ref={cardRef}
        tabIndex={0}
        aria-label={question}
        onFocus={onFocus}
        className="orca-attn__card-body"
      >
        <p className={`orca-card__q ${textClass("body-strong")}`}>{question}</p>
        <div className={`orca-card__sub ${textClass("caption")}`}>{subtitle}</div>
        {command !== undefined && <div className={`orca-card__cmd ${textClass("mono-log")}`}>{command}</div>}
        {refs}

        {free ? (
          <label className="orca-attn__free">
            <Text style="caption">Answer</Text>
            <input
              className={`orca-input ${textClass("body")}`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="Answer"
            />
          </label>
        ) : null}

        <div className="orca-card__options">
          {bound.map(({ option, digit }) => (
            <Button
              key={option.id}
              size="sm"
              tone={option.destructive ? "danger" : option.id === selected ? "primary" : "default"}
              aria-pressed={option.id === selected}
              disabled={blocked !== undefined}
              {...(blocked !== undefined ? { disabledReason: blocked } : {})}
              onClick={() => setSelected(option.id)}
            >
              {digit !== undefined && <kbd className={`orca-kbd ${textClass("mono-id")}`}>{digit}</kbd>}
              {option.label}
            </Button>
          ))}
          <span className="orca-spacer" />
          <Button
            size="sm"
            tone="primary"
            disabled={submitBlocked !== undefined}
            {...(submitBlocked !== undefined ? { disabledReason: submitBlocked } : {})}
            onClick={() => send()}
          >
            {pending ? "Answering…" : "Answer"}
          </Button>
          {offerAlways && (
            <>
              {/* Two buttons and not one, because which way the standing rule goes is the
                  client's to state (#160): ORCA will not read an agent's option ids and
                  guess. What they actually wrote comes back on the result. */}
              <Button
                size="sm"
                disabled={submitBlocked !== undefined}
                {...(submitBlocked !== undefined ? { disabledReason: submitBlocked } : {})}
                onClick={() => send({ always: { decision: "allow" } })}
              >
                Always allow
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={submitBlocked !== undefined}
                {...(submitBlocked !== undefined ? { disabledReason: submitBlocked } : {})}
                onClick={() => send({ always: { decision: "deny" } })}
              >
                Always deny
              </Button>
            </>
          )}
        </div>

        {/* The consequences, under the options rather than on them: an option's button is a
            row-height control and a clause is a sentence (rule 9). */}
        {bound.some(({ option }) => option.consequence) && (
          <ul className="orca-attn__consequences">
            {bound
              .filter(({ option }) => option.consequence)
              .map(({ option }) => (
                <li key={option.id} className={textClass("caption")}>
                  <span className="orca-attn__consequence-for">{option.label}</span> — {option.consequence}
                </li>
              ))}
          </ul>
        )}

        {noteOpen && (
          <label className="orca-attn__note">
            <Text style="caption">Note — recorded in the daemon&rsquo;s operator log, not in the run&rsquo;s log</Text>
            <input
              ref={noteField}
              className={`orca-input ${textClass("body")}`}
              value={note}
              aria-label="Note"
              onChange={(event) => setNote(event.target.value)}
              /* The field's own submit key. The map's `⇧Enter` cannot reach here — a bare
                 key in a text entry types rather than dispatching, which is what stops `J`
                 in a query field from moving a list three layers down (`keyboard-map.ts`). */
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  send();
                }
              }}
            />
          </label>
        )}

        {outcome !== undefined && (
          <p className={`orca-card__hint ${textClass("caption")}`} role="status">
            {outcome}
          </p>
        )}

        <p className={`orca-card__hint ${textClass("caption")}`}>
          {goToRun
            ? "1–9 choose · Enter answers · ⇧Enter adds a note · G opens the run"
            : "1–9 choose · Enter answers · ⇧Enter adds a note"}
        </p>
      </section>
    </Card>
  );
}
