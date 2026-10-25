# Updating ORCA (v0.6.0)

Updates are explicit. Desktop and server installations are independent: updating the
Windows app never installs anything on an attached server. No installation command is
exposed through daemon RPC. The additive protocol 1.8 `maintenance` method only closes
or reopens admission; it accepts no URL, path, shell command or package name.

The approved bundle ID is now `com.schadewitz.orca`. Windows deliberately retains
`dev.orca.desktop` as its packaging override to preserve NSIS upgrades and shortcuts.
App names and data paths are unchanged; no data migration or deletion is included.
Existing Mac installs require native permission/Keychain continuity checks before
distribution; see [application identity and existing installations](RELEASING.md#approved-application-identity-and-existing-installations).
Signing and macOS automatic updates are not activated by this identity change.

## Windows bootstrap and daily use

Install the matching x64 or arm64 NSIS `.exe` from a published release. ZIP builds are
archives, not the supported installation/update path. A pre-v0.6.0 desktop has no update
control; install v0.6.0 manually once. Retain a known-good installer for recovery.

The header and command palette offer **Check for updates**, **Download VERSION**, and
**Restart to update to VERSION**. Checking does not download. Downloading does not install,
and ordinary exit does not install a cached update. The download percentage describes
installer bytes, not run progress. Failed checks/downloads can be retried. Network and
credential details never cross into the renderer.

Restart freezes interaction and asks every window to acknowledge that its configuration,
permission and answer drafts are clear. Save, send or discard drafts before retrying. A
missing/unresponsive window blocks restart. Next the main process asks its **owned** daemon
to close admission atomically. Any in-flight request (including a running agent operation)
blocks the attempt; no work is killed. Durable parked gates have returned their leases and
survive restart. Once admission is closed, new calls cannot race with shutdown. The owned
daemon is stopped before the installer launches. An external daemon is neither stopped nor
installed by this path.

### Windows failed-update recovery contract (#660, C5a-02)

The user approved this implementation direction on 25 October 2026: treat an installer
timeout or ambiguous error as unknown, keep admission paused, and reconnect automatically
only when installation is positively known not to have started and the old child has
terminated. That approval does not authorize deployment, new access or private-command
disclosure.

| Installer observation | Recovery behavior |
| --- | --- |
| Positively not launched | A failure before invoking the installer, or the driver's explicit pre-invocation non-launch result, permits exact-token abort. A stopped first-run child must have positively observed termination and its captured ownership must settle before saved-receipt recovery. |
| Positively launched | Keep admission and draft guards closed while waiting for app exit. Launch alone does not prove successful replacement. |
| Timeout after `quitAndInstall` | Unknown. Keep admission closed and the captured attempt and ownership evidence; do not abort or reconnect. |
| Unclassified error/throw after invocation | Unknown, with the same fences as timeout. An updater error event is not proof of non-launch. |

The Windows driver has no positive native launch acknowledgement: returning from
`quitAndInstall` is not treated as launch proof. Its timeout, synchronous throw and error
event all report unknown. A successful installation normally exits the process.

Update stop retains the exact old child and first-run reservation. Even a late exit
callback or ordinary app close cannot settle that reservation while installer outcome is
unknown. On a proven non-launch abort, settlement appends exact-child terminal evidence;
it does not delete the journal or authorize generic connection. Recovery verifies the
saved selection, configuration/assets, authentication, writable capabilities, PID, store,
workspace identity and operator discovery through `FirstRunSetup`. Only the captured
workspace may request a new candidate, and old tokens, changed targets and late/duplicate
recovery calls cannot start another writer.

A missing/changed receipt, uncertain child or replacement cleanup, altered ownership
evidence, failed resume, or unavailable saved-receipt recovery leaves the update blocked
and reports failure. A stopped legacy/file-mode child without this receipt path does not
fall back to generic reconnect. Preserve the workspace and journal for operator review;
retry is not evidence that installation never began. Source/fixture tests do not establish
packaged Windows/NSIS update success. No installer activation is part of this change.

### Private feed and authentication

Use a dedicated private HTTPS static feed, served independently of the private GitHub
repository. Provision a random **read-only feed bearer token** on each Windows account in
an ACL-protected text file. Give the account, Administrators and SYSTEM access only. Do
not use a GitHub token as this credential. Configure the environment inherited by ORCA:

```powershell
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_URL', 'https://updates.example.net/stable/', 'User')
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_TOKEN_FILE', 'C:\Users\YOU\AppData\Local\ORCA\feed-token.txt', 'User')
```

Restart ORCA after changing environment variables. Rotating the token file takes effect at
the next check. URLs must be HTTPS and contain no credentials, query or fragment. Main
constructs `NsisUpdater` with Authorization headers (the
[documented custom updater configuration](https://www.electron.build/docs/features/auto-update/#custom-options-instantiating-updater-directly)); preload exposes only actions and
sanitized state. Nothing writes the token into installers, metadata, repository files or
renderer storage. The placeholder `updates.invalid` in packaging is deliberately unusable.
No credential prompt or hidden fallback to a public feed is provided.

An nginx example for the feed host (TLS configuration and token provisioning are local):

```nginx
# In http {}; /etc/nginx/orca-feed-tokens.conf is root-readable, never in Git.
map $http_authorization $orca_feed_allowed {
    default 0;
    include /etc/nginx/orca-feed-tokens.conf;
}
# Token file contains: "Bearer YOUR_RANDOM_FEED_TOKEN" 1;
server {
    listen 443 ssl;
    server_name updates.example.net;
    # ssl_certificate /...; ssl_certificate_key /...;
    root /srv/orca-feed;
    location / {
        if ($orca_feed_allowed = 0) { return 401; }
        add_header Cache-Control "no-store" always;
        try_files $uri =404;
    }
}
```

Authenticate **all** files, including `.yml`, `.exe`, `.blockmap`, HEAD and Range requests.
Keep authorization out of access logs. This is a trusted distribution host: it can deliver
code. Protect its write account separately from client read tokens. Do not add redirects
to another origin. Retain immutable version snapshots and atomically switch the `stable`
symlink only after the entire snapshot is present. Missing old differential blockmaps can
fall back to a full verified installer download.

### Release/feed provisioning

`desktop.yml` builds Windows architectures separately, with distinct installer names and
`latest-x64.yml` / `latest-arm64.yml`. Prereleases instead carry `prerelease-*.yml`; production
clients request only `latest-ARCH.yml`, disallow prereleases and disallow downgrades. Linux
and macOS build targets are preserved; their automatic updating is outside this iteration.

All packaging uses `--publish never`. The final publication job waits for the existing
checks, smoke/type proof and platform builds. It flattens assets with collision checks,
checks both metadata versions, SHA-512 checksums and blockmap presence, uploads to a draft
release, then makes the complete release visible. A failed upload leaves a draft for
inspection rather than a partial discoverable feed. Delete that failed draft/tag only after
confirming it was never published, before retrying the existing release process.

For automatic feed deployment configure repository variables `ORCA_FEED_HOST`
(`feed-writer@host`) and `ORCA_FEED_ROOT` (`/srv/orca-feed`), and secrets
`ORCA_FEED_SSH_KEY` and `ORCA_FEED_KNOWN_HOSTS`. The dedicated SSH account needs write access
only to the feed root and its temporary upload; configure Python 3 on that host. Pin the
host key, provision HTTPS and client authentication first. The publication job uploads a
complete snapshot and atomically selects `stable` or `prerelease`. Without these variables,
GitHub release publication still works, but desktop feed distribution is unconfigured.
A feed failure leaves the previous feed selected; repair it by copying the **already
verified published release assets** and invoking `publish-feed.py ROOT VERSION ARCHIVE`
on the host. Do not rerun release creation for an already published tag.

Windows signing is **not proven or provisioned by this change**. Current builds remain
unsigned. Bootstrap requires trusting the installer through Windows' unsigned-app warning;
that is not production signing evidence. Before wider rollout configure electron-builder
Windows signing, timestamping and a stable publisher identity, then verify signature
checking with both valid and wrong-publisher installers. Use Azure Trusted Signing or an
appropriate certificate/HSM setup; the existing signing notes in RELEASING.md apply. Do not
weaken signature validation to get a test green. HTTPS/checksums protect distribution but
do not substitute for publisher identity.

## Debian: inventory before migration

There is no assumption that `/srv/dev/orca-live` currently uses systemd. The setup notes do
not contain its actual wrappers or service definition. Before migration, inspect locally:

```sh
sed -n '1,200p' /srv/dev/orca-live/orca /srv/dev/orca-live/orca-acp
ps -u "$(id -u)" -o pid,ppid,args
systemctl --user list-units --all '*orca*'
systemctl list-units --all '*orca*'
# For the actual unit, if one exists:
systemctl --user cat orca.service
systemctl --user show orca.service -p MainPID -p ExecStart -p WorkingDirectory -p EnvironmentFiles
```

Also inspect cron, shell sessions, containers and Kepler launch settings as applicable.
Record every launch path and all config globs into the old worktree. Do not mark the
inventory complete while any unmanaged launcher remains. The updater additionally checks
same-user `/proc` ORCA processes and verifies systemd's MainPID is the exact selected CLI.
An unknown service/PID, unavailable `/proc`, or old daemon without admission support blocks
activation. This is a **single-user managed deployment**, not a security boundary against
an operator deliberately bypassing wrappers or another account writing these stores.

Keep `/srv/dev/orca-live` as the operator directory. Keep configs, permission sidecars,
credentials, `.orca`, `.orca-kepler`, task worktrees and agent installations outside
`releases/`. Back them up before bootstrap. Never install or upgrade Claude Code or its ACP
adapter as part of this procedure.

### Bootstrap once, during an idle maintenance window

The separately installed Python command is deliberate: recovery must still run when the
selected Node checkout cannot start. It also owns Debian's kernel `flock` launch boundary.
This is the `orca-release` equivalent of `orca update`, rather than a CLI command that would
itself hold the admission lock it needs to acquire exclusively.

Prerequisites: Linux, Python 3.8+, util-linux/procfs, Git, authenticated GitHub CLI, mise,
and the **actual operator's** service account. GitHub authentication stays in `gh`'s local
credential store/environment. Do not put tokens in clone URLs or deployment JSON. Mise
installs the release's toolchain; pnpm uses the frozen lockfile. Ensure that account can
reach the registry and has sufficient staging disk space.

1. Stop admitting new CLI/Kepler work through the existing launch mechanism, finish active
   sessions, and stop the existing idle daemon using its **observed** supervisor. Do not
   kill active work. This one-time old-version migration cannot use a guard absent from
   old releases.
2. Copy `tools/deploy/orca-release.py` from the reviewed release to
   `/srv/dev/orca-live/orca-release.py`. Keep it outside replaceable checkouts.
3. Replace only shipped workflow/template prefixes in both configs with literal
   `${ORCA_RELEASE}` (single-quoted YAML strings work). Preserve custom paths and every
   other key. For example:

   ```yaml
   workflows: ['${ORCA_RELEASE}/workflows/**/*.yaml']
   templates: ['${ORCA_RELEASE}/templates/**/*.md']
   ```

4. Write `/srv/dev/orca-live/deployment.json`, substituting the paths and service actually
   chosen. `launchAudit` is an operator assertion after the inventory, not an automatic
   discovery result:

   ```json
   {
     "root": "/srv/dev/orca-live",
     "repository": "cschadewitz/Project_Orca",
     "cwd": "/srv/dev/orca-live",
     "cliConfig": "/srv/dev/orca-live/orca.config.yaml",
     "daemonConfig": "/srv/dev/orca-live/orca.config.yaml",
     "acpConfig": "/srv/dev/orca-live/orca-kepler.config.yaml",
     "url": "http://127.0.0.1:6722",
     "service": "orca.service",
     "userService": true,
     "launchAudit": "all-cli-acp-and-daemon-launches-migrated"
   }
   ```

5. Stage the first release (only once it is published):

   ```sh
   python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json stage v0.6.0
   ln -s /srv/dev/orca-live/releases/v0.6.0 /srv/dev/orca-live/current
   ```

   Staging refuses existing directories, unpublished tags and prereleases. It clones a new
   version directory, installs/builds, checks the compiled version, runs the scripted demo,
   validates all three operator configs without writing them, and checks a temporary daemon's
   hello. Failed stages remain visibly named `.staging-*` for diagnosis; never select them.
6. Replace the wrapper bodies (preserving required operator environment):

   ```sh
   # /srv/dev/orca-live/orca
   #!/bin/sh
   exec /usr/bin/python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json cli "$@"
   ```

   `orca-acp` is identical except `acp` replaces `cli`. Keep Kepler pointing at that stable
   wrapper. ACP keeps its separate config/store. The wrapper resolves `current` to a
   concrete path under its shared launch lock and uses the release's recorded absolute
   Node executable. `${ORCA_RELEASE}` expands once into that same concrete directory.
7. Where systemd is the chosen migration target, install the following as the operator's
   `~/.config/systemd/user/orca.service`:

   ```ini
   [Unit]
   Description=ORCA managed daemon
   After=network.target
   [Service]
   Type=simple
   WorkingDirectory=/srv/dev/orca-live
   EnvironmentFile=/srv/dev/orca-live/daemon.env
   ExecStart=/usr/bin/python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json daemon
   Restart=on-failure
   TimeoutStopSec=20
   [Install]
   WantedBy=default.target
   ```

   A user unit runs as the user installing it; do not add `User=` to a user unit. For a
   system unit use an explicit `User=OPERATOR`, the matching environment/home, and
   `userService: false`; grant only required service-control rights. Create `daemon.env`
   with the required agent PATH/credentials (mode 0600), without shell commands or mise
   activation. The adapter execs `.orca-release.json`'s absolute Node executable; it does
   not depend on interactive shell activation. Review that exact executable before start.
   Run `systemctl --user daemon-reload`, then `enable --now orca.service` only after the
   old supervisor is disabled. Verify hello and a scripted run before reopening launches.

### Normal update

```sh
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json update v0.6.1
```

The tag is explicit; no background apply is installed. Staging permits current work to
continue. Activation acquires the deployment update lock and exclusive launch lock,
verifies the service identity and old hello, then closes daemon admission. Active CLI/ACP
processes (including idle but still open Kepler sessions), concurrent updates and daemon
work produce a blocker and nonzero exit. Retry later; a previously validated stage is reused.
No work is cancelled and no unbounded wait for activity is introduced. The daemon is stopped,
`current` is atomically replaced, and the new daemon starts **with admission closed**.
Only the expected version, exact protocol and required capabilities passing hello allows
admission to reopen. All runtime parts and shipped assets move together.

### Recovery and store compatibility

The operator-runtime integration uses **protocol 2.0** and **store epoch
`operator-journals-v4`**, replacing protocol 1.10 / `config-generations-v3`.
Upgrade clients and daemons together. Old hello capability schemas are closed, and
`revision.recorded` adds an event old event schemas cannot parse; these are not
backward-compatible wire additions. Optional operator, admission and revision methods
remain conditional on installed providers and caller authority, not new globally required
release capabilities.

The epoch check belongs to the **managed release updater**, which refuses activation and
recovery across different epochs. Direct CLI and daemon startup do **not** enforce
`release-compatibility.json`; successfully starting an old binary is not proof it can read
or safely write an upgraded store. Old full-schema event readers throw on a valid but
unknown event such as `revision.recorded`; filtered readers may bypass that event and
appear to work. Neither outcome is a supported downgrade or a compatibility guarantee.

Before the first upgraded writer runs, stop admission, finish active work, stop every
writer and take a complete, consistent pre-upgrade backup of both stores and all associated
state listed below. Retain the matching old binary and pinned toolchain and validate the
restore offline. The backup must include private/protected event payloads and all admission,
continuation and revision journals, not merely public event logs. Do not mix individual
files from old and upgraded stores. Rollback requires restoring that entire matching
backup before starting the old binary; writes made after the backup require separate
reconciliation and are not recovered by switching binaries. A direct in-place downgrade
of an upgraded store is unsupported.

`release-compatibility.json` carries the store epoch. Changing any writer so old binaries
cannot safely read its writes requires changing that epoch and a store changelog fragment.
Automatic activation across epochs is refused. Do not edit the marker to bypass the check.
A deliberate migration requires an idle, stopped deployment, a consistent backup of **both
stores**, plan journals, artifacts, permission sidecars and configs, and explicit migration
and restore validation. Never copy a live event store as a purported consistent backup.
Reverting binaries cannot undo incompatible writes. Restore the complete matching backup
before starting the old release; account for work performed since that backup separately.

During compatible activation, `activation.json` is fsynced before any service/pointer change.
Failed startup/hello restores the previous pointer, restarts it closed, validates its hello,
then reopens admission. If recovery also fails, the journal stays and launchers refuse work.
After diagnosing the service/environment failure, run:

```sh
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json recover
```

It rechecks compatibility and health; it does not delete stores or force-kill work. If
admission may previously have reopened, recovery first requires a successful prepare. If
that service is offline, repair/start the currently selected service (it will read the
persistent closed-admission file), then retry recovery. Do not
manually delete the journal to unblock launches. Retain the old checkout and its pinned
Node installation until recovery is no longer needed. The daemon also checks the durable admission file before every operation, so a supervisor
restart during activation cannot reopen admission. The journal is written before inspecting
activity. An uncertain prepare retains it for recovery; a known busy response removes it
without stopping the service. A manual downgrade after a completed upgrade needs a
separate maintenance/backup decision and is not accepted by `update`.

## Verification boundary

Automated tests exercise updater state/IPC, daemon admission, real flock contention, pointer
selection, failed activation/recovery, protocol/capability checks and store-epoch refusal.
A temporary-directory compiled-daemon exercise can run with
`ORCA_INTEGRATION_NODE=$(mise which node) python3 -B tools/deploy/test_integration.py` after
`pnpm run build`. It uses a subprocess supervisor in place of systemd and synthetic versions;
it does not prove a published-release fetch or the live service configuration.

Before deployment, run a real Windows installed N-to-N+1 cycle in a disposable profile:
check, download, exit without installation, relaunch, explicitly restart, verify N+1; also
test offline/401/corrupt download, wrong signature, drafts and an active bundled run. Use
both architectures and signed installers when signing is provisioned. Run a Debian
published N-to-N+1 upgrade and injected failed-start recovery against copied stores under
the actual chosen systemd unit. Neither live migration nor release publication is part of
the implementation session.
