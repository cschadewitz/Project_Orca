/**
 * The palette's open state, and the two things opening it has to get right: the scope
 * chain is captured before focus moves into the query field, and focus goes back where it
 * was when the palette closes (docs/design/50-accessibility-and-keyboard.md).
 *
 * ⌘K is registered in the keyboard map like every other shortcut rather than handled
 * here, so the palette lists its own key alongside the rest.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard } from "../keyboard-context.js";
import { useTransientLayer } from "../layers-context.js";
import { scopesFrom, type ShortcutScope } from "../keyboard-map.js";

export const OPEN_PALETTE_KEY = "Mod+K";

export interface CommandPaletteController {
  open: boolean;
  /** The scopes focus was in when the palette opened, innermost first. */
  scopes: readonly ShortcutScope[];
  openPalette: () => void;
  close: () => void;
}

export function useCommandPalette(): CommandPaletteController {
  const keyboard = useKeyboard();
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState<readonly ShortcutScope[]>(["global"]);
  /* Where focus was. A ref: restoring it must not depend on having re-rendered since. */
  const returnTo = useRef<Element | null>(null);

  const openPalette = useCallback(() => {
    returnTo.current = document.activeElement;
    setScopes(scopesFrom(document.activeElement));
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    const element = returnTo.current;
    returnTo.current = null;
    // Only if it is still in the document: the palette may have been opened from a row
    // that has since been re-rendered away, and focusing a detached node does nothing.
    if (element instanceof HTMLElement && element.isConnected) element.focus();
  }, []);

  useEffect(
    () =>
      keyboard.register({
        scope: "global",
        key: OPEN_PALETTE_KEY,
        label: "Open the command palette",
        action: openPalette,
      }),
    [keyboard, openPalette],
  );

  // The palette is a transient layer, so Esc closes it and only it.
  useTransientLayer(open, { name: "command-palette", close });

  return { open, scopes, openPalette, close };
}
