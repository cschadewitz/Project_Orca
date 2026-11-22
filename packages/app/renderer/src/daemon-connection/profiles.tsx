/**
 * Saved SSH connection profiles in the connection dialog (#874). The app opens the tunnel,
 * pins the server's host key and keeps the profile's credential in the OS keychain; this
 * list only names profiles and asks main to act on them. Nothing secret crosses the bridge:
 * a credential is imported by a file picker that main owns.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { RemoteProfileInput, RemoteProfilesBridge, RemoteProfileView } from "../../../src/daemon-connection.js";
import { useTransientLayer } from "../layers-context.js";
import { Button, Chip, ConfigField, Text, textClass } from "../ui/index.js";

interface Draft {
  id?: string;
  name: string;
  destination: string;
  sshPort: string;
  identityFile: string;
  jumpDestination: string;
  jumpPort: string;
  remotePort: string;
}
const EMPTY: Draft = {
  name: "",
  destination: "",
  sshPort: "",
  identityFile: "",
  jumpDestination: "",
  jumpPort: "",
  remotePort: "",
};

function toInput(draft: Draft): RemoteProfileInput | string {
  const port = (value: string, label: string): number | undefined | string => {
    if (!value.trim()) return undefined;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : `${label} must be a port number from 1 to 65535.`;
  };
  const sshPort = port(draft.sshPort, "SSH port");
  if (typeof sshPort === "string") return sshPort;
  const remotePort = port(draft.remotePort, "Daemon port");
  if (typeof remotePort === "string") return remotePort;
  const jumpPort = port(draft.jumpPort, "Jump host port");
  if (typeof jumpPort === "string") return jumpPort;
  const identityFile = draft.identityFile.trim();
  const jump = draft.jumpDestination.trim();
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    destination: draft.destination.trim(),
    ...(sshPort ? { sshPort } : {}),
    ...(identityFile ? { identityFile } : {}),
    // The jump host uses the same key file as the server; its own pin is kept beside the server's.
    ...(jump
      ? {
          jump: {
            destination: jump,
            ...(jumpPort ? { sshPort: jumpPort } : {}),
            ...(identityFile ? { identityFile } : {}),
          },
        }
      : {}),
    ...(remotePort ? { remotePort } : {}),
  };
}

export function ConnectionProfiles({
  profiles,
  current,
  busy,
  connect,
}: {
  profiles: RemoteProfilesBridge;
  /** The profile the app is connected through now, if any. */
  current: string | undefined;
  busy: boolean;
  connect(this: void, id: string): void;
}): JSX.Element {
  const [list, setList] = useState<RemoteProfileView[]>([]);
  const [editing, setEditing] = useState<Draft>();
  const [armed, setArmed] = useState<string>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const live = useRef(true);
  /** The armed removal row: Keep takes focus when it appears (RULES.md 17). */
  const armedRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    live.current = true;
    void profiles.list().then((views) => live.current && setList(views));
    return () => {
      live.current = false;
    };
  }, [profiles]);
  // Esc disarms the row first, through the layer stack, before it would close the dialog.
  useTransientLayer(armed !== undefined, { name: "daemon-profile-remove", close: () => setArmed(undefined) });
  useEffect(() => {
    if (armed) armedRow.current?.querySelector("button")?.focus();
  }, [armed]);

  const run = async <T,>(
    action: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>,
    done?: (value: T) => void,
  ) => {
    setWorking(true);
    setError(undefined);
    const result = await action();
    if (!live.current) return;
    setWorking(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    done?.(result.value);
    setList(await profiles.list());
  };
  const disabled = busy || working;

  return (
    <section className="orca-field" aria-labelledby="daemon-profiles-title">
      <h3 id="daemon-profiles-title" className={textClass("label-strong")}>
        SSH profiles
      </h3>
      <Text style="caption" as="p">
        ORCA opens its own SSH tunnel with your keys or agent, pins the server&apos;s host key on the first connect, and
        keeps the profile&apos;s daemon credential in the system keychain. Your ssh config is not used: enter the user,
        port and key here. The daemon stays on the server&apos;s loopback.
      </Text>
      {list.length === 0 && !editing && (
        <Text style="caption" as="p">
          No profiles yet.
        </Text>
      )}
      {list.map((profile) => (
        <div key={profile.id} className="orca-field">
          <Text style="body" as="p">
            {profile.name} <span className={textClass("mono-id")}>{profile.destination}</span>
            {current === profile.id ? " · connected" : ""}
          </Text>
          <div className="orca-chips">
            <Chip>{profile.hasCredential ? "Credential stored" : "No credential"}</Chip>
            <Chip>{profile.hostKeyPinned ? "Host key pinned" : "Host key not pinned yet"}</Chip>
          </div>
          {armed === profile.id ? (
            <div ref={armedRow} className="orca-dialog__actions">
              <Text style="caption" as="p">
                Removes the profile, its pinned host key and its stored credential.
              </Text>
              <Button size="sm" onClick={() => setArmed(undefined)}>
                Keep
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={disabled}
                onClick={() =>
                  void run(
                    () => profiles.remove(profile.id),
                    () => setArmed(undefined),
                  )
                }
              >
                ✕ Remove profile
              </Button>
            </div>
          ) : (
            <div className="orca-dialog__actions">
              <Button
                size="sm"
                tone="primary"
                disabled={disabled || !profile.hasCredential}
                disabledReason={profile.hasCredential ? "Checking the daemon" : "Import a credential first"}
                onClick={() => connect(profile.id)}
              >
                Connect
              </Button>
              <Button
                size="sm"
                disabled={disabled}
                onClick={() => void run(() => profiles.importCredential(profile.id))}
              >
                Import credential…
              </Button>
              <Button
                size="sm"
                disabled={disabled || current === profile.id}
                disabledReason="Connect to another daemon first"
                onClick={() =>
                  setEditing({
                    id: profile.id,
                    name: profile.name,
                    destination: profile.destination,
                    sshPort: profile.sshPort ? String(profile.sshPort) : "",
                    identityFile: profile.identityFile ?? "",
                    jumpDestination: profile.jump?.destination ?? "",
                    jumpPort: profile.jump?.sshPort ? String(profile.jump.sshPort) : "",
                    remotePort: String(profile.remotePort),
                  })
                }
              >
                Edit
              </Button>
              {profile.hostKeyPinned && (
                <Button
                  size="sm"
                  disabled={disabled || current === profile.id}
                  disabledReason="Connect to another daemon first"
                  onClick={() => void run(() => profiles.forgetHostKey(profile.id))}
                >
                  Forget host key
                </Button>
              )}
              <Button
                size="sm"
                disabled={disabled || current === profile.id}
                disabledReason="Connect to another daemon first"
                onClick={() => setArmed(profile.id)}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      ))}
      {editing ? (
        <ProfileEditor
          draft={editing}
          disabled={disabled}
          cancel={() => setEditing(undefined)}
          save={(draft) => {
            const input = toInput(draft);
            if (typeof input === "string") {
              setError(input);
              return;
            }
            void run(
              () => profiles.save(input),
              () => setEditing(undefined),
            );
          }}
        />
      ) : (
        <div className="orca-dialog__actions">
          <Button size="sm" disabled={disabled} onClick={() => setEditing(EMPTY)}>
            Add profile…
          </Button>
        </div>
      )}
      {error && (
        <Text style="caption" as="p" role="alert">
          {error}
        </Text>
      )}
    </section>
  );
}

function ProfileEditor({
  draft: initial,
  disabled,
  save,
  cancel,
}: {
  draft: Draft;
  disabled: boolean;
  save(this: void, draft: Draft): void;
  cancel(this: void): void;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  const field = (key: keyof Omit<Draft, "id">, label: string, help: string, mono = true) => (
    <ConfigField label={label} path={`profiles.${key}`} help={help}>
      {(control) => (
        <input
          {...control}
          className={`orca-input ${textClass(mono ? "mono-id" : "body")}`}
          value={draft[key]}
          disabled={disabled}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      )}
    </ConfigField>
  );
  return (
    <div className="orca-field" role="group" aria-label={initial.id ? "Edit profile" : "New profile"}>
      {field("name", "Name", "How this daemon is named in the app.", false)}
      {field("destination", "Server", "user@host, as you would pass it to ssh.")}
      {field("sshPort", "SSH port", "Leave empty for 22.")}
      {field("identityFile", "Key file", "Optional full path to a private key. Empty: the keys your SSH agent offers.")}
      {field("jumpDestination", "Jump host", "Optional user@host to reach the server through.")}
      {field("jumpPort", "Jump host SSH port", "Leave empty for 22.")}
      {field("remotePort", "Daemon port", "The daemon's port on the server's loopback. Default 6722.")}
      <div className="orca-dialog__actions">
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" tone="primary" disabled={disabled} onClick={() => save(draft)}>
          Save profile
        </Button>
      </div>
    </div>
  );
}
