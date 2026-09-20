/**
 * What the connection state puts on the screen itself, as opposed to in the status bar:
 * the thin stale rule, the blocked bar, and the one blocking dialog.
 *
 * docs/design/40-connection-states.md asks for three different weights of interruption, and
 * the difference between them is the design:
 *
 * - **Reconnecting** — nothing for five seconds, then "a 2px bar appears under the object
 *   header on screens whose data is now stale". The five seconds are not here: they are the
 *   main process's quiet window (`src/main/connection-state.ts`), so *every* rendering of
 *   the state is silent for the same five seconds and no component has its own timer.
 * - **Disconnected** — the same rule, permanently, plus the status bar; the values on the
 *   screens themselves drop to `opacity-stale` and their clocks stop, which is each
 *   surface's own rendering of `isStale` and `clocksRun`.
 * - **Version mismatch** — blocking, once, "with the two versions and what is likely to
 *   break", then a persistent bar. Once means once per detection: dismissing it leaves the
 *   bar, and a later reconnection onto another incompatible daemon is a new detection and
 *   asks again, because it is new news.
 *
 * The rule sits where an object header's underline would, at the top of the content area,
 * because no surface mounts an `ObjectHeader` yet. When one does, this is the element that
 * moves under it.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { CONNECTION_PRESENTATION } from "@orca/design";
import { useTransientLayer } from "../layers-context.js";
import { Button, Text, textClass } from "../ui/index.js";
import { isStale, type Connection } from "../connection.js";
import { useWorkspace } from "./use-workspace.js";

export interface ConnectionBannerProps {
  connection: Connection;
}

/**
 * The bar under the chrome. Three weights: a hairline-thin stale rule that says "what is
 * below is the last thing the daemon sent", the `status-blocked` bar a mismatch leaves
 * behind, and the file-mode bar — both of the latter have words, because a person has to be
 * able to act on them.
 */
export function ConnectionBanner({ connection }: ConnectionBannerProps): JSX.Element | null {
  const { state, versions } = connection;
  const workspace = useWorkspace();

  /* File mode is "a genuinely different product mode, not a degraded one, and the design
     says so": the bar names the store being replayed and offers the way back
     (docs/design/40-connection-states.md). The writes are already *absent* rather than
     disabled — `useWritability()` reads a capability the read-only daemon does not
     advertise — so this bar is the only thing on screen that has to say which mode it is. */
  if (state === "file") {
    return (
      <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
        <Text style="caption">Read-only replay of</Text>
        <span className={`orca-mono ${textClass("mono-id")}`}>{workspace.path}</span>
        <span className="orca-spacer" />
        <Button size="sm" onClick={() => void window.orca.workspace.connectLive()}>
          Connect to a daemon
        </Button>
      </div>
    );
  }

  if (state === "mismatch") {
    return (
      <div className={`orca-banner ${textClass("caption")} orca-banner--mismatch`} role="status">
        <Text style="caption">
          {versions
            ? `This daemon speaks protocol ${versions.daemon} and this app speaks ${versions.app}. Everything on screen is readable; nothing can be sent.`
            : "This daemon speaks a protocol this app cannot type-check. Everything on screen is readable; nothing can be sent."}
        </Text>
      </div>
    );
  }

  if (!isStale(state)) return null;

  /* No text and no live region: the status bar has already announced the word, and the
     rule's whole job is to mark the screen below it as last-known. */
  return <div className="orca-stale-rule" role="presentation" />;
}

export interface MismatchDialogProps {
  connection: Connection;
}

/**
 * The blocking dialog, once per detection. `since` is the machine's "when this state was
 * entered", so it is also the identity of *this* detection — dismissing records the one
 * that was dismissed rather than a boolean that could never let a second one through.
 *
 * It closes onto a readable app rather than onto nothing: the event log is the
 * compatibility surface, so reading goes on working and only the writes are gone.
 */
export function MismatchDialog({ connection }: MismatchDialogProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const key = connection.since.toISOString();
  const open = connection.state === "mismatch" && dismissed !== key;
  const dialog = useRef<HTMLDivElement>(null);

  useTransientLayer(open, { name: "version-mismatch", close: () => setDismissed(key) });

  /* Focus the dialog itself rather than its button: the dialog is what the person has to
     read, and a screen reader entering on the button would announce the way out first. */
  useEffect(() => {
    if (open) dialog.current?.focus();
  }, [open]);

  if (!open) return null;
  const { glyph, word } = CONNECTION_PRESENTATION.mismatch;
  const versions = connection.versions;

  return (
    <div className="orca-dialog-layer">
      <div
        ref={dialog}
        className="orca-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="orca-mismatch-title"
        tabIndex={-1}
      >
        <h2 className={`orca-dialog__title ${textClass("title")}`} id="orca-mismatch-title">
          <span aria-hidden="true">{glyph}</span> {word}
        </h2>
        <Text style="body" as="p" className="orca-dialog__body">
          {versions
            ? `The daemon speaks protocol ${versions.daemon}; this app speaks ${versions.app}.`
            : "The daemon speaks a protocol this app cannot type-check."}
        </Text>
        <Text style="body" as="p" className="orca-dialog__body">
          Runs, steps and event logs stay readable, because the event log is the compatibility surface. Starting,
          cancelling and answering a gate are not: they need a call this app cannot type-check, and every control that
          sends one is disabled and says so. Run the two on the same version to get them back.
        </Text>
        <div className="orca-dialog__actions">
          <Button tone="primary" onClick={() => setDismissed(key)}>
            Continue read-only
          </Button>
        </div>
      </div>
    </div>
  );
}
