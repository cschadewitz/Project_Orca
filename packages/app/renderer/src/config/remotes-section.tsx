/**
 * Remote daemons (#1206) on the Config surface: the delegation remotes the active configuration
 * names (`remotes:` and the `type: orca-daemon` agents that use them), what each enrollment
 * record says, and **Enroll**, which has the daemon that owns this workspace pin the remote's
 * host key and prove, or have the remote issue, the credential.
 *
 * It is the route a workspace the desktop app set up in first-run admits: that workspace's fence
 * refuses `orca remote enroll` from a separate CLI process, and only the daemon the app launched
 * may write there. The renderer never sees a token: it sends the fingerprint the person typed,
 * and a credential only when the person pastes one (where the daemon cannot have the remote
 * issue it, on Windows). Offered only when the daemon lists `remotes.list` and `remotes.enroll`.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import { REMOTES_ENROLL_METHOD, REMOTES_LIST_METHOD, type RemotesListResult, type RemoteView } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { useMethodPresent, useWritability } from "../chrome/use-connection.js";
import { Button, Chip, ConfigField, Text, textClass } from "../ui/index.js";
import { currentEditorTarget, sameEditorTarget } from "./configuration-adapter.js";

const sameTarget = (a: ReturnType<typeof currentEditorTarget>, b: ReturnType<typeof currentEditorTarget>) =>
  (a === undefined && b === undefined) || sameEditorTarget(a, b);

/** The enrollment state as a chip word. */
function stateWord(remote: RemoteView): string {
  switch (remote.enrollment.state) {
    case "none":
      return "not enrolled";
    case "unreadable":
      return "record unreadable";
    case "enrolled":
      return remote.enrollment.routeCurrent ? "enrolled" : "route changed";
  }
}

/** One sentence on where the remote stands, for under its name. */
function stateLine(remote: RemoteView): string {
  const e = remote.enrollment;
  if (e.state === "none")
    return "Not enrolled. Delegation to it is refused until its host key is pinned and its credential is checked.";
  if (e.state === "unreadable") return "Its enrollment record cannot be read. Enroll it again.";
  if (!e.routeCurrent) return "Its address changed since it was enrolled. Enroll it again before delegating to it.";
  return `Enrolled ${e.enrolledAt.slice(0, 10)}, credential ${e.credentialId} ${e.issued ? "issued by the remote" : "saved here"}, answering for ${e.principalId}.`;
}

interface Draft {
  hostKey: string;
  jumpHostKey: string;
  credential: string;
  rotate: boolean;
}
const EMPTY: Draft = { hostKey: "", jumpHostKey: "", credential: "", rotate: false };

