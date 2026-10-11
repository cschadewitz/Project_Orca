/**
 * The command palette: `⌘K`, on `surface-raised` over a scrim, three sections in the order
 * docs/design/10-information-architecture.md sets — actions on the current object,
 * navigation, search — with a jump row above them when what was typed names one object.
 *
 * Focus stays in the query field for as long as the palette is open; the highlighted row
 * is *selection*, carried by `aria-activedescendant`, which is why it draws the accent
 * rail and not the focus ring (docs/design/50-accessibility-and-keyboard.md, "Focus").
 * `Esc` is not handled here: the palette is on the transient layer stack and the one
 * global `Esc` closes whatever is topmost.
 *
 * Two things a write action needs that a navigation row does not (#178):
 *
 * - **An inline confirmation.** A destructive row is *armed* by the first `Enter` and run by
 *   the second: the label becomes the command's `confirm` sentence and the row goes to the
 *   danger tone. Typing or moving the selection disarms it; `Esc` closes the palette, which
 *   unarms with it, because the armed row does not outlive the list it is in. There is
 *   no dialog, because a modal over this modal would move focus out of the query field and
 *   ask the question somewhere other than where the person is looking.
 * - **A picker.** A command that needs an argument — which workflow, which option, which
 *   status — replaces the list with a `Menu` of the choices. It is the app's one popover
 *   primitive rather than a second list here, so the roving keys, the placement, `Esc` and
 *   the focus contract are the ones every other popover has.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { CHROME_GLYPHS } from "@orca/design";
import { useKeyboard } from "../keyboard-context.js";
import type { PaletteChoice, ShortcutPicker } from "../keyboard-map.js";
import { Menu, textClass } from "../ui/index.js";
import { commandEntries, filterEntries, groupEntries, type PaletteEntry } from "./entries.js";
import { parseJump, type JumpTarget } from "./jump.js";
import { usePaletteSources } from "./sources.js";
import { useSourceEntries } from "./use-source-entries.js";
import type { CommandPaletteController } from "./use-command-palette.js";

const LIST_ID = "orca-palette-list";

export interface CommandPaletteProps {
  controller: CommandPaletteController;
  /**
   * Resolve an `orca://` URL — the chrome passes the route table's opener (#165). Without
   * it the jump row is still listed, so what the palette understands stays visible, but it
   * is disabled rather than silently doing nothing.
   */
  onJump?: (target: JumpTarget) => void;
}

