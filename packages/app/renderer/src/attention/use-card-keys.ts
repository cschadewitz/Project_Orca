/**
 * The keys of a focused card, registered on the `KeyboardMap` in the `card` scope:
 * `1`–`9` select an option, `Enter` submits the selected one, `⇧Enter` submits with a note,
 * `G` jumps to the run it came from (docs/design/50-accessibility-and-keyboard.md).
 *
 * **Only the focused card registers them.** Two cards binding `1` in one scope is exactly
 * the collision the map throws on, and that throw is worth keeping — so `focused` gates the
 * registration rather than the action. It also makes the card self-contained: the same
 * component mounted inline in a run (#158's step detail) brings its own keys with it, and
 * the Attention list does not have to hand them down.
 *
 * `J`/`K` are **not** here. Moving between cards is a thing only the list knows how to do,
 * so the surface registers those two in the same scope (`attention-surface.tsx`).
 */
import { useEffect, useRef } from "react";
import { useKeyboard } from "../keyboard-context.js";
import type { BoundOption } from "./card-model.js";

export interface CardKeyActions {
  /** `1`–`9`: select the option with that digit. */
  select: (optionId: string) => void;
  /** `Enter`: submit what is selected. */
  submit: () => void;
  /** `⇧Enter`: submit with a note — open the note field, which submits when it is written. */
  submitWithNote: () => void;
  /** `G`: go to the run this card came from. Absent when the caller gives nowhere to go. */
  goToRun?: () => void;
}

export function useCardKeys(options: readonly BoundOption[], focused: boolean, actions: CardKeyActions): void {
  const keyboard = useKeyboard();

  /* Through a ref, so a card that re-renders on every push does not unregister and
     re-register its keys — a keypress landing between the two would do nothing. The same
     trick `runs/tree/use-tree-keys.ts` uses. */
  const current = useRef(actions);
  current.current = actions;

  /* The digits and their labels, as a string: the effect below must re-run when an option
     is reworded or added, and must not when the array is merely rebuilt. */
  const signature = options.map((b) => `${b.digit ?? 0}:${b.option.id}:${b.option.label}`).join("|");

  useEffect(() => {
    if (!focused) return;
    const off = options.flatMap(({ option, digit }) =>
      digit === undefined
        ? []
        : [
            keyboard.register({
              scope: "card",
              key: String(digit),
              // The label is the palette's row, so it says which option it chooses rather
              // than "select option 3" — a person reading the palette should not have to
              // count the card.
              label: `Choose "${option.label}"`,
              ...(option.consequence ? { detail: option.consequence } : {}),
              action: () => current.current.select(option.id),
            }),
          ],
    );
    return () => off.forEach((remove) => remove());
    /* `signature` rather than `options`: the effect must re-run when an option is reworded
       or added, and must *not* on every render — unregistering and re-registering four
       shortcuts each time would leave a window, however small, in which a keypress does
       nothing. `options` is read through that same render's closure, which is the array
       `signature` was computed from. */
  }, [keyboard, focused, signature]);

  const hasGoToRun = actions.goToRun !== undefined;

  useEffect(() => {
    if (!focused) return;
    const off = [
      keyboard.register({
        scope: "card",
        key: "Enter",
        label: "Answer with the selected option",
        action: () => current.current.submit(),
      }),
      keyboard.register({
        scope: "card",
        key: "Shift+Enter",
        label: "Answer with a note",
        detail: "The note is recorded on the run's `human.answered` event (#238)",
        action: () => current.current.submitWithNote(),
      }),
      ...(hasGoToRun
        ? [
            keyboard.register({
              scope: "card",
              key: "G",
              label: "Go to the run this is waiting on",
              section: "navigation" as const,
              action: () => current.current.goToRun?.(),
            }),
          ]
        : []),
    ];
    return () => off.forEach((remove) => remove());
    /* Whether there is a `goToRun`, not which one: the callback is a closure the caller
       rebuilds every render, and `current` already carries the latest. */
  }, [keyboard, focused, hasGoToRun]);
}