function EnrollForm({
  remote,
  canIssue,
  onEnrolled,
  onCancel,
}: {
  remote: RemoteView;
  canIssue: boolean;
  onEnrolled: (remote: RemoteView, warnings: readonly string[]) => void;
  onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const writable = useWritability();
  const announce = useAnnounce();
  const needsKey = remote.pinned.length === 0;
  const needsJumpKey = remote.jump !== undefined && remote.jumpPinned.length === 0;
  const needsCredential = !canIssue && !remote.credentialSaved;
  const missing =
    (needsKey && !draft.hostKey.trim()) ||
    (needsJumpKey && !draft.jumpHostKey.trim()) ||
    (needsCredential && !draft.credential.trim());
  const reason = !writable.can
    ? writable.reason
    : missing
      ? needsCredential && !draft.credential.trim()
        ? "Paste the credential the remote issued first."
        : "Enter the host key fingerprint first."
      : undefined;
  const submit = () => {
    const enroll = window.orca.remotes?.enroll;
    if (!enroll || reason !== undefined) return;
    setBusy(true);
    setError(undefined);
    void enroll({
      id: remote.id,
      hostKeys: draft.hostKey.trim() ? [draft.hostKey.trim()] : [],
      jumpHostKeys: draft.jumpHostKey.trim() ? [draft.jumpHostKey.trim()] : [],
      ...(draft.credential.trim() ? { credential: draft.credential } : {}),
      ...(draft.rotate && !draft.credential.trim() ? { rotate: true } : {}),
    }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error.message);
        announce(`Remote ${remote.id} was not enrolled: ${result.error.message}`);
        return;
      }
      // The credential is not kept in the renderer a moment longer than the request.
      setDraft(EMPTY);
      announce(`Remote ${remote.id} enrolled.`);
      onEnrolled(result.result.remote, result.result.warnings);
    });
  };
  const keyFile = `auth/remotes/${remote.id}.known_hosts`;
  return (
    <form
      className="orca-config__remote-form"
      aria-label={`Enroll remote ${remote.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Text style="caption">
        Get the fingerprint from a source you already trust, such as the remote&apos;s console or its administrator, not
        over the connection you are about to trust. On the remote: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
      </Text>
      <ConfigField
        label="Host key fingerprint"
        path={keyFile}
        help={
          needsKey
            ? "As ssh-keygen -l prints it: SHA256: and 43 characters. Enrollment pins exactly this key."
            : `Already pinned: ${remote.pinned.join(", ")}. Give it again only to check it.`
        }
      >
        {(control) => (
          <input
            {...control}
            className={`orca-input ${textClass("mono-body")}`}
            spellCheck={false}
            autoComplete="off"
            placeholder="SHA256:…"
            value={draft.hostKey}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, hostKey: event.target.value })}
          />
        )}
      </ConfigField>
      {remote.jump !== undefined && (
        <ConfigField
          label="Jump host key fingerprint"
          path={`${keyFile}.jump`}
          help={
            needsJumpKey
              ? `The key of ${remote.jump}, the jump host, from a source you already trust.`
              : `Already pinned: ${remote.jumpPinned.join(", ")}.`
          }
        >
          {(control) => (
            <input
              {...control}
              className={`orca-input ${textClass("mono-body")}`}
              spellCheck={false}
              autoComplete="off"
              placeholder="SHA256:…"
              value={draft.jumpHostKey}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, jumpHostKey: event.target.value })}
            />
          )}
        </ConfigField>
      )}
      <ConfigField
        label="Credential"
        path={`auth/remotes/${remote.id}.token`}
        help={
          canIssue
            ? remote.credentialSaved
              ? "A credential is saved for this remote and is used as it is. Paste another to replace it."
              : "Leave empty to have the remote issue one over the verified ssh, scoped to the workflows delegated to it. Or paste one it issued."
            : "On this computer the remote cannot issue the credential during enrollment. On the remote run orca auth issue <name> --preset client --json and paste its output here. It is saved readable only by you."
        }
      >
        {(control) => (
          <textarea
            {...control}
            className={`orca-input ${textClass("mono-body")}`}
            rows={2}
            spellCheck={false}
            autoComplete="off"
            value={draft.credential}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, credential: event.target.value })}
          />
        )}
      </ConfigField>
      {canIssue && remote.enrollment.state === "enrolled" && remote.enrollment.issued && (
        <label className={`orca-config__remote-check ${textClass("body")}`}>
          <input
            type="checkbox"
            checked={draft.rotate}
            disabled={busy || draft.credential.trim() !== ""}
            onChange={(event) => setDraft({ ...draft, rotate: event.target.checked })}
          />
          Issue a new credential and retire the current one
        </label>
      )}
      {error !== undefined && (
        <Text style="caption" className="orca-config__remote-error" data-remote-error="">
          {error}
        </Text>
      )}
      <div className="orca-config__remote-actions">
        <Button
          tone="primary"
          size="sm"
          type="submit"
          disabled={busy || reason !== undefined}
          {...(reason ? { disabledReason: reason } : {})}
        >
          {busy ? "Enrolling" : "Enroll remote"}
        </Button>
        <Button tone="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RemotesSection(): JSX.Element | null {
  const listed = useMethodPresent(REMOTES_LIST_METHOD);
  const enrolls = useMethodPresent(REMOTES_ENROLL_METHOD);
  const [shown, setShown] = useState<{ list?: RemotesListResult; failed: boolean }>({ failed: false });
  const [open, setOpen] = useState<string | undefined>();
  const [warnings, setWarnings] = useState<{ id: string; lines: readonly string[] } | undefined>();
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  useEffect(() => {
    const read = window.orca.remotes?.list;
    if (!listed || !read) return;
    let current = true;
    let asked = 0;
    let observed = currentEditorTarget(window.orca);
    const load = () => {
      const ask = ++asked;
      const target = currentEditorTarget(window.orca);
      void read().then((result) => {
        if (!current || ask !== asked) return;
        if (!sameTarget(target, currentEditorTarget(window.orca))) return;
        setShown(result.ok ? { list: result.result, failed: false } : { failed: true });
      });
    };
    load();
    // Another daemon or authority: what was shown is not this one's, so it goes before the next read.
    const unsubscribe = window.orca.daemonConnection?.subscribe(() => {
      const target = currentEditorTarget(window.orca);
      if (sameTarget(target, observed)) return;
      observed = target;
      setShown({ failed: false });
      setOpen(undefined);
      setWarnings(undefined);
      load();
    });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [listed, reload]);
  if (!listed || !window.orca.remotes) return null;
  const list = shown.list;
  return (
    <section className="orca-config__section" aria-label="Remote daemons">
      <div className="orca-config__layer-head">
        <Text style="heading" as="h2">
          Remote daemons
        </Text>
        <Button tone="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <Text style="caption">
        Daemons on other machines this workspace delegates steps to, from remotes: in the active configuration. Each one
        is enrolled once: its host key is pinned and its credential checked, and after that delegation needs nobody.
      </Text>
      {list === undefined ? (
        <Text style="caption" className="orca-config__none">
          {shown.failed ? "The remotes could not be read." : "Reading the remotes…"}
        </Text>
      ) : list.remotes.length === 0 ? (
        <Text style="caption" className="orca-config__none">
          No remotes are configured. Add one under remotes: and an agent with type: orca-daemon in Raw, save and apply,
          then enroll it here.
        </Text>
      ) : (
        <ul className="orca-config__remotes" aria-label="Configured remotes">
          {list.remotes.map((remote) => (
            <li
              key={remote.id}
              className="orca-config__remote"
              data-remote={remote.id}
              data-enrollment={remote.enrollment.state}
            >
              <div className="orca-config__layer-head">
                <Text style="label-strong">{remote.name}</Text>
                <Chip>{stateWord(remote)}</Chip>
              </div>
              <span className={`orca-config__path ${textClass("mono-id")}`}>
                {remote.id} · {remote.destination}
                {remote.sshPort !== undefined ? `:${remote.sshPort}` : ""}
                {remote.jump !== undefined ? ` via ${remote.jump}` : ""}
              </span>
              <Text style="caption">{stateLine(remote)}</Text>
              <Text style="caption">
                {remote.workflows.length
                  ? `Delegated workflows: ${remote.workflows.join(", ")}`
                  : "No agent delegates to it yet, so the remote cannot issue a credential for it."}
              </Text>
              {remote.pinned.length > 0 && (
                <span className={`orca-config__path ${textClass("mono-id")}`} data-remote-pinned="">
                  {remote.pinned.join(", ")}
                </span>
              )}
              {warnings?.id === remote.id &&
                warnings.lines.map((line) => (
                  <Text key={line} style="caption">
                    {line}
                  </Text>
                ))}
              {enrolls && open !== remote.id && (
                <div className="orca-config__remote-actions">
                  <Button tone="ghost" size="sm" onClick={() => setOpen(remote.id)}>
                    {remote.enrollment.state === "none" ? `Enroll ${remote.id}` : `Enroll ${remote.id} again`}
                  </Button>
                </div>
              )}
              {enrolls && open === remote.id && (
                <EnrollForm
                  remote={remote}
                  canIssue={list.canIssue}
                  onCancel={() => setOpen(undefined)}
                  onEnrolled={(updated, lines) => {
                    setOpen(undefined);
                    setWarnings(lines.length ? { id: updated.id, lines } : undefined);
                    setShown({
                      failed: false,
                      list: { ...list, remotes: list.remotes.map((r) => (r.id === updated.id ? updated : r)) },
                    });
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
