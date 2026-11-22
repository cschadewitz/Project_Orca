/**
 * Saved SSH connection profiles in the connection dialog (#874). The app opens the tunnel,
 * pins the server's host key and keeps the profile's credential in the OS keychain; this
 * list only names profiles and asks main to act on them. Nothing secret crosses the bridge:
 * main signs in on the first connect by having ORCA on the server issue a credential (#875),
 * and a credential imported by hand comes through a file picker that main owns.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type {
  RemoteProfileInput,
  RemoteProfilesBridge,
  RemoteProfileView,
  ServerInspectionView,
  ServerSetupStepView,
  ServerSetupView,
} from "../../../src/daemon-connection.js";
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
  serverCommand: string;
  serverConfig: string;
  readOnly: boolean;
}
const EMPTY: Draft = {
  name: "",
  destination: "",
  sshPort: "",
  identityFile: "",
  jumpDestination: "",
  jumpPort: "",
  remotePort: "",
  serverCommand: "",
  serverConfig: "",
  readOnly: false,
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
  const serverCommand = draft.serverCommand.trim();
  const serverConfig = draft.serverConfig.trim();
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
    ...(serverCommand ? { serverCommand } : {}),
    ...(serverConfig ? { serverConfig } : {}),
    ...(draft.readOnly ? { readOnly: true } : {}),
  };
}

/** What a setup run came to, in a sentence; `alert` when the person has something to fix. */
export function setupSummary(
  profile: Pick<RemoteProfileView, "name" | "destination">,
  view: ServerSetupView,
): { text: string; alert: boolean } {
  const { setup, signIn } = view;
  switch (setup.kind) {
    case "ready":
      return signIn && !signIn.ok
        ? {
            text: `${profile.name} is set up as an ORCA server (v${setup.version ?? "?"}), but signing in failed: ${signIn.message}`,
            alert: true,
          }
        : {
            text: `${profile.name} is an ORCA server (v${setup.version ?? "?"}), and this computer is signed in.`,
            alert: false,
          };
    case "refused":
      return { text: `ORCA was not set up on ${profile.name}: ${setup.detail ?? ""}`, alert: true };
    case "failed":
      return {
        text: `Setting up ${profile.name} failed at "${setup.step ?? "?"}": ${setup.detail ?? ""} Everything it changed is back as it was; set it up again once this is fixed.`,
        alert: true,
      };
    case "mismatch":
      return {
        text: `${setup.detail ?? "The server reported a setup other than the one confirmed."} ${profile.name} was not changed and nothing signed in.`,
        alert: true,
      };
    case "no-python":
      return {
        text: `${profile.destination} has no python3. Install Python 3.8 or newer there, then set it up again.`,
        alert: true,
      };
    default:
      return {
        text: setup.detail
          ? `Setting up ${profile.name} could not confirm that everything is back as it was: ${setup.detail}`
          : `Setting up ${profile.name} did not report how it ended (the connection may have dropped). Set it up again: it first puts back anything an unfinished run changed.`,
        alert: true,
      };
  }
}

const STEP_RESULT: Record<ServerSetupStepView["result"], string> = {
  ok: "already done",
  changed: "done",
  repaired: "repaired",
  warning: "warning",
  refused: "refused",
  failed: "failed",
};

