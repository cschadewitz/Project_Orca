/**
 * The config save bar (`.orca-draftbar`): how many changes are held, and the three things
 * that can be done with them.
 *
 * It is written as a component of its own rather than as markup inside the surface because
 * it is not only the config surface's: "the draft bar is the config editor's save bar with
 * two more actions" (docs/design/70-workflow-editing.md). The workflow editor adds
 * **Validate all** and **Publish** to this; what it must not do is draw a second bar that
 * looks like this one and counts differently.
 *
 * Three rules it keeps:
 *
 * - **It is absent, not disabled, where writes are absent.** File mode and a `--read-only`
 *   daemon have no `config.set` to call, and a greyed Save on a viewer reads as broken
 *   (docs/design/40-connection-states.md). The surface decides that with
 *   `useMethodPresent("config.set")` — the method the button calls, not the capability
 *   above it — and does not render this at all; `disabledReason` is for the other three
 *   states, where the daemon would take the write if it were answering.
 * - **A conflict is shown here and nowhere else.** `CONFIG_STALE` means somebody else wrote
 *   the file, and the one thing that must not happen is losing the draft over it — so the
 *   bar turns `--blocked`, says what happened and offers **Reload**, and the draft is still
 *   there afterwards to be sent against the new revision.
 * - **The count is of what would be written**, not of what was typed: an edit back to the
 *   file's own value is not a change (`patchFrom`).
 * - **It hands focus back when it goes.** The bar is there while there is something to write,
 *   so the Save or Discard that empties the draft unmounts the bar with the button a person
 *   just pressed, and focus would fall to the page body. If the bar held focus as it left,
 *   focus goes to `returnFocus()` — the region the draft was editing, which each surface names
 *   — the way a removed row hands focus on (`focusAfterLeaving`). Focus a person had already
 *   moved out of the bar is left where they put it.
 */
import { useLayoutEffect, useRef, type JSX } from "react";
import { Button, Text, textClass } from "../ui/index.js";
import { changeLabel } from "./config-model.js";

export interface DraftBarProps {
  /** How many field edits, or 1 for a raw-text draft — the bar counts writes, not keystrokes. */
  changes: number;
  /** A call is out. The buttons wait rather than sending a second write. */
  busy: boolean;
  /** The `CONFIG_STALE` message. Turns the bar `--blocked` and offers Reload. */
  conflict?: string;
  /** What the last Validate or Save said, in words. */
  message?: string;
  /** Why the daemon cannot take a write right now, from `useWritability()`. */
  disabledReason?: string;
  /** Which of the two drafts is live, when the person has been in both views. */
  note?: string;
  /**
   * Where focus goes if the bar leaves while holding it — Save or Discard brought the count to
   * zero. The region the draft edits: the Written grants list in the policy panel, the form or
   * the raw text on the Config surface. Read as the bar leaves, so it can name an element the
   * same commit drew.
   */
  returnFocus?: () => HTMLElement | null | undefined;
  onValidate: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}

export function DraftBar({
  changes,
  busy,
  conflict,
  message,
  disabledReason,
  note,
  returnFocus,
  onValidate,
  onSave,
  onDiscard,
  onReload,
}: DraftBarProps): JSX.Element {
  const blocked = conflict !== undefined;
  const stale = `The file changed since you read it: ${conflict}`;
  const bar = useRef<HTMLDivElement>(null);
  const target = useRef(returnFocus);
  target.current = returnFocus;

  /* The last moment the bar can tell whether it holds focus: a layout effect's cleanup runs
     before React takes the bar out of the document (as `ClaimRow` and `Grant` do it). The move
     waits for the commit to finish, so the target is the one that commit drew, and it is made
     only if focus has fallen to the body — nothing else in the commit claimed it. */
  useLayoutEffect(() => {
    const element = bar.current;
    return () => {
      if (!element?.contains(document.activeElement)) return;
      const to = target.current;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body) return;
        to?.()?.focus();
      });
    };
  }, []);

  return (
    <div
      ref={bar}
      className={`orca-draftbar ${textClass("caption")}${blocked ? " orca-draftbar--blocked" : ""}`}
      role="group"
      aria-label="Unsaved configuration changes"
    >
      {/* One line (RULES.md rule 15). The count keeps its width and is one unit; the
          sentences after it give way first, cut at their end and whole in their title. */}
      <Text style="label-strong">{changeLabel(changes)}</Text>
      {note !== undefined && (
        <Text style="caption" className="orca-truncate" title={note}>
          {note}
        </Text>
      )}
      {conflict !== undefined && (
        /* Not a live region: the bar is where the person is already looking, and the save
           they pressed announces through the app's one announcer (`use-config.ts`). */
        <Text style="caption" className="orca-truncate" title={stale}>
          {stale}
        </Text>
      )}
      {conflict === undefined && message !== undefined && (
        <Text style="caption" className="orca-truncate" title={message}>
          {message}
        </Text>
      )}
      <span className="orca-spacer" />
      {blocked && (
        <Button size="sm" tone="ghost" onClick={onReload}>
          Reload
        </Button>
      )}
      <Button size="sm" tone="ghost" onClick={onDiscard}>
        Discard
      </Button>
      <Button
        size="sm"
        onClick={onValidate}
        disabled={busy || disabledReason !== undefined}
        {...(disabledReason === undefined ? {} : { disabledReason })}
      >
        Validate
      </Button>
      <Button
        size="sm"
        tone="primary"
        onClick={onSave}
        disabled={busy || disabledReason !== undefined}
        {...(disabledReason === undefined ? {} : { disabledReason })}
      >
        Save
      </Button>
    </div>
  );
}
