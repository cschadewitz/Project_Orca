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
 */
import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useKeyboard } from "../keyboard-context.js";
import { textClass } from "../ui/index.js";
import { commandEntries, filterEntries, groupEntries, type PaletteEntry } from "./entries.js";
import { parseJump, type JumpTarget } from "./jump.js";
import { usePaletteSources } from "./sources.js";
import { useSourceEntries } from "./use-source-entries.js";
import type { CommandPaletteController } from "./use-command-palette.js";

const LIST_ID = "orca-palette-list";

export interface CommandPaletteProps {
  controller: CommandPaletteController;
  /**
   * Resolve an `orca://` URL. Omitted until the route table exists (#165), in which case
   * the jump row is still listed — so what the palette understands is visible — but
   * disabled, rather than silently doing nothing.
   */
  onJump?: (target: JumpTarget) => void;
}

export function CommandPalette({ controller, onJump }: CommandPaletteProps): JSX.Element | null {
  const { open, scopes, close } = controller;
  const keyboard = useKeyboard();
  const sources = usePaletteSources();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
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
     gathered in: ↓ from the last row of Actions lands on the first row of Navigation. */
  const runnable = groups.flatMap((group) => group.entries).filter((entry) => !entry.unavailable);
  const selected = runnable[Math.min(active, Math.max(runnable.length - 1, 0))];

  // A fresh palette every time: the previous query is not a draft, it is a search that
  // finished. Focus the field in the same pass so ⌘K is typing immediately.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    input.current?.focus();
  }, [open]);

  if (!open) return null;

  const move = (delta: number): void => {
    if (runnable.length === 0) return;
    setActive((at) => (at + delta + runnable.length) % runnable.length);
  };

  const run = (entry: PaletteEntry | undefined): void => {
    if (!entry || entry.unavailable) return;
    // Close first: closing restores focus to where the palette was opened from, and the
    // action may well move focus somewhere else on purpose.
    close();
    entry.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
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
      setActive(Math.max(runnable.length - 1, 0));
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
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-activedescendant={selected?.id}
          aria-label="Command palette"
          placeholder="Search actions, or paste a run id or an orca:// link"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
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
                  selected={entry.id === selected?.id}
                  onPick={() => run(entry)}
                  onHover={() => {
                    const at = runnable.indexOf(entry);
                    if (at !== -1) setActive(at);
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
            Searching runs, steps and artifacts arrives with the surfaces that hold them.
          </p>
        ) : null}
        <div className={`orca-palette__hint ${textClass("caption")}`}>
          <span>↑ ↓ to move</span>
          <span>Enter to run</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}

function Row({
  entry,
  selected,
  onPick,
  onHover,
}: {
  entry: PaletteEntry;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}): JSX.Element {
  const row = `orca-palette__row ${textClass("label")}`;
  const className = selected ? `${row} orca-palette__row--active` : row;
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
      onMouseEnter={onHover}
    >
      <span className="orca-palette__label">{entry.label}</span>
      {entry.detail ? (
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