export function CommandPalette({ controller, onJump }: CommandPaletteProps): JSX.Element | null {
  const { open, scopes, close } = controller;
  const keyboard = useKeyboard();
  const sources = usePaletteSources();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /** The destructive row waiting for its second `Enter`, by entry id. One at a time. */
  const [armed, setArmed] = useState<string | undefined>(undefined);
  /** The command whose choices are on screen in place of the list. */
  const [picking, setPicking] = useState<ShortcutPicker | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);

  const { entries: fromSources, pending } = useSourceEntries(sources, query, open);

  const commands = useMemo(
    // `open` is a dependency on purpose: the map is mutable, and opening is the moment to
    // read it. Nothing registers or unregisters while the palette has focus.
    () => (open ? commandEntries(keyboard.list(), keyboard.platform, scopes) : []),
    [keyboard, scopes, open],
  );

  const jump = useMemo(() => parseJump(query), [query]);
  const entries = useMemo(() => {
    const matched = filterEntries([...commands, ...fromSources], query);
    if (!jump) return matched;
    const row: PaletteEntry = {
      id: "jump",
      section: "jump",
      label: jump.label,
      detail: jump.detail,
      detailIsMachine: true,
      ...(onJump ? {} : { unavailable: "not resolvable yet" }),
      run: () => onJump?.(jump),
    };
    return [row, ...matched];
  }, [commands, fromSources, query, jump, onJump]);

  const groups = useMemo(() => groupEntries(entries), [entries]);
  /* Selection walks the list in the order it is drawn, not the order the entries were
     gathered in: ↓ from the last row of Actions lands on the first row of Navigation.
     **A disabled row is in that order too.** It is `aria-disabled`, not removed: skipping
     it with the arrows would put its `.orca-palette__why` — the only place the reason is
     said — out of reach of the keyboard, which is exactly what `Button` refuses to do with
     `disabledReason` (docs/design/40-connection-states.md). `Enter` is where it is
     skipped, in `run`. */
  const walkable = groups.flatMap((group) => group.entries);
  const selected = walkable[Math.min(active, Math.max(walkable.length - 1, 0))];

  // A fresh palette every time: the previous query is not a draft, it is a search that
  // finished. Focus the field in the same pass so ⌘K is typing immediately.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setArmed(undefined);
    setPicking(undefined);
    input.current?.focus();
  }, [open]);

  /* A cancelled picker hands focus back to the field it came from. `Menu` returns focus to
     its trigger, and the trigger goes away with the picker, so without this focus lands on
     `<body>` *inside* an open dialog — the palette would still be there with nothing to
     type into and nothing for `Esc` to be pressed on. The field is never unmounted now, so
     there is always somewhere to put focus. */
  const wasPicking = useRef(false);
  useEffect(() => {
    if (picking) {
      wasPicking.current = true;
      return;
    }
    if (!wasPicking.current) return;
    wasPicking.current = false;
    input.current?.focus();
  }, [picking]);

  if (!open) return null;

  const move = (delta: number): void => {
    if (walkable.length === 0) return;
    // Moving off a row disarms it: an armed row is a question about *that* row, and a
    // question nobody is looking at any more has been answered by leaving.
    setArmed(undefined);
    setActive((at) => (at + delta + walkable.length) % walkable.length);
  };

  const run = (entry: PaletteEntry | undefined): void => {
    if (!entry || entry.unavailable) return;
    if (entry.picker) {
      // The list is replaced rather than the palette closed: the choice is still part of
      // running this command, and cancelling it comes back to the row it was chosen from.
      setPicking(entry.picker);
      return;
    }
    if (entry.confirm !== undefined && armed !== entry.id) {
      setArmed(entry.id);
      return;
    }
    // Close first: closing restores focus to where the palette was opened from, and the
    // action may well move focus somewhere else on purpose.
    close();
    entry.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // While the picker is up the keys are the menu's. The field is still on screen and
    // still where focus comes back to, but it is not driving a list right now.
    if (picking) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(walkable.length - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(selected);
    }
  };

  const searchIsEmpty = query.trim() !== "" && !sources.some((source) => source.section === "search");

  return (
    // The scrim closes on a press rather than a click: the press is what takes focus off
    // the field, so waiting for the click would blur first and close second.
    <div className="orca-palette-layer" onMouseDown={close}>
      <div
        className="orca-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          className={`orca-palette__input ${textClass("body")}`}
          type="text"
          role="combobox"
          // The list is gone while the picker is up, so the combobox says so rather than
          // pointing `aria-controls` at an element that is not in the document.
          aria-expanded={picking ? "false" : "true"}
          {...(picking
            ? {}
            : { "aria-controls": LIST_ID, ...(selected ? { "aria-activedescendant": selected.id } : {}) })}
          aria-label="Command palette"
          placeholder="Search actions, or paste a run id or an orca:// link"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setArmed(undefined);
          }}
          onKeyDown={onKeyDown}
        />
        {/* The picker replaces the *list*, never the field: the field is the one thing in
            this dialog focus can go back to, and a cancelled picker has to land somewhere
            (`Menu` returns focus to a trigger that has just been unmounted). */}
        {picking ? (
          <Picker
            picker={picking}
            onCancel={() => setPicking(undefined)}
            onChoose={(id) => {
              setPicking(undefined);
              close();
              picking.choose(id);
            }}
          />
        ) : (
          <>
            {/* Headers and options are siblings inside the one listbox: a `listbox` may only
                contain `option` and `group`, and a header that is its own presentational row
                keeps every option a direct child the way `aria-activedescendant` expects. */}
            <ul className="orca-palette__list" id={LIST_ID} role="listbox" aria-label="Results">
              {groups.map((group) => (
                <Fragment key={group.id}>
                  {group.label ? (
                    <li role="presentation" className={`orca-eyebrow ${textClass("eyebrow")} orca-palette__group`}>
                      {group.label}
                    </li>
                  ) : null}
                  {group.entries.map((entry) => (
                    <Row
                      key={entry.id}
                      entry={entry}
                      armed={entry.id === armed}
                      selected={entry.id === selected?.id}
                      onPick={() => {
                        // A click is a choice, so it takes the selection with it: a
                        // destructive row armed by a click is then the row the next `Enter`
                        // confirms, rather than whichever row the keys had left selected.
                        const at = walkable.indexOf(entry);
                        if (at !== -1) setActive(at);
                        run(entry);
                      }}
                    />
                  ))}
                </Fragment>
              ))}
            </ul>
            {entries.length === 0 && !pending ? (
              <p className={`orca-palette__note ${textClass("caption")}`}>No matching command.</p>
            ) : null}
            {searchIsEmpty ? (
              <p className={`orca-palette__note ${textClass("caption")}`}>
                Searching runs, steps and artifacts needs a source registered; none is.
              </p>
            ) : null}
          </>
        )}
        <div className={`orca-palette__hint ${textClass("caption")}`}>
          <span>↑ ↓ to move</span>
          <span>{picking ? "Enter to choose" : "Enter to run"}</span>
          <span>{picking ? "Esc to go back" : "Esc to close"}</span>
        </div>
      </div>
    </div>
  );
}