function credentialChip(profile: RemoteProfileView): string {
  if (!profile.hasCredential) return "Signs in on first connect";
  if (profile.credentialImported) return "Imported credential";
  return profile.readOnly ? "Signed in, read only" : "Signed in";
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
  const [notice, setNotice] = useState<string>();
  const [working, setWorking] = useState(false);
  /** A profile whose server is being set up, and what the last setup reported. */
  const [settingUp, setSettingUp] = useState<string>();
  const [steps, setSteps] = useState<ServerSetupStepView[]>([]);
  /** What the server was found to be, waiting for the person to confirm the setup. */
  const [confirming, setConfirming] = useState<{
    profile: Pick<RemoteProfileView, "id" | "name" | "destination">;
    inspection: ServerInspectionView;
  }>();
  /** The editor was opened by "Add a machine": saving it also sets the server up. */
  const [addingMachine, setAddingMachine] = useState(false);
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
    setNotice(undefined);
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
  const setUpServer = profiles.setUpServer;
  const inspectServer = profiles.inspectServer;
  const report = (profile: Pick<RemoteProfileView, "name" | "destination">, view: ServerSetupView) => {
    setSteps(view.setup.steps);
    const summary = setupSummary(profile, view);
    if (summary.alert) setError(summary.text);
    else setNotice(summary.text);
  };
  /** First, read only: what the person confirms. Nothing is enrolled or installed yet. */
  const setUp = (profile: Pick<RemoteProfileView, "id" | "name" | "destination">) => {
    if (!inspectServer || !setUpServer) return;
    setConfirming(undefined);
    setSteps([]);
    void run(
      () => inspectServer(profile.id),
      (found) => {
        if (found.inspection) setConfirming({ profile, inspection: found.inspection });
        else if (found.setup) report(profile, { setup: found.setup });
      },
    );
  };
  const confirmSetUp = () => {
    if (!setUpServer || !confirming) return;
    const { profile, inspection } = confirming;
    setConfirming(undefined);
    setSettingUp(profile.id);
    setSteps([]);
    void run(
      () => setUpServer(profile.id, inspection.confirmation),
      (view) => report(profile, view),
    ).finally(() => live.current && setSettingUp(undefined));
  };

  return (
    <section className="orca-field" aria-labelledby="daemon-profiles-title">
      <h3 id="daemon-profiles-title" className={textClass("label-strong")}>
        SSH profiles
      </h3>
      <Text style="caption" as="p">
        ORCA opens its own SSH tunnel with your keys or agent, pins the server&apos;s host key on the first connect, and
        signs in by having ORCA on the server issue this computer a credential, kept in the system keychain and renewed
        before it expires. Your ssh config is not used: enter the user, port and key here. The daemon stays on the
        server&apos;s loopback.
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
            <Chip>{credentialChip(profile)}</Chip>
            {profile.pendingRevocations ? (
              <Chip>
                {profile.pendingRevocations === 1
                  ? "1 old credential not revoked yet"
                  : `${profile.pendingRevocations} old credentials not revoked yet`}
              </Chip>
            ) : null}
            <Chip>
              {profile.hostKeyMissing
                ? "Pinned host key missing"
                : profile.hostKeyPinned
                  ? "Host key pinned"
                  : "Host key not pinned yet"}
            </Chip>
          </div>
          {armed === profile.id ? (
            <div ref={armedRow} className="orca-dialog__actions">
              <Text style="caption" as="p">
                Removes the profile, its pinned host key and its stored credential, and revokes the credential on the
                server when it can be reached.
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
                    ({ revoke }) => {
                      setArmed(undefined);
                      if (revoke === "not-reached")
                        setNotice(
                          `Removed ${profile.name}. ${profile.destination} could not be reached, so its credential stays valid there until it expires. Revoke it there with "orca auth revoke".`,
                        );
                    },
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
                disabled={disabled}
                disabledReason="Checking the daemon"
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
              {setUpServer && inspectServer && (
                <Button
                  size="sm"
                  disabled={disabled || current === profile.id}
                  disabledReason="Connect to another daemon first"
                  onClick={() => setUp(profile)}
                >
                  Set up ORCA server
                </Button>
              )}
              {profile.credentialImported && (
                <Button
                  size="sm"
                  disabled={disabled || current === profile.id}
                  disabledReason="Connect to another daemon first"
                  onClick={() => void run(() => profiles.useAutomaticSignIn(profile.id))}
                >
                  Use automatic sign-in
                </Button>
              )}
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
                    serverCommand: profile.serverCommand ?? "",
                    serverConfig: profile.serverConfig ?? "",
                    readOnly: profile.readOnly ?? false,
                  })
                }
              >
                Edit
              </Button>
              {(profile.hostKeyPinned || profile.hostKeyMissing) && (
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
          cancel={() => {
            setEditing(undefined);
            setAddingMachine(false);
          }}
          save={(draft) => {
            const input = toInput(draft);
            if (typeof input === "string") {
              setError(input);
              return;
            }
            void run(
              () => profiles.save(input),
              (view) => {
                setEditing(undefined);
                if (addingMachine) setUp(view);
                setAddingMachine(false);
              },
            );
          }}
        />
      ) : (
        <div className="orca-dialog__actions">
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              setAddingMachine(false);
              setEditing(EMPTY);
            }}
          >
            Add profile…
          </Button>
          {setUpServer && inspectServer && (
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                setAddingMachine(true);
                setEditing(EMPTY);
              }}
            >
              Add a machine…
            </Button>
          )}
        </div>
      )}
      {addingMachine && editing && (
        <Text style="caption" as="p">
          Saving checks the machine over SSH and shows you its host keys, the account and what will be installed. Once
          you confirm, it sets the machine up as a managed ORCA server: this version&apos;s signed server bundle and a
          systemd user service, then signs this computer in. It refuses a machine that already has an ORCA it did not
          install. Linux x64 with Python 3.8 or newer.
        </Text>
      )}
      {confirming && (
        <ServerConfirmation
          inspection={confirming.inspection}
          name={confirming.profile.name}
          disabled={disabled}
          confirm={confirmSetUp}
          cancel={() => setConfirming(undefined)}
        />
      )}
      {settingUp && (
        <Text style="caption" as="p" role="status">
          Setting up the ORCA server on {list.find((p) => p.id === settingUp)?.destination ?? "the machine"}. This takes
          a few minutes.
        </Text>
      )}
      {steps.length > 0 && (
        <ul aria-label="Server setup steps">
          {steps.map((step) => (
            <li key={step.step}>
              <Text style="caption" as="span">
                {step.step}: {STEP_RESULT[step.result]}
                {step.detail ? ` (${step.detail})` : ""}
              </Text>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Text style="caption" as="p" role="alert">
          {error}
        </Text>
      )}
      {notice && (
        <Text style="caption" as="p" role="status">
          {notice}
        </Text>
      )}
    </section>
  );
}

/**
 * Everything a setup is confirmed for (#881 review), as the read-only inspection found it: the
 * host keys (not trusted for the profile until this is confirmed), the account it runs as,
 * and what it will install and do.
 */
function ServerConfirmation({
  inspection,
  name,
  disabled,
  confirm,
  cancel,
}: {
  inspection: ServerInspectionView;
  name: string;
  disabled: boolean;
  confirm(this: void): void;
  cancel(this: void): void;
}): JSX.Element {
  const { fingerprints } = inspection;
  return (
    <div className="orca-field" role="group" aria-label="Confirm server setup">
      <Text style="label-strong" as="p">
        Set up {name} as an ORCA server?
      </Text>
      <Text style="caption" as="p">
        {inspection.firstUse
          ? "This server has not been connected to before. Check that these host keys are the server's own (ssh-keygen -lf on the server) before you confirm: confirming pins them."
          : "The server presented the host keys pinned for this profile."}
      </Text>
      <ul aria-label="Host keys">
        {fingerprints.server.map((key) => (
          <li key={`server ${key}`}>
            <Text style="caption" as="span">
              Server <span className={textClass("mono-id")}>{key}</span>
            </Text>
          </li>
        ))}
        {(fingerprints.jump ?? []).map((key) => (
          <li key={`jump ${key}`}>
            <Text style="caption" as="span">
              Jump host <span className={textClass("mono-id")}>{key}</span>
            </Text>
          </li>
        ))}
      </ul>
      <Text style="caption" as="p">
        As <span className={textClass("mono-id")}>{inspection.account}</span> on {inspection.destination}:{" "}
        {inspection.current
          ? `verify and repair ORCA ${inspection.current} in ${inspection.root}`
          : `install ORCA ${inspection.version} from its signed server bundle in ${inspection.root}`}
        , enable and start its systemd user service (with lingering, so it runs without a login), then sign this
        computer in.
      </Text>
      <div className="orca-dialog__actions">
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" tone="primary" disabled={disabled} onClick={confirm}>
          Set up
        </Button>
      </div>
    </div>
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
  const field = (key: keyof Omit<Draft, "id" | "readOnly">, label: string, help: string, mono = true) => (
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
      {field(
        "serverCommand",
        "Server command",
        "ORCA's command line on the server, which issues this profile's credential. Leave empty for orca on its PATH, or enter a full path (with / on Windows too).",
      )}
      {field(
        "serverConfig",
        "Workspace config",
        "Optional full path to the daemon's config file on the server (with / on Windows too), when the daemon does not use the SSH user's default.",
      )}
      <ConfigField
        label="Read only"
        path="profiles.readOnly"
        help="Sign in with the viewer preset: watch runs and plans, change nothing."
      >
        {(control) => (
          <label className={textClass("caption")}>
            <input
              {...control}
              type="checkbox"
              checked={draft.readOnly}
              disabled={disabled}
              onChange={(event) => setDraft({ ...draft, readOnly: event.target.checked })}
            />
            Observe only
          </label>
        )}
      </ConfigField>
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
