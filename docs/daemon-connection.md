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
the server (default 6722). These typed fields are all a profile holds: there are no
free-form ssh options, and no ssh config file (yours or the system's) is read.
**Import credential…** opens a file picker in the main process and seals the chosen
daemon credential (for example one printed by `orca auth issue … --preset client` on
the server) into the profile's slot in the OS keychain; the token never reaches the
renderer, the preferences file or a log. **Connect** then probes the daemon through
the tunnel with the same authenticated `hello`, draft check and refusal rules as a
URL, and a refused probe closes the candidate tunnel and leaves the previous
connection and saved target as they were.

The main process owns each tunnel:
`ssh -F none -N -L 127.0.0.1:<ephemeral>:127.0.0.1:<daemon port> [user@]host` with
`BatchMode=yes` (your keys or agent, never a prompt), `ExitOnForwardFailure=yes`, and
every other option that matters set on the command line (no `ProxyCommand`, no agent
or X11 forwarding, no local commands, no connection sharing, no DNS or IP host-key
checks). The server's host key is pinned in an app-owned known-hosts file, recorded
under a per-profile alias, on the first successful connect
(`StrictHostKeyChecking=accept-new`) and enforced afterwards (`yes`); that file is both
the user and the global known-hosts source, so nothing else can vouch for the server.
A jump host is a second app-owned ssh, forwarding a private loopback port to the
server's sshd, with its own pin; the ssh to the server goes through it and is checked
against the server's pin.

The credential is offered only while the tunnel is verified: every ssh of the current
start has authenticated its server against its pin, bound its forward, and is still
running, so the local port is provably the tunnel's. While the tunnel is down or
restarting, HTTP requests and the WebSocket send nothing and fail as an unreachable
daemon (not as a refused credential). If the tunnel drops while in use, ssh is
restarted with backoff (1 s doubling to 30 s) on the same local port, so the
connection shows reconnecting and the stream resumes under the existing epoch and
cursor rules; no operation is reissued. A changed host key, failed authentication or
a missing ssh stops the restarts. Leaving the profile, removing it or quitting stops
its tunnel.

Each failure has its own message: no ssh client, changed host key (with **Forget
host key** for a server that was deliberately rebuilt), failed SSH authentication,
unreachable server, a local tunnel port that could not be bound, a timeout, and an
SSH connection that works with no daemon listening on the server. Removing a profile
deletes its keychain credential and pinned key. Editing a profile to point at a
different server or daemon port forgets both.

Profiles live in `<userData>/remote-daemons/` (`profiles.json`, `known_hosts/`,
`credentials/`); the saved target is the profile's id in the app preferences, and it
replaces a saved URL. `ORCA_DAEMON_URL` and `ORCA_DAEMON_TOKEN_FILE` keep their
precedence: an environment override still pins the launch and disables profile
switching. The tunnel and the
credential slots live in `@orca/protocol/remote-access`, which the daemon can import
for delegation (#883). Windows uses the built-in OpenSSH client (`ssh.exe`).

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