function Row({
  entry,
  armed,
  selected,
  onPick,
}: {
  entry: PaletteEntry;
  /** Chosen once already: this row is asking, and the next `Enter` commits. */
  armed: boolean;
  selected: boolean;
  onPick: () => void;
}): JSX.Element {
  const row = `orca-palette__row ${textClass("label")}`;
  const tone = entry.tone === "danger" ? ` orca-palette__row--danger` : "";
  const className = `${row}${tone}${selected ? " orca-palette__row--active" : ""}${
    armed ? " orca-palette__row--armed" : ""
  }`;
  return (
    <li
      id={entry.id}
      role="option"
      className={className}
      aria-selected={selected}
      {...(entry.unavailable ? { "aria-disabled": true } : {})}
      // mousedown, not click: click would blur the query field first.
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
      /* No `onMouseEnter`: hover tints the row (`:hover` in components.css) and moves
         nothing. The selection is the palette's only one and it is the keys', so a stray
         mouse cannot change what `Enter` does (docs/design/10-information-architecture.md,
         "Command palette"). */
    >
      {/* A destructive row carries its glyph as well as its colour, because colour is never
          the only channel (docs/design/RULES.md rule 4). Decorative: the row already says
          "Cancel", and the glyph would only repeat it to a screen reader. */}
      {entry.tone === "danger" ? (
        <span className="orca-palette__glyph" aria-hidden="true">
          {CHROME_GLYPHS.danger}
        </span>
      ) : null}
      {/* The armed row says what the second Enter will do, in the command's own words. */}
      <span className="orca-palette__label">
        <LabelText
          text={armed && entry.confirm !== undefined ? entry.confirm : entry.label}
          {...(entry.labelMachine === undefined ? {} : { machine: entry.labelMachine })}
        />
      </span>
      {entry.detail && !armed ? (
        <span
          className={
            entry.detailIsMachine
              ? `orca-palette__detail ${textClass("caption")} orca-mono`
              : `orca-palette__detail ${textClass("caption")}`
          }
        >
          {entry.detail}
        </span>
      ) : null}
      {entry.unavailable ? (
        <span className={`orca-palette__why ${textClass("caption")}`}>{entry.unavailable}</span>
      ) : null}
      {entry.shortcut ? <kbd className={`orca-kbd ${textClass("mono-id")}`}>{entry.shortcut}</kbd> : null}
    </li>
  );
}

/**
 * A label with the id inside it set in mono — "Release claim on `wi-metrics`" (rule 8: mono
 * means ORCA produced it, and an id in a sentence a person reads is still an id).
 *
 * The split is done here rather than by the caller handing over three strings so that the
 * label stays one string everywhere else: it is what `filterEntries` matches, what names
 * the option, and what a person is read back. A `machine` that does not occur in the text —
 * a run named rather than identified, say — draws the text whole and says nothing about it.
 */
function LabelText({ text, machine }: { text: string; machine?: string }): JSX.Element {
  const at = machine === undefined || machine === "" ? -1 : text.indexOf(machine);
  if (at === -1 || machine === undefined) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className={`orca-mono ${textClass("mono-id")}`}>{machine}</span>
      {text.slice(at + machine.length)}
    </>
  );
}

/**
 * The second step of a command that needs an argument: the choices as a `Menu`, opened by
 * the palette rather than by a press.
 *
 * The menu is *controlled* — the same door `orca://item/<slug>` comes through, which is the
 * one case `Menu` was already given for a disclosure nobody clicked — so everything else
 * about it stays the primitive's: focus moves into the list, `↑`/`↓` rove in the `menu`
 * scope, and `Esc` closes it through the layer stack, which is what brings the palette's own
 * list back.
 *
 * The load happens here and not in the parent so that a cancelled picker takes its pending
 * read with it, and so the "reading…" line is one state of one component. A picker that
 * answers nothing says the command's own sentence rather than showing an empty menu.
 */
function Picker({
  picker,
  onCancel,
  onChoose,
}: {
  picker: ShortcutPicker;
  onCancel: () => void;
  onChoose: (id: string) => void;
}): JSX.Element {
  const [choices, setChoices] = useState<readonly PaletteChoice[] | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void picker.load().then((loaded) => {
      if (live) setChoices(loaded);
    });
    return () => {
      live = false;
    };
  }, [picker]);

  return (
    <div className="orca-palette__picker">
      {choices === undefined ? (
        <p className={`orca-palette__note ${textClass("caption")}`}>Reading the choices…</p>
      ) : choices.length === 0 ? (
        <p className={`orca-palette__note ${textClass("caption")}`}>{picker.empty}</p>
      ) : (
        <Menu
          label={picker.label}
          items={choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            ...(choice.hint === undefined ? {} : { hint: choice.hint }),
            ...(choice.hintMachine === undefined ? {} : { hintMachine: choice.hintMachine }),
          }))}
          onChoose={(item) => onChoose(item.id)}
          open
          onOpenChange={(next) => {
            if (!next) onCancel();
          }}
          triggerClassName={`orca-bare orca-palette__picker-trigger ${textClass("label")}`}
        >
          {picker.label}
        </Menu>
      )}
    </div>
  );
}
