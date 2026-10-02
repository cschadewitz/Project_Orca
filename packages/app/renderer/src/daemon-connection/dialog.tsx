/** Authenticated endpoint dialog with inline failures and explicit cancellation. */
import { useEffect, useRef, useState, type JSX } from "react";
import type { DaemonConnectionBridge, DaemonTargetSnapshot } from "../../../src/daemon-connection.js";
import { useTransientLayer } from "../layers-context.js";
import { Button, ConfigField, Text, textClass } from "../ui/index.js";

export function ConnectionDialog({
  bridge,
  target,
  close,
}: {
  bridge: DaemonConnectionBridge;
  target: DaemonTargetSnapshot;
  close(this: void): void;
}): JSX.Element {
  const [url, setUrl] = useState(target.url);
  const [error, setError] = useState<string>();
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
  const connect = async (value: string | null) => {
    setBusy(true);
    setError(undefined);
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
        <Text style="body" as="p">
          Use the local end of your SSH tunnel, for example http://127.0.0.1:6722. Credentials come from the supported
          ORCA_DAEMON_TOKEN_FILE setup; never paste a token here.
        </Text>
        <Text style="caption" as="p">
          Current source: {target.source}. {reason}
        </Text>
        <ConfigField
          label="Daemon URL"
          path="daemonUrl"
          {...(error ? { error } : {})}
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
