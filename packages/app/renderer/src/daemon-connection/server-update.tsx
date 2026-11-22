/**
 * The connected server, in the connection dialog (#879): its version, protocol, ring, host
 * key and workspace, whether it is behind this app, and, for a server the managed updater
 * installed, "Update now".
 *
 * Everything the person confirms comes from one preview main made (`bridge.read`): the server
 * version, the target version, the host key, the workspace, the daemon's hint and the
 * approval. Approving and updating name that preview, and main refuses if the connection no
 * longer matches it. The updater's paths are typed by the person, with the daemon's report
 * shown beside them as a hint; main checks the two agree. The panel shows the updater's lines
 * as they arrive and then how it ended, in the server's own words.
 */
import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import type { ConnectionSnapshot } from "../../../src/bridge.js";
import {
  serverBehind,
  serverUpdateCommand,
  SERVER_RUNNING_VERSION,
  SERVER_UPDATE_VERSION,
  type ServerUpdateBridge,
  type ServerUpdateOutcome,
  type ServerUpdatePreview,
  type ServerUpdateProgress,
} from "../../../src/server-update.js";
import { Button, KeyValueList, Text, textClass, Well } from "../ui/index.js";

/** Lines kept on screen: the server's updater says little, but a flood stays bounded. */
const SHOWN_LINES = 40;

export function ServerUpdatePanel({
  bridge,
  connection,
}: {
  bridge: ServerUpdateBridge;
  connection: ConnectionSnapshot;
}): JSX.Element | null {
  const [preview, setPreview] = useState<ServerUpdatePreview>();
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<ServerUpdateProgress[]>([]);
  const [outcome, setOutcome] = useState<ServerUpdateOutcome>();
  const [refusal, setRefusal] = useState<string>();
  const [adapter, setAdapter] = useState("");
  const [manifest, setManifest] = useState("");
  const live = useRef(true);
  const refresh = useCallback(async () => {
    const next = await bridge.read();
    if (live.current) setPreview(next);
  }, [bridge]);
  useEffect(() => {
    live.current = true;
    const off = bridge.onProgress((progress) => setLines((shown) => [...shown, progress].slice(-SHOWN_LINES)));
    return () => {
      live.current = false;
      off();
    };
  }, [bridge]);
  // What main sees changes with the connection: a new hello, a reconnect, another profile.
  useEffect(() => {
    void refresh();
  }, [refresh, connection]);
  if (connection.orcaVersion === undefined || !preview) return null;
  const managed = connection.managedServer;
  const { serverVersion, targetVersion, declared, approved } = preview;
  const approve = async () => {
    setRefusal(undefined);
    const result = await bridge.approve({ preview: preview.id, adapter: adapter.trim(), manifest: manifest.trim() });
    if (!live.current) return;
    if (!result.ok) setRefusal(result.message);
    await refresh();
  };
  const update = async () => {
    setRunning(true);
    setLines([]);
    setOutcome(undefined);
    const ended = await bridge.update({ preview: preview.id });
    if (!live.current) return;
    setRunning(false);
    setOutcome(ended);
    await refresh();
  };
  const needsApproval = Boolean(
    managed &&
    declared &&
    preview.hostKey &&
    preview.workspaceId &&
    serverVersion !== undefined &&
    serverBehind(serverVersion, targetVersion) &&
    SERVER_UPDATE_VERSION.test(targetVersion) &&
    SERVER_RUNNING_VERSION.test(serverVersion) &&
    (!approved || approved.adapter !== declared.adapter || approved.manifest !== declared.manifest),
  );
  return (
    <section className="orca-field" aria-labelledby="connected-server-title">
      <h3 id="connected-server-title" className={textClass("label-strong")}>
        Connected server
      </h3>
      <KeyValueList
        values={{
          ...(serverVersion !== undefined ? { version: serverVersion } : {}),
          ...(connection.versions ? { protocol: connection.versions.daemon } : {}),
          ...(managed?.ring ? { ring: managed.ring } : {}),
          ...(preview.hostKey ? { "host key": preview.hostKey } : {}),
          ...(preview.workspaceId ? { workspace: preview.workspaceId } : {}),
        }}
      />
      {serverVersion !== undefined && (
        <Text style="caption" as="p">
          {serverBehind(serverVersion, targetVersion)
            ? `Older than this app (${targetVersion}).`
            : serverBehind(targetVersion, serverVersion)
              ? `Newer than this app (${targetVersion}).`
              : "The same release as this app."}
          {managed ? "" : " Installed outside the managed server updater, so the app does not update it."}
        </Text>
      )}
      {needsApproval && declared && (
        <>
          <Text style="body" as="p" role={approved ? "alert" : undefined}>
            {approved
              ? "The server now reports its updater somewhere other than you approved for it. Nothing runs until you enter and approve the new location."
              : "Enter where this server's updater is to approve it. The app runs only an updater you approved for this server (this host key and workspace), over this profile's own connection."}
          </Text>
          <Text style="caption" as="p">
            The server reports: {declared.adapter} with {declared.manifest}
          </Text>
          <PathInput label="Updater (orca-release.py)" value={adapter} onChange={setAdapter} />
          <PathInput label="Deployment manifest" value={manifest} onChange={setManifest} />
          {adapter.trim() && manifest.trim() && (
            <Well label="Command the app will run on the server">
              {serverUpdateCommand(
                { adapter: adapter.trim(), manifest: manifest.trim() },
                targetVersion,
                serverVersion!,
              ).join(" ")}
            </Well>
          )}
          <Button
            disabled={!adapter.trim() || !manifest.trim()}
            disabledReason="Enter both paths"
            onClick={() => void approve()}
          >
            Approve this updater
          </Button>
        </>
      )}
      {!preview.blocked && (
        <Button disabled={running} disabledReason="The server is updating" onClick={() => void update()}>
          {running ? "Updating…" : `Update now to ${targetVersion}`}
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

/** One path on the server, typed by the person. */
function PathInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="orca-field">
      <label className={`orca-field__label ${textClass("label-strong")}`} htmlFor={id}>
        {label}
      </label>
      <div className="orca-field__control">
        <input
          id={id}
          className={`orca-input ${textClass("mono-id")}`}
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
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
    case "moved":
      return `The server's release changed since you checked, so this update did not run. Check the server again. The server said: ${outcome.detail}`;
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

/** The panel, fed from the bridge's live connection snapshot. */
export function ConnectedServer({ bridge }: { bridge: ServerUpdateBridge }): JSX.Element | null {
  const [connection, setConnection] = useState<ConnectionSnapshot>(() => window.orca.connection.read());
  useEffect(() => {
    const off = window.orca.connection.subscribe(setConnection);
    setConnection(window.orca.connection.read());
    return off;
  }, []);
  return <ServerUpdatePanel bridge={bridge} connection={connection} />;
}
