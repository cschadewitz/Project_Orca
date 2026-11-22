/**
 * The connected server, in the connection dialog (#879): its version, protocol and ring,
 * whether it is behind this app, and, for a server the managed updater installed, "Update
 * now". The update is the server's own updater run over the profile's SSH connection; this
 * panel shows its lines as they arrive and then how it ended, in the server's own words.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { ConnectionSnapshot } from "../../../src/bridge.js";
import {
  serverBehind,
  type ServerUpdateBridge,
  type ServerUpdateOutcome,
  type ServerUpdateProgress,
} from "../../../src/server-update.js";
import { Button, KeyValueList, Text, textClass, Well } from "../ui/index.js";

/** Lines kept on screen: the server's updater says little, but a flood stays bounded. */
const SHOWN_LINES = 40;

export function ServerUpdatePanel({
  bridge,
  connection,
  appVersion,
}: {
  bridge: ServerUpdateBridge;
  connection: ConnectionSnapshot;
  appVersion: string;
}): JSX.Element | null {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<ServerUpdateProgress[]>([]);
  const [outcome, setOutcome] = useState<ServerUpdateOutcome>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const off = bridge.onProgress((progress) => setLines((shown) => [...shown, progress].slice(-SHOWN_LINES)));
    return () => {
      live.current = false;
      off();
    };
  }, [bridge]);
  const version = connection.orcaVersion;
  if (version === undefined) return null;
  const managed = connection.managedServer;
  const behind = serverBehind(version, appVersion);
  const update = async () => {
    setRunning(true);
    setLines([]);
    setOutcome(undefined);
    const ended = await bridge.update();
    if (!live.current) return;
    setRunning(false);
    setOutcome(ended);
  };
  return (
    <section className="orca-field" aria-labelledby="connected-server-title">
      <h3 id="connected-server-title" className={textClass("label-strong")}>
        Connected server
      </h3>
      <KeyValueList
        values={{
          version,
          ...(connection.versions ? { protocol: connection.versions.daemon } : {}),
          ...(managed?.ring ? { ring: managed.ring } : {}),
        }}
      />
      <Text style="caption" as="p">
        {behind
          ? `Older than this app (${appVersion}).`
          : serverBehind(appVersion, version)
            ? `Newer than this app (${appVersion}).`
            : "The same release as this app."}
        {managed ? "" : " Installed outside the managed server updater, so the app does not update it."}
      </Text>
      {managed && behind && (
        <Button disabled={running} disabledReason="The server is updating" onClick={() => void update()}>
          {running ? "Updating…" : `Update now to ${appVersion}`}
        </Button>
      )}
      {lines.length > 0 && <Well label="Server updater output">{lines.map((entry) => entry.line).join("\n")}</Well>}
      {outcome && (
        <Text style="body" as="p" role={outcome.status === "updated" ? "status" : "alert"}>
          {describe(outcome)}
        </Text>
      )}
    </section>
  );
}

/** How an update ended, as a sentence; the server's own message is quoted, never reworded. */
export function describe(outcome: ServerUpdateOutcome): string {
  switch (outcome.status) {
    case "updated":
      return `The server now runs ${outcome.version}. The app reconnects to it on its own.`;
    case "work-running":
      return `The server is running work, so it kept its current release; nothing was cancelled. Try again when it is idle. The server said: ${outcome.detail}`;
    case "another-update":
      return `Another update is running on the server (its scheduled updater, or another operator), so this one did not start. The server said: ${outcome.detail}`;
    case "failed":
      return outcome.restored
        ? `The update failed and the server is back on its previous release. The server said: ${outcome.detail}`
        : `The update failed. The server said: ${outcome.detail}`;
    case "unreachable":
      return `The update could not reach the server, so nothing changed there. ${outcome.message}`;
    case "unavailable":
      return outcome.reason;
  }
}

/** The panel, fed from the bridge: the live connection snapshot and this app's version. */
export function ConnectedServer({ bridge }: { bridge: ServerUpdateBridge }): JSX.Element | null {
  const [connection, setConnection] = useState<ConnectionSnapshot>(() => window.orca.connection.read());
  useEffect(() => {
    const off = window.orca.connection.subscribe(setConnection);
    setConnection(window.orca.connection.read());
    return off;
  }, []);
  return <ServerUpdatePanel bridge={bridge} connection={connection} appVersion={window.orca.updates.read().current} />;
}
