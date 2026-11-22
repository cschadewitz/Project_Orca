/**
 * The connected server, in the connection dialog (#879): its version, protocol and ring,
 * whether it is behind this app, and, for a server the managed updater installed, "Update
 * now".
 *
 * The daemon only says where its updater is. The person approves that updater for the SSH
 * profile first, seeing its paths and the exact command; after that the panel offers the
 * update while the daemon still reports the same updater, and asks again when it does not.
 * Each request names the connection the person is looking at (profile, connection, host key,
 * workspace, version), and main refuses it if that is no longer the connection. The panel
 * shows the updater's lines as they arrive and then how it ended, in the server's own words.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { ConnectionSnapshot } from "../../../src/bridge.js";
import {
  samePaths,
  serverBehind,
  serverUpdateCommand,
  SERVER_UPDATE_VERSION,
  type ServerUpdateBridge,
  type ServerUpdateOutcome,
  type ServerUpdateProgress,
  type ServerUpdaterState,
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
  const [state, setState] = useState<ServerUpdaterState>();
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<ServerUpdateProgress[]>([]);
  const [outcome, setOutcome] = useState<ServerUpdateOutcome>();
  const [refusal, setRefusal] = useState<string>();
  const live = useRef(true);
  const refresh = useCallback(async () => {
    const next = await bridge.read();
    if (live.current) setState(next);
  }, [bridge]);
  useEffect(() => {
    live.current = true;
    const off = bridge.onProgress((progress) => setLines((shown) => [...shown, progress].slice(-SHOWN_LINES)));
    return () => {
      live.current = false;
      off();
    };
  }, [bridge]);
  // What main knows changes with the connection: a new hello, a reconnect, another profile.
  useEffect(() => {
    void refresh();
  }, [refresh, connection]);
  const version = connection.orcaVersion;
  if (version === undefined) return null;
  const managed = connection.managedServer;
  const behind = serverBehind(version, appVersion);
  const target =
    state?.hostKey !== undefined && state.workspaceId !== undefined
      ? { profile: state.profile, epoch: state.epoch, hostKey: state.hostKey, workspaceId: state.workspaceId }
      : undefined;
  const declared = state?.declared;
  const approved = state?.approved;
  const trusted = samePaths(declared, approved);
  const approve = async () => {
    if (!target || !declared) return;
    setRefusal(undefined);
    const result = await bridge.approve({ ...target, ...declared });
    if (!live.current) return;
    if (!result.ok) setRefusal(result.message);
    await refresh();
  };
  const update = async () => {
    if (!target) return;
    setRunning(true);
    setLines([]);
    setOutcome(undefined);
    const ended = await bridge.update({ ...target, version: appVersion });
    if (!live.current) return;
    setRunning(false);
    setOutcome(ended);
    await refresh();
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
          ...(state?.hostKey ? { "host key": state.hostKey } : {}),
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
      {managed && declared && target && !trusted && (
        <>
          <Text style="body" as="p" role={approved ? "alert" : undefined}>
            {approved
              ? "The server now reports its updater somewhere other than you approved for this profile. Nothing runs until you approve the new location."
              : "Approve this server's updater before the app runs it. The app runs only an updater you approved for this SSH profile, over this profile's own connection:"}
          </Text>
          <Well label="Command the app will run on the server">
            {(SERVER_UPDATE_VERSION.test(appVersion)
              ? serverUpdateCommand(declared, appVersion)
              : ["python3", declared.adapter, "--deployment", declared.manifest, "update", "--bundle", "…"]
            ).join(" ")}
          </Well>
          <Button onClick={() => void approve()}>
            {approved ? "Approve the new location" : "Approve this updater"}
          </Button>
        </>
      )}
      {managed && trusted && target && behind && (
        <Button disabled={running} disabledReason="The server is updating" onClick={() => void update()}>
          {running ? "Updating…" : `Update now to ${appVersion}`}
        </Button>
      )}
      {refusal && (
        <Text style="caption" as="p" role="alert">
          {refusal}
        </Text>
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
      return `The server now runs ${outcome.version}; it said so itself after restarting.`;
    case "unknown": {
      const said = outcome.serverVersion ? ` The server last said it runs ${outcome.serverVersion}.` : "";
      return outcome.reason === "connection-lost"
        ? `The SSH connection was lost while the updater ran, so whether the server updated is not known.${said} Check the server before trying again.`
        : `The updater reported success, but the server has not confirmed the new version.${said} Check the server.`;
    }
    case "work-running":
      return `The server is running work, so it kept its current release; nothing was cancelled. Try again when it is idle. The server said: ${outcome.detail}`;
    case "another-update":
      return `Another update is running on the server (its scheduled updater, or another operator), so this one did not start. The server said: ${outcome.detail}`;
    case "failed":
      return outcome.restored
        ? `The update failed and the server is back on its previous release. The server said: ${outcome.detail}`
        : `The update failed. The server said: ${outcome.detail}`;
    case "unreachable":
      return `SSH refused before the updater could start, so nothing ran on the server. ${outcome.message}`;
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
