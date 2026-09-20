/**
 * The arithmetic behind a gate or permission card, in a plain module with a plain test:
 * which option gets which digit, which one is selected when the card opens, and what an
 * "always" answer is allowed to promise afterwards.
 *
 * All three are safety properties rather than presentation, which is why they are here and
 * not inside the components. The one the design states outright is
 * docs/design/20-attention-and-gates.md's: **the destructive option is never bound to `1`
 * and never focused by default.** `1` is where a finger lands and where a held key repeats;
 * an option that cancels a release should not be reachable by being fast.
 */
import type { InputsAnswerResult, OpenInputView } from "@orca/protocol";

/** The wire's own option: `{ id, label, consequence?, destructive? }` as of protocol 1.4. */
export type GateOption = OpenInputView["options"][number];

/** An option with the digit that selects it, or none when there is no digit left. */
export interface BoundOption {
  option: GateOption;
  /** `1`–`9`. Absent past the ninth option — the keyboard has nine digits and no more. */
  digit?: number;
}

/**
 * The options in the order they are drawn *and* keyed: everything that is not destructive
 * first, in the order the agent or workflow offered them, then the destructive ones.
 *
 * Reordering is what makes the rule hold without a special case. Assigning digits in a
 * different order from the drawing order would put `2` above `1` on screen, which is worse
 * than a reordering a person can see; and skipping `1` entirely would leave a card whose
 * first option cannot be typed.
 */
export function bindOptions(options: readonly GateOption[]): readonly BoundOption[] {
  const safe = options.filter((o) => !o.destructive);
  const destructive = options.filter((o) => o.destructive);
  return [...safe, ...destructive].map((option, index) => ({
    option,
    ...(index < 9 ? { digit: index + 1 } : {}),
  }));
}

/**
 * What is selected when the card opens: the first option that is not destructive, or
 * nothing at all when every option is. A card with nothing selected submits nothing, which
 * is the right answer to "every way out of this is destructive — choose one deliberately".
 */
export function defaultSelection(options: readonly GateOption[]): string | undefined {
  return options.find((o) => !o.destructive)?.id;
}

/** Free text rather than a choice: `options` empty is the protocol's way of saying so. */
export const isFreeText = (options: readonly GateOption[]): boolean => options.length === 0;

/**
 * What a card may say after an "always" answer, read from the daemon's own
 * `PermissionRecordView` and never from the button that was pressed.
 *
 * `recordAlwaysDecision` has three outcomes and they mean different things to a person:
 * a rule was written, a rule was already there, or nothing could be derived from this
 * request at all — in which case the answer held once and ORCA *will* ask again. A button
 * that says "ORCA will not ask again" has to read all three before it says so (#221).
 */
export function alwaysOutcome(permission: InputsAnswerResult["permission"]): string | undefined {
  if (!permission) return undefined;
  if (permission.refused) return `ORCA will ask again: ${permission.refused.reason}. This answer held once.`;
  const written = permission.added.length;
  if (written > 0) {
    const rules = written === 1 ? "a rule" : `${written} rules`;
    return `ORCA will not ask again — ${rules} written to ${permission.file}.`;
  }
  if (permission.alreadyPresent.length > 0) return `ORCA already had this rule in ${permission.file}.`;
  // Neither added, nor already present, nor refused: nothing was derived and nothing said
  // so. Rule 12 — say what is known, which is that this answer covered this call.
  return "This answer held once; no standing rule was written.";
}

/**
 * Whether the app has the artifacts this decision is about — the condition behind "if a
 * gate's artifacts have not loaded, the options are disabled with the reason stated".
 *
 * `OpenInputView.artifacts` is the step's artifacts, carried inline so that a card never
 * needs a second call. What can still be missing is an artifact the *question* names:
 * `context` is a free record and a gate raised about one particular document puts its id or
 * its name in there. When it names something the view did not carry, the app cannot show
 * the basis for the decision, and the design is explicit that it must not offer an answer
 * in that state.
 *
 * A gate that names nothing is ready: there is nothing it failed to load.
 */
export function artifactsReady(input: Pick<OpenInputView, "context" | "artifacts">): boolean {
  const named: string[] = [];
  for (const key of ["artifact", "artifacts", "artifactId", "artifactIds"]) {
    const value = input.context[key];
    if (typeof value === "string") named.push(value);
    else if (Array.isArray(value)) named.push(...value.filter((v): v is string => typeof v === "string"));
  }
  if (named.length === 0) return true;
  const held = new Set(input.artifacts.flatMap((a) => [a.id, a.name]));
  return named.every((name) => held.has(name));
}

/** How long it has waited, as the card's eyebrow says it: "waiting 4m". */
export function waitedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `waiting ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `waiting ${hours}h ${minutes % 60}m` : `waiting ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The exact thing a permission ask is about, for the card's mono block.
 *
 * `context` is a free record the asking step attached (docs/design's "the exact command or
 * path, verbatim, in mono. Never summarised"), and the engine puts the tool call's title,
 * its locations or a path in it depending on what the agent asked for. Nothing on the wire
 * names one field for it, so this reads the three the engine writes and gives up honestly
 * rather than summarising the question into something that looks like a command.
 */
export function permissionSubject(context: Record<string, unknown>): string | undefined {
  for (const key of ["command", "path", "title", "toolCall"]) {
    const value = context[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const locations = context["locations"];
  if (Array.isArray(locations)) {
    const paths = locations.filter((l): l is string => typeof l === "string");
    if (paths.length > 0) return paths.join("\n");
  }
  return undefined;
}
