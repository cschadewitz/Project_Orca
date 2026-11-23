/**
 * Workspace storage (#339): which metadata backend the app's own workspace runs on, and, where
 * main offers it, "Switch to SQLite" or "Switch back to files". The renderer never decides
 * whether a switch is possible, which way, or which workspace it applies to: main does, from
 * what the connected daemon reported, and runs it. The switch restarts ORCA: running work must finish and drafts be saved or discarded
 * first, exactly as for an update.
 *
 * Shown only when main reports something to say: a backend, a switch on offer, or how the last
 * one ended. Another daemon (a saved URL, an SSH profile) has nothing here.
 */
import { useEffect, useState, type JSX } from "react";
import type { StoreSwitchState } from "../../../src/store-switch-contract.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { Button, Text } from "../ui/index.js";

const BACKEND_LABEL = { file: "Files", sqlite: "SQLite" } as const;

function lastLine(last: NonNullable<StoreSwitchState["last"]>): string {
  const back = last.to === "files";
  if (last.status === "switched")
    return back ? "Switched back to files on this start." : "Switched to SQLite on this start.";
  if (last.status === "current") return back ? "Already on files." : "Already on SQLite.";
  const stays = back ? "the store stays on SQLite." : "the store stays on files.";
  return `Not switched on this start${last.reason ? ` (${last.reason})` : ""}: ${last.message ?? stays}`;
}

const OFFER = {
  sqlite: {
    button: "Switch to SQLite",
    confirm: "Confirm switch to SQLite",
    text: "ORCA restarts to switch. Running work must finish and drafts be saved or discarded first. A backup of the current store is kept, and ORCA 0.7 and earlier can no longer open this workspace afterwards.",
  },
  files: {
    button: "Switch back to files",
    confirm: "Confirm switch back to files",
    text: "ORCA restarts to switch. Running work must finish and drafts be saved or discarded first. Everything recorded in SQLite is written back to files, and a backup of the current store is kept.",
  },
} as const;

export function StorageSection(): JSX.Element | null {
  const bridge = window.orca.storeSwitch;
  const [state, setState] = useState<StoreSwitchState | undefined>(() => bridge?.read());
  const [confirming, setConfirming] = useState(false);
  const announce = useAnnounce();
  useEffect(() => bridge?.subscribe(setState), [bridge]);
  useEffect(() => {
    if (state?.message) announce(state.message);
  }, [state?.message, announce]);
  if (!bridge || !state || (!state.backend && state.phase === "unavailable")) return null;
  const busy = state.phase === "restarting";
  const to = state.to ?? (state.backend === "file" ? "sqlite" : undefined);
  const offered = (state.phase === "ready" || state.phase === "error") && to !== undefined;
  const offer = OFFER[to ?? "sqlite"];
  return (
    <section className="orca-config__section" aria-label="Workspace storage">
      <Text style="heading" as="h2">
        Workspace storage
      </Text>
      {state.backend && <Text style="body">Run history and plans are kept in: {BACKEND_LABEL[state.backend]}</Text>}
      {state.last && <Text style="caption">{lastLine(state.last)}</Text>}
      {state.message && <Text style="caption">{state.message}</Text>}
      {offered && !confirming && (
        <Button tone="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
          {offer.button}
        </Button>
      )}
      {(confirming || busy) && (
        <div role="group" aria-label={offer.confirm}>
          <Text style="caption">{offer.text}</Text>
          <Button
            tone="primary"
            size="sm"
            disabled={busy}
            onClick={() => {
              void bridge.restart().then((result) => {
                if (!result.ok) announce(result.error.message);
                else setState(result.result);
                setConfirming(false);
              });
            }}
          >
            {busy ? "Preparing restart" : "Restart and switch"}
          </Button>
          <Button tone="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}
