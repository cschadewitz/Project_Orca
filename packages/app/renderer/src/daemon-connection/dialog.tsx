/** Authenticated endpoint dialog with inline failures and explicit cancellation. */
import { useEffect, useRef, useState, type JSX } from "react";
import type {
  DaemonConnectionBridge,
  DaemonConnectionRequest,
  DaemonTargetSnapshot,
} from "../../../src/daemon-connection.js";
import { useTransientLayer } from "../layers-context.js";
import { Button, ConfigField, Text, textClass } from "../ui/index.js";
import { ConnectionProfiles } from "./profiles.js";
import { ConnectedServer } from "./server-update.js";

export function ConnectionDialog({
  bridge,
  target,
  close,
}: {
  bridge: DaemonConnectionBridge;
  target: DaemonTargetSnapshot;
  close(this: void): void;
}): JSX.Element {
  // A profile's URL is its tunnel's local end: never something to edit or save by hand.
  const [url, setUrl] = useState(
    (target.source === "saved" || target.source === "env") && !target.profile ? target.url : "",
  );
  const [error, setError] = useState<string>();
  /** Where the last failure belongs: under the URL field, or under the profiles. */
  const [errorAt, setErrorAt] = useState<"url" | "profile">("url");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const dismiss = () => {
    bridge.cancel();
    close();
  };
  useTransientLayer(true, { name: "daemon-connection", close: dismiss });
  useEffect(() => {
    live.current = true;
    const previous = document.activeElement;
    input.current?.focus();
    return () => {
      live.current = false;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const connect = async (value: DaemonConnectionRequest) => {
    setBusy(true);
    setError(undefined);
    setErrorAt(value !== null && typeof value === "object" ? "profile" : "url");
    const result = await bridge.connect(value);
    if (!live.current) return;
    setBusy(false);
    if (result.ok) close();
    else setError(result.message);
  };
  const reason = target.environmentOverride
    ? "ORCA_DAEMON_URL controls this launch. Unset it and restart to change the daemon."
    : undefined;
  return (
    <div className="orca-dialog-layer">
      <form
        className="orca-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="daemon-connection-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !reason) void connect(url);
        }}
      >
        <h2 id="daemon-connection-title" className={`orca-dialog__title ${textClass("title")}`}>
          Connect to a daemon
        </h2>
        <Text style="caption" as="p">
          Current source: {target.source}
          {target.profile ? ` (SSH profile ${target.profile.name})` : ""}. {reason}
        </Text>
        {bridge.profiles && !reason && (
          <ConnectionProfiles
            profiles={bridge.profiles}
            current={target.profile?.id}
            busy={busy}
            connect={(id) => void connect({ profile: id })}
          />
        )}
        {target.profile && window.orca?.serverUpdate && <ConnectedServer bridge={window.orca.serverUpdate} />}
        {error && errorAt === "profile" && (
          <Text style="caption" as="p" role="alert">
            {error}
          </Text>
        )}
        <Text style="body" as="p">
          Or enter a daemon URL, for example the local end of an SSH tunnel you run yourself (http://127.0.0.1:6722).
          URL connections take their credential from ORCA_DAEMON_TOKEN_FILE; never paste a token here.
        </Text>
        <ConfigField
          label="Daemon URL"
          path="daemonUrl"
          {...(error && errorAt === "url" ? { error } : {})}
          help="The current connection stays open until the new daemon has authenticated successfully."
        >
          {(control) => (
            <input
              {...control}
              ref={input}
              className={`orca-input ${textClass("mono-id")}`}
              value={url}
              disabled={busy || Boolean(reason)}
              onChange={(event) => setUrl(event.target.value)}
            />
          )}
        </ConfigField>
        <div className="orca-dialog__actions">
          <Button onClick={dismiss}>Cancel</Button>
          <Button
            disabled={busy || Boolean(reason)}
            disabledReason={reason ?? "Checking the daemon"}
            onClick={() => void connect(null)}
          >
            Use the bundled daemon
          </Button>
          <Button
            type="submit"
            tone="primary"
            disabled={busy || Boolean(reason)}
            disabledReason={reason ?? "Checking the daemon"}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
    </div>
  );
}
