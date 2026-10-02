# Authenticated daemon connections (#318)

This story starts from preparation `7abc2342aa672ee9d2f10d565ca4f8eb546184df`.
The owned implementation and tests are committed directly. Shared application,
protocol, CLI bootstrap and export wiring is supplied separately in
[`patches/318-daemon-connection-integration.patch`](patches/318-daemon-connection-integration.patch),
as required by the [parallel integration contract](runtime-next-parallel-contract.md).
Apply that patch before testing the complete UI. This feature branch alone does
not advertise the new UI or hello field as shipped, and does not close the
combined configuration-studio acceptance gate.

## Connecting

After integration, **File ▸ Connect to a daemon…**, the status-bar action, and
Config's connection header open the same dialog. Enter the local end of the
supported SSH tunnel, such as `http://127.0.0.1:6722`. A successful authenticated
`hello` must advertise read and subscription capabilities before the app changes
its saved endpoint or detaches the current stream. Failed, cancelled, incompatible
or unauthorized probes leave the previous connection and preference intact.
Errors are shown inline, with authentication required, invalid/revoked credentials,
access refusal, protocol mismatch and unreachability distinguished.

Precedence at launch is **ORCA_DAEMON_URL > saved endpoint > bundled daemon >
development loopback fallback**. Config and the dialog show the source. An explicit
environment override disables both connection changes and **Use the bundled
daemon**; unset it and restart to enable these actions. After **Open a store…**,
the read-only store banner's **Connect to a daemon** action returns to the exact
launch-pinned environment target, after the all-window draft check. This return
does not change the saved endpoint or allow another target to override the environment.
Returning to bundled clears
the saved endpoint only after its handshake succeeds. A previously active bundled
daemon remains alive when switching to an external endpoint, and is reused on
return, so changing the view does not stop its work. The app still owns its shutdown
when the app quits. If a bundled daemon is retained in the background, return to
it before updating the app so the existing updater can check its active work.

Credentials remain main-process-only. Use the existing `ORCA_DAEMON_TOKEN_FILE`
(or `ORCA_DAEMON_TOKEN`) setup from [daemon security](daemon-security.md).
Ordinary app preferences contain only the endpoint. URLs reject user information,
query strings and fragments. Remote targets require an explicit credential and
HTTPS; redirects are refused. Automatically discovered local-owner credentials
are never forwarded to remote hosts. The UI has no token input and never reports
raw credential-file or candidate transport errors. Credential refresh remains
bounded to one retry per authentication refusal.

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
`packages/store/dist/index.js` after applying the integration patch and building.
It changes identity metadata only, preserving run IDs, protected data and keys.
Do not independently serve two writable copies of the same identity.

Initialization runs under a cross-process store lock, publishes an owner-only
marker before the UUID, and atomically renames the UUID file. A missing/corrupt
UUID, unsafe metadata permissions, symlink or interrupted initialization fails
closed. Restore a complete backup to retain the identity; explicit offline renewal
is the repair path when a new identity is intended. Deleting both the marker and
directory destroys all evidence of prior initialization and is not a repair method.
First upgrade of a never-identified store initializes the metadata once.

## Integration handoff

Apply the supplied patch with `git apply --check` followed by `git apply` on the
reviewed story tree. It wires CLI identity initialization, daemon hello identity,
the store export, main-process target manager, epoch-bound preload RPC/notifications,
renderer boundary, File menu, Config source header and status-bar action. It also
updates the exact native-menu and smoke bridge inventories. No new RPC method,
capability or error enum is introduced; hello identity is additive. The integration
owner chooses the combined protocol minor version with the other stories.

The patch includes `packages/app/test/daemon-connection-integration.test.ts`.
After applying it, run `pnpm exec vitest run daemon-connection packages/app/test/workspace.test.ts`.
The integration regression loads the actual main-process IPC registrations with an
Electron shell fixture and checks environment → read-only store → environment,
draft refusal/release, epoch advancement and unchanged saved preferences. It also
checks that arbitrary and bundled targets remain forbidden under the override.
This IPC regression does not claim real-window or platform smoke coverage.

Dedicated tests cover transaction failures/cancel, saved restart and precedence,
bundled return without cancelling execution, pending edits, old epoch results,
same URL/new workspace, boot changes/rewind, legacy identity, clone and repair.
The current Config and gate drafts use `useUpdateDraft`; future launch/editor forms
from the parallel stories must register with this same guard and remain inside the
connection boundary. The frozen preparation has no launch-vars or workflow editor
to test yet. Existing auth tests cover revoked credentials, bounded file refresh, remote TLS,
redirects and local-owner credential isolation. Shared patch validation results
and remaining platform smoke requirements are recorded in the PR.
