# Authenticated daemon connections (#318)

**Current reading, 7 October 2026:** target/draft isolation is implemented on main,
whose combined protocol is **2.0**, store epoch **`operator-journals-v4`**.
The 1.10 and feature integration checks below identify their original checkpoint.
See [Development](DEVELOPMENT.md) for current source setup and the
[capability ledger](ROADMAP.md) for guided-launch and native release gaps.

The combined runtime includes the connection UI, authenticated target switching and
persistent workspace identity. [318-daemon-connection-integration.patch](patches/318-daemon-connection-integration.patch)
is a historical handoff against preparation baseline
`7abc2342aa672ee9d2f10d565ca4f8eb546184df`. Its wiring is reconciled here; do not
reapply it. See [integration review status](runtime-next-integration.md#review-status-and-final-reconciliation)
for the remaining combined validation gates.

## Connecting

**File ▸ Connect to a daemon…**, the status-bar action, and
Config's connection header open the same dialog. Choose a saved SSH profile (below),
or enter a URL such as the local end of an SSH tunnel you run yourself,
`http://127.0.0.1:6722`. A successful authenticated
`hello` must advertise read and subscription capabilities before the app changes
its saved endpoint or detaches the current stream. Failed, cancelled, incompatible
or unauthorized probes leave the previous connection and preference intact.
Dialog probe errors are shown inline, with authentication required, invalid/revoked credentials,
access refusal, protocol mismatch and unreachability distinguished.

Precedence at launch is **ORCA_DAEMON_URL > saved endpoint or SSH profile > bundled daemon >
development loopback fallback**. Config and the dialog show the source. An explicit
environment override disables both connection changes and **Use the bundled
daemon**; unset it and restart to enable these actions. After **Open a store…**,
the read-only store banner's **Connect to a daemon** action returns to the exact
launch-pinned environment target through the same authenticated probe and all-window
draft check as other connection changes. A failed, incompatible or cancelled return
keeps the store client, stream and read-only daemon running. This return does not change
the saved endpoint or allow another target to override the environment. Refusals are shown in the store banner, including interrupted IPC; stale errors from a
previous target are discarded. The dialog prefills only saved/environment endpoints,
and the main process refuses to save a current or parked bundled daemon's temporary URL.
Returning to bundled clears
the saved endpoint only after its handshake succeeds. A previously active bundled
daemon remains alive when switching to an external endpoint, and is reused on
return, so changing the view does not stop its work. The app still owns its shutdown
when the app quits. If a bundled daemon is retained in the background, return to
it before updating the app so the existing updater can check its active work.

Credentials remain main-process-only. A URL connection uses the existing
`ORCA_DAEMON_TOKEN_FILE` (or `ORCA_DAEMON_TOKEN`) setup from
[daemon security](daemon-security.md); an SSH profile uses its keychain slot.
Ordinary app preferences contain only the endpoint. URLs reject user information,
query strings and fragments. Remote targets require an explicit credential and
HTTPS; redirects are refused. Automatically discovered local-owner credentials
are never forwarded to remote hosts. The UI has no token input and never reports
raw credential-file or candidate transport errors. Credential refresh remains
bounded to one retry per authentication refusal. Refreshing a client's credential does
not itself replace a run's execution actor. A new local ACP submission intent can refresh
its existing same-principal credential; historical daemon execution instead uses the
explicit current-authority `runs.resume` boundary documented in
[live input continuity](live-input-continuity.md#expiration-reconnect-and-other-processes).

## SSH connection profiles (#874)

The default way to reach a daemon on another machine is a saved **SSH profile**: the
app runs the tunnel itself and the daemon stays bound to the server's loopback. In
the connection dialog, **Add profile…** takes a name, `user@host`, an optional SSH
port, an optional private key path, an optional jump host and the daemon's port on
the server (default 6722), plus the sign-in settings below. These typed fields are all
a profile holds: there are no free-form ssh options, and no ssh config file (yours or
the system's) is read. **Connect** signs in on its own the first time (see
[Automatic sign-in](#automatic-sign-in-875)). **Import credential…** is the manual
alternative: it opens a file picker in the main process and seals the chosen daemon
credential (for example one printed by `orca auth issue … --preset client` on the
server) into the profile's slot in the OS keychain; the token never reaches the
renderer, the preferences file or a log. **Connect** then probes the daemon through
the tunnel with the same authenticated `hello`, draft check and refusal rules as a
URL, and a refused probe closes the candidate tunnel and leaves the previous
connection and saved target as they were.

The main process owns each tunnel. Every connection to the daemon (each pooled HTTP
connection for RPCs, and the push stream's WebSocket) is its own
`ssh -F none -W 127.0.0.1:<daemon port> [user@]host`, carried on that ssh's
stdin/stdout, with `BatchMode=yes` (your keys or agent, never a prompt) and every
other option that matters set on the command line (no `ProxyCommand`, no agent or X11
forwarding, no local commands, no connection sharing, no DNS or IP host-key checks).
The server's host key is pinned in an app-owned known-hosts file, recorded under a
per-profile alias, on the first successful connect (`StrictHostKeyChecking=accept-new`)
and enforced afterwards (`yes`); that file is both the user and the global known-hosts
source, so nothing else can vouch for the server. A jump host is a persistent
app-owned ssh forwarding a private loopback port to the server's sshd, with its own
pin; each connection's ssh goes through it and authenticates the server end to end
against the server's pin.

The credential is bound to those streams, not to an address. The app's client never
dials a local port for a profile: each request is written into the ssh stream for its
connection, so it reaches the pinned, authenticated server or nowhere. When that ssh
ends, the connection ends with it and nothing is redialled or reissued under it; the
push stream reconnects over a new stream under the existing epoch and cursor rules.
There is no local port forward for another local process to take over while ssh is
down. The profile's `127.0.0.1:<port>` address is a listener the app holds for the
tunnel's whole life, so no other process can bind it, and anything that does dial it
also gets a fresh authenticated stream. After the profile is left, edited, removed or
its host key forgotten, its old lease opens no connection and reads no credential.
A changed or missing host key, failed authentication or a missing ssh stops the tunnel
(`failed`); other failures show reconnecting until a new stream authenticates. Behind a
jump host, a dropped jump ssh ends every connection through it and restarts with
backoff (1 s doubling to 30 s). Leaving the profile, removing it or quitting stops its
tunnel.

Each failure has its own message: no ssh client, changed host key (with **Forget
host key** for a server that was deliberately rebuilt), failed SSH authentication,
unreachable server, a local address that could not be held, a timeout, and an
SSH connection that works with no daemon listening on the server (a Windows OpenSSH
server does not refuse that channel, so there it shows as a timeout). Removing a profile
deletes its keychain credential and pinned key, after revoking the credential on the
server when it can. Editing a profile to point at a different server or daemon port
forgets both.

Only a profile that was never pinned trusts the key its server presents on the first
connect. Once a connect has pinned a key, the app records the enrollment beside the
pin; if the pin file is later deleted, emptied or unreadable, connects fail closed
("pinned host key missing") until **Forget host key** resets it, so a lost file never
silently re-enrolls a different key. Forgetting is refused while a connect to that
profile is in flight or open.

A credential import is tied to the profile it was started for: if the profile is
edited, removed or its host key forgotten while the file picker is open, the picked
file is not stored and the import has to be repeated. A connect that was in flight
across such a change does not complete, and an existing connection stops offering the
credential.

Profiles live in `<userData>/remote-daemons/` (`profiles.json`, `known_hosts/`,
`credentials/`); the saved target is the profile's id in the app preferences, and it
replaces a saved URL. `ORCA_DAEMON_URL` and `ORCA_DAEMON_TOKEN_FILE` keep their
precedence: an environment override still pins the launch and disables profile
switching. The tunnel and the
credential slots live in `@orca/protocol/remote-access`, which the daemon can import
for delegation (#883). Windows uses the built-in OpenSSH client (`ssh.exe`).

### Automatic sign-in (#875)

A profile with no credential gets one on its first connect, with no token to copy.
Once the tunnel's ssh has authenticated the server against its pin, the app runs
ORCA's own command line there over the same kind of config-free ssh:

```
<server command> auth issue desktop-<host name>-<installation id> --preset client|viewer \
  --expires-at <now + 90 days> --label orca-app-<profile> [--config <workspace config>] --json
```

The principal names this installation of the app, which owns the runs it starts: the
host name for people reading `orca auth list`, plus an installation id made once and kept
in `<userData>/remote-daemons/installation.json`, so two installations never share a
principal, even on machines with the same name.

Commands on the server never trust a host key on first use: they run only once the
server (and its jump host) is pinned, with `StrictHostKeyChecking=yes`, and are refused
before ssh starts otherwise. OpenSSH joins the command's words into one command text for
the server's shell, so each word is limited to letters, digits and `. _ : / -`, which
read as the same literal text in sh, cmd and PowerShell: no quoting, escaping or
expansion applies. Paths on a Windows server are written with `/` (`C:/ORCA/orca.cmd`).
A command's result is read only after ssh has exited and its output has drained, within
a bound; output that does not end is a failure.

- **Server command** is ORCA's CLI on the server: `orca` on the SSH user's `PATH` by
  default, or a full path such as a managed install's wrapper.
- **Workspace config** is the daemon's config file on the server, passed as `--config`.
  Without it the CLI uses the SSH user's default (a config found from the home
  directory, or the home directory itself), which must be the daemon's workspace.
- **Read only** issues the credential with the `viewer` preset, for profiles that only
  watch runs and plans.

A new credential is never used until the daemon has accepted it. Every secret the app
keeps goes into a fresh keychain slot of its own (`credentials/vault/<slot>.credential`)
that is never overwritten; the profile's small nonsecret record
(`credentials/<profile>.json`) says which slot is in use, which is staged and whether
it was imported, with each credential's id, expiry and where it was issued (server, CLI
and workspace config). A credential changes role (staged, in use, imported, retired)
only in one write of that record, and the slot it replaces is deleted after the write,
so an interrupted write or a restart leaves the previous record and its slot as they
were. Slots no record names are removed at startup, but only when every record could be
read: a record that cannot be read may name any slot. A credential file from an older
build is taken over as an import. A credential the keychain cannot keep is revoked on
the server at once. The app then asks the daemon about it over the tunnel: `hello`, then
`operator.discover`. A `hello` answer alone proves nothing, since a daemon that does not
authenticate its callers answers it whatever the token. The credential switches in only
on positive proof: the token is the credential the CLI reported for this installation's
principal, and the daemon answers discovery for it as an authenticated credential, for
that principal, naming its workspace (the same one as before, if the profile had a
credential). Then the workspace id is remembered, and the credential it replaces is
revoked. A daemon that answers without that proof (one that does not authenticate
callers, or an older ORCA) gets the credential revoked again, and the connect asks to
update ORCA on the server. If the daemon cannot be asked (no daemon running, say), nothing
switches: the staged credential waits for the next connect, and the one in use stays.
If the daemon refuses a credential that was just issued, or answers from another
workspace than before, the CLI issued it for another workspace than the daemon's on
that port, so the app revokes it again and asks for the profile's workspace config.
Concurrent connects of one profile share a single setup, so the server issues one
credential. Tokens are never printed, logged or written anywhere but the keychain.

While connected, the app checks every 12 hours and renews a credential once less than
30 days are left, the same way: a new credential, accepted by the daemon, then the old
one revoked. A profile that is not connected renews on its next connect, and a renewal
that fails leaves the current credential in use while it is valid. A credential the
daemon refuses (expired or revoked on the server) gets one replacement, then a clear
refusal.

Credentials are bound to the host keys they were issued through, the server's and the
jump host's. Each tunnel seals its pins once its hops are pinned: it copies them into files
of its own and checks every later ssh it starts, for a connection or a command, against
those copies, so a pin file changed while the tunnel lives changes nothing it carries. A
credential is sent only on a tunnel sealed with the keys it is bound to, promoted only
while the pins still vouch for the keys it was confirmed through, and revoked only through
a tunnel sealed with the keys it was issued through. **Forget host key** quarantines the profile's credentials: they go on the
list to revoke and are never sent to whatever answers under a new key. The same happens
if the pinned key changes in any other way. An imported credential is bound to the keys
it was first accepted through; after a key reset it is not sent until the person imports
it again or switches to automatic sign-in.

Every replaced credential is revoked where it was issued, with the CLI and workspace
config it was issued under, and only through the server and the very host keys it was
issued through. One that
cannot be revoked yet stays on the profile's list ("old credentials not revoked yet")
and is tried again on later connects. Changing the server command, workspace config or
read-only setting replaces the credential on the next connect; pointing the profile at
another server keeps the old server's credentials on the list, since the new server
cannot revoke them. Removing a profile revokes everything on its list through its
pinned host key first; if any of it cannot be revoked, the profile is still removed and
the dialog says those credentials stay valid until they expire. While a removal is
revoking, the profile cannot be edited, connected, imported into or reset.

An imported credential is the person's: the app never renews, replaces or revokes it.
If the daemon refuses it, the connect says so; **Use automatic sign-in** drops the import
so the next connect issues one. Importing over a credential the app had issued puts
that one on the list to revoke.

Failures name what to do: ORCA not found on the server under the server command, not
allowed to run it, no workspace there (or a workspace config path with no file), another
CLI failure (run `orca auth list` on the server), the daemon on the port belonging to
another workspace, a daemon that does not name its workspace, a refused credential that
could not be replaced, a refused import, an import waiting for authorization after a key
reset, and a keychain that could not keep the new credential. Server output is never shown or
logged.

### Choosing a remote access path

- **App-managed SSH profile (default).** Nothing listens beyond the server's
  loopback, the only network service is sshd, and the app manages the tunnel, host
  key and credential.
- **Overlay network plus a TLS reverse proxy.** For clients that cannot use SSH:
  terminate HTTPS at a proxy you run, list it in `trustedProxies`, and connect with a
  URL and `ORCA_DAEMON_TOKEN_FILE` (see [daemon security](daemon-security.md)).
- **Plain `SshHost`.** When a machine only runs agents and has no daemon of its own,
  configure it as an SSH host in the workflow config instead
  ([integrations](INTEGRATIONS.md)).

## Watching several daemons (#882)

The app connects to one daemon at a time for everything it shows and writes: the
**focused** target above. The **Machines** surface (`⌘7`) adds read-only connections
beside it, so several daemons can be watched at once without the daemons talking to
each other:

- **What is watched.** Saved SSH profiles a person adds with **Watch a machine…**
  (stored main-only as `watchedProfiles` in the preferences file, at most 16), and the
  bundled daemon whenever the app has parked it because focus moved to another daemon.
  The focused daemon is always listed first.
- **One connection each.** Every watched machine has its own client, push stream,
  cursor and credential (a profile lease over its own `ssh -W` streams), managed in
  `packages/app/src/main/fleet.ts`. Each connection has a generation that every frame
  and read captures, and each identity seen on it a scope, so a late reply or frame
  from an old connection or another store is dropped instead of shown under this
  machine. A reconnect reads `runs.list` and `inputs.list` again rather than replaying
  frames, so nothing appears twice.
- **Shown only for a verified store.** Each answer a machine keeps is bound to the
  workspace id that the connection's `hello` verified. After a reopen it is held back
  until the new connection verifies that same workspace; a different or missing
  identity, a refused credential (`auth-failed` or an authentication error on a read)
  or any change to the profile (edit, host key reset or credential import, all of
  which raise its revision) drops it and its alerts at once.
- **Read-only.** A watched connection only calls `hello`, `runs.list`, `inputs.list`
  and `subscribe`. Its rows name the work and do not open it. **Focus** goes through
  the same path as the connection dialog (authenticated probe, then the all-window
  draft check), after which the fleet closes its own connection to that machine so it
  is never streamed twice, and reopens the one it stopped focusing if it is watched.
- **Freshness.** A machine shows the design's connection states with the same five
  quiet seconds as the status bar. One that drops out keeps its last answer under
  "Last heard …"; one that has never answered says "Not read yet", and the summary's
  counts leave it out, so a missing machine never reads as zero work. A tunnel that
  will not open is retried with backoff up to once a minute.
- **Slots.** When a daemon reports `hello.sessionSlots` (#873), its section shows
  sessions in use against the cap and the queue depth.
- **Notifications.** Waiting gates, permission asks and failures it saw happen on a
  watched machine post OS notifications that name the machine ("Build is waiting on
  build-box"). Alert ids are scoped by the verified workspace id, so moving focus or
  renaming the profile does not post the same alert twice. While focus changes hands
  there is a moment when neither the fleet nor the renderer states an alert; the
  alerts manager remembers the last 512 ids it already presented, so one that comes
  back is not posted or brought forward again. Each alert also carries the workspace
  it was verified on, and a click routes only while its machine still reaches that
  workspace, and for the focused daemon only while it is authorized on the current
  link (a refusal ends that even though the last workspace id is still known); a
  click on an alert from a repointed, refused or unwatched machine just brings the
  window forward.
- **Changing a watched profile.** A profile is not edited, removed, reset or given a
  credential while any tunnel of it is open (#875). For a watched profile the fleet
  lets go of its connection for the length of the change and then reopens it, so the
  person does not have to stop watching first. Clicking one from an unfocused machine opens Machines. The dock badge
  stays the focused daemon's count, the same number as the title bar.

Not here yet: observe-only profiles with read-only credentials wait on #875's
credential bootstrap.

## Target identity and drafts

Authenticated hello can include `{ identity: { workspaceId, instanceId } }`.
`workspaceId` is a persistent opaque UUID; `instanceId` is generated once per daemon
boot and shared by HTTP and WebSocket. Neither is authorization. The CLI initializes
identity from its real store at bootstrap; `startDaemon` accepts `workspaceId` for
embedded callers. Its existing `storeDir` display field does not cause filesystem
writes. Older embedded daemons may omit identity and are handled conservatively.

The main process owns a monotonically increasing connection epoch. RPC requests
carry the renderer's accepted epoch; mismatches are rejected before dispatch and
late responses are rejected before delivery. Target changes clear old native
notifications. Old socket frames and notifications cannot enter the new target.
New identities, daemon boots and identity-less reconnects clear subscription
cursors, including an original `since` supplied by a caller, to cover restored
histories that rewound.

Deliberate switches use the existing all-window draft acknowledgement and refuse
while launch/config/editor drafts are pending. The editor text stays where it was.
An unsolicited target/boot change preserves the old mounted editors but freezes
access to their daemon scope. The user must explicitly discard those drafts to
load the new target. Clean changes unmount old resource selections before the
preload accepts the new epoch. No switch answers, approves, resumes or cancels a run.
Already-dispatched operations may finish on their original daemon; they are never
reissued to the replacement.

## Backup, independent clone and repair

Include `.workspace-identified` and the entire `workspace-identity/` directory in
store backups. Replacement restore retains the workspace UUID; the new daemon boot
gets a new instance UUID. Stop the old writable copy before starting its replacement.

An independently operated clone must get a new workspace UUID before it is served.
With the clone offline, use the exported store administration function:

```js
import { renewWorkspaceIdentity } from "@orca/store";
await renewWorkspaceIdentity(cloneStoreDirectory);
```

For a source checkout, the same function is exported by
`packages/store/dist/index.js` after building the source checkout. This is an offline
administration API, not a shipped CLI identity-repair command.
It changes identity metadata only, preserving run IDs, protected data and keys.
Do not independently serve two writable copies of the same identity.

Initialization runs under a cross-process store lock, publishes an owner-only
marker before the UUID, and atomically renames the UUID file. A missing/corrupt
UUID, unsafe metadata permissions, symlink or interrupted initialization fails
closed. Restore a complete backup to retain the identity; explicit offline renewal
is the repair path when a new identity is intended. Deleting both the marker and
directory destroys all evidence of prior initialization and is not a repair method.
First upgrade of a never-identified store initializes the metadata once.

## Integrated wiring and checks

CLI identity initialization, daemon hello identity, store exports, the main-process target
manager, epoch-bound preload RPC/notifications, renderer boundary, File menu, Config
header and status action are wired in this tree. Hello identity is additive and the
combined protocol minor is 1.10; this feature adds no RPC method or capability class.

`packages/app/test/daemon-connection-integration.test.ts` exercises the integrated IPC
wiring. Run `pnpm exec vitest run daemon-connection packages/app/test/workspace.test.ts`.
The integration regression loads the actual main-process IPC registrations with an
Electron shell fixture and checks environment → read-only store → environment,
failed authentication, incompatible protocol, missing read/subscription authority,
cancelled probes, draft refusal/release, epoch advancement and unchanged saved
preferences. Refused returns retain the store client, stream and daemon. It also
checks that arbitrary and bundled targets remain forbidden under the override.
This IPC regression does not claim real-window or platform smoke coverage.

Dedicated tests cover transaction failures/cancel, saved restart and precedence,
bundled return without cancelling execution, pending edits, old epoch results,
same URL/new workspace, boot changes/rewind, legacy identity, clone and repair.
Config and gate drafts use `useUpdateDraft`; additional editor forms must register with
that guard and remain inside the connection boundary. Existing auth tests cover revoked
credentials, bounded file refresh, remote TLS, redirects and local-owner credential
isolation. Historical feature validation does not resolve the combined review findings;
final runtime and platform smoke evidence must be recorded in the PR.
