/** Setup/navigation stays available before a handshake; authoritative launch controls live in Config. */
import { useEffect } from "react";
import { useKeyboard } from "../keyboard-context.js";
import { launchUrl } from "../route-table.js";
export function PaletteGuidedLaunch({ onOpen }: { onOpen: (url: string) => void }): null {
  const keyboard = useKeyboard();
  useEffect(
    () =>
      keyboard.register({
        scope: "global",
        label: "Launch or recover work",
        detail: "Review a prepared checkout and workflow, or restore an exact protected launch",
        action: () => onOpen(launchUrl()),
      }),
    [keyboard, onOpen],
  );
  return null;
}
