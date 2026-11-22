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

Install the signed NSIS `.exe` for your architecture from a published final release: x64,
or arm64 from the first final that carries a natively accepted arm64 installer (#889). A
release candidate's unsigned installers are never the install. ZIP builds are
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
daemon is stopped before the installer launches. The installer runs silently, keeps the
per-user install where it is and starts the updated app; it asks nothing. An external daemon
is neither stopped nor installed by this path.

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

A token-bound preflight refusal before the workspace creates that token's update
reservation releases only that restart's draft hold and permits retry. It sends no
maintenance resume, stop or installer call and preserves parked-child, setup and connection
candidate guards. A prepare failure after reservation still requires exact-token recovery;
a wrong-token refusal or a refusal during stop/install cannot serve as no-claim proof.

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

The feed is private and served independently of the GitHub repository: a Cloudflare R2
bucket behind a small Worker ([`tools/deploy/feed-worker`](../tools/deploy/feed-worker/worker.js)).
Each tester gets their own random **read-only feed bearer token**, stored on their Windows
account in an ACL-protected text file. Give the account, Administrators and SYSTEM access only.
Do not use a GitHub token as this credential. Configure the environment inherited by ORCA:

```powershell
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_URL', 'https://updates.example.net/', 'User')
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_TOKEN_FILE', 'C:\Users\YOU\AppData\Local\ORCA\feed-token.txt', 'User')
```

Restart ORCA after changing environment variables. Rotating the token file takes effect at
the next check. URLs must be HTTPS and contain no credentials, query or fragment. Main
constructs `NsisUpdater` with Authorization headers (the
[documented custom updater configuration](https://www.electron.build/docs/features/auto-update/#custom-options-instantiating-updater-directly)); preload exposes only actions and
sanitized state. Nothing writes the token into installers, metadata, repository files or
renderer storage. The placeholder `updates.invalid` in packaging is deliberately unusable.
No credential prompt or hidden fallback to a public feed is provided.

What the Worker guarantees:

- **Every** request, including `.yml`, `.exe`, `.blockmap`, HEAD and Range requests, needs a
  known token, or gets 401. Only GET and HEAD are served.
- The `FEED_TOKENS` Worker secret holds each token's SHA-256 and its ring, never the token.
  Authorization is not logged (keep Workers observability off), responses carry
  `Cache-Control: no-store`, and nothing redirects to another origin.
- Single byte ranges are answered with 206. A multi-range request gets 416, and
  electron-updater then falls back from a differential to a full verified download.

This is a trusted distribution host: whoever can write the bucket can deliver code. The R2
token used by CI writes only the feed bucket and is never given to clients.

### Rings and controlled rollouts

The client always asks for `latest-ARCH.yml`; which version that resolves to depends on the
**ring** its token belongs to:

| Ring | Meant for | Offered |
| --- | --- | --- |
| `internal` | Maintainers | Each version `feed-publish.yml` uploads |
| `preview` | Testers | What `Desktop feed (promote)` moves there, prereleases included |
| `stable` | Everyone else | What `Desktop feed (promote)` moves there, never a prerelease |

**Release candidates need a client opt-in.** The Windows client ignores any version with a
prerelease suffix (`0.7.1-rc.1`) unless `ORCA_UPDATE_PRERELEASE` is exactly `1` in its
environment. Set it, with the token, for internal and preview testers only:

```powershell
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_PRERELEASE', '1', 'User')
```

So a preview tester is offered the rc their ring names; a stable install is never offered an
rc (the stable ring cannot hold one, and the client would ignore it); and no install is ever
offered an older version than it runs, in either direction (`0.7.1` ignores `0.7.1-rc.1`, an
rc install ignores the older stable). A preview-ring install without the opt-in waits until a
stable version reaches its ring. An rc tester who leaves the program removes the variable and
moves to a stable token; they get the next stable version newer than their rc.

`rings.json` in the bucket names each ring's version and, optionally, a **rollout**: a newer
version offered to a percentage of that ring's tokens. A token's place in a rollout comes
from a hash of the token and the rollout version, so it is stable between checks and raising
the percentage only adds people. Named subsets are rings: mint the people you want first with
an `internal` or `preview` token.

Rings are **targeting, not access control.** They decide which version a token is offered.
Any valid token can still download any installer or blockmap the bucket holds by its file name;
that keeps old blockmaps reachable for differential downloads, and the same versions are
already public on GitHub releases. If a build must not reach some testers at all, do not put
it in the feed; separate buckets and Workers per audience would be the way to enforce that.

Promote with the **Desktop feed (promote)** workflow (`feed-promote.yml`): pick a ring, a
version the feed holds and a percentage. 100 offers it to the whole ring, 1–99 starts or changes
a rollout, and 0 halts the rollout of that version. A ring cannot be given a version older than
its full version or its active rollout; the same rollout version can be widened or completed.
Like publication, it only runs when dispatched from main, in the protected `desktop-feed`
environment (see the setup below).

Rings never move backwards, and halting is not a rollback. The client disallows downgrades,
so anyone who already took a bad build keeps it until a newer fixed version ships; halting
only stops more people from getting it. Keep early rollouts small for that reason.

### Pulling a bad build

Rings never move backwards, so a bad build is never "rolled back": it is contained, then
replaced by a newer fixed version (adopted from T3 Code's bad-nightly runbook, #863). What
containing it can do depends on how far it got, so find out first.

1. **Pause the feed.** Set the repository variable `ORCA_FEED_PAUSE` to `true` (Settings →
   Secrets and variables → Actions → Variables). From then on **Desktop feed (publish
   signed)** refuses to start and **Desktop feed (promote)** refuses everything except a
   halt. The pause is checked when a job starts: it does **not** stop a job that already
   passed that check.
2. **Check for jobs already running.** In the Actions tab, look for in-progress or queued
   runs of both feed workflows (they share one concurrency group, so at most one runs and
   the rest queue). Cancel any you did not mean to happen, and let a running one finish or
   cancel it before you read the ring state: a promotion that completes after you looked
   changes the answer.
3. **Read the authoritative ring state.** Open `rings.json` in the bucket (Cloudflare
   dashboard → R2 → the feed bucket → `rings.json`). It is the only record of each ring's
   **full** version and any active **rollout** with its percentage; decide on a halt from
   it alone. The watchdog can corroborate what a client is offered, but each canary token
   sits in one rollout bucket, so it can miss an active rollout and cannot tell a fully
   promoted version from a partial offer.
4. **Halt what is still a rollout.** For each ring where the bad version is an active
   partial rollout, dispatch **Desktop feed (promote)** with that ring, the bad version and
   percent `0`. That stops offering it to the rest of the ring. A halt does nothing for a
   ring whose full version is already the bad one: there is no older version to offer
   instead, and every install in that ring that checks for updates is still offered it.
5. **Contain a fully promoted bad build by shipping past it.** Release the fix as a newer
   version (a patch, or the next rc), sign it, unpause (set `ORCA_FEED_PAUSE` to anything
   but `true`, or delete it), publish it to `internal` and check it there, then promote it
   in every ring that has the bad version, starting with a small rollout. Until then, tell
   that ring's testers not to update.
6. **Say what affected people see.** An install that already updated, or already
   downloaded the bad version and is waiting to restart into it, keeps it: the client
   refuses downgrades and the feed cannot take a download back. An install that was offered
   the bad version before the halt can still hold that offer and download it, because the
   versioned installer stays in the bucket for differential downloads; a halt only changes
   what the next check returns. An install that never saw the offer is safe only while its
   ring no longer offers the bad version (its rollout was halted and it was outside it);
   while a ring's full version is the bad one, its next check offers it. If the bad version
   cannot start, those people need the Windows failed-update recovery above, or a reinstall
   of the last good release from GitHub.

Leave the bad version's snapshot in the bucket: deleting it would break differential
downloads for anyone upgrading from it.

### Feed watchdog

**Desktop feed (watchdog)** (`feed-watchdog.yml`) checks the live feed once a day as a client
sees it. For each ring with a canary token it fetches every channel file and fails when:
a request without a token is not refused; an architecture the Worker does not serve answers;
a ring is offered a version with no published GitHub release, `stable` a prerelease, or any
ring a prerelease other than `-rc.N`; the channel file's `files[]` entry (what the installed
updater reads) does not name exactly that architecture's installer or disagrees with the
legacy `path` and `sha512`; or the installer the feed serves does not have that entry's size
and sha512, or differs from the published release asset. It holds no bucket credential and
cannot read `rings.json`, so it checks what each ring is offered, not what it should be
offered; compare its summary with the last promotion.

To turn it on:

1. Create a GitHub environment named `feed-canary` with deployment branches limited to
   `main`. It holds only the canary tokens; never put the R2 write credential in it.
2. Mint one canary token per ring you want checked with
   `node tools/deploy/feed-token.js RING`, and add their `FEED_TOKENS` entries to the Worker
   secret like any tester's.
3. Store the tokens as the **environment** secret `ORCA_FEED_CANARY_TOKENS` in
   `feed-canary` (not a repository secret), a JSON object such as
   `{"internal": "…", "preview": "…", "stable": "…"}`.
4. Set the repository variable `ORCA_FEED_URL` to the feed's https origin. Until it is set
   the workflow is skipped. It runs only from main, so a dispatch from another branch never
   reads the tokens.

A canary token is an ordinary read token: revoke it the same way.

### Release/feed provisioning

`desktop.yml` builds Windows architectures separately, with distinct installer names and
`latest-x64.yml` / `latest-arm64.yml`. Prereleases instead carry `prerelease-*.yml`; the
Worker serves either under the `latest-ARCH.yml` name the client requests. Clients disallow
downgrades. Linux and macOS build targets are preserved; their automatic updating is outside
this iteration.

All packaging uses `--publish never`. The publication job waits for the existing checks,
smoke/type proof and platform builds, flattens assets with collision checks, and checks both
metadata versions, SHA-512 checksums and blockmap presence. A prerelease is uploaded to a
draft and then made visible with every build attached. A final (`X.Y.Z`) stops at a draft
with only the Ubuntu amd64 `.deb`: no tag, nothing latest, no feed write
([RELEASING.md, "Publishing a final"](RELEASING.md#publishing-a-final)).

The feed never takes the ordinary release-job builds: their Windows installers are unsigned.
For a final the order is:

1. Staging the draft dispatches **Windows signed (spike)** for the draft's pinned merge
   commit, **before** publication (automatic while `ORCA_RELEASE_AUTO_SIGN` is `true`).
2. **Release (attach signed installer)** attaches that run's signed x64 and arm64
   installers to the draft and records the run (automatic under the same switch, otherwise
   dispatched with the run id). Native acceptance runs on the exact draft assets (arm64's
   automatically, in **Release (accept Windows arm64)**), and only then is the draft
   published (which creates the tag). RELEASING.md has the steps and checks.
3. **Architecture gate.** Rings select versions, not architectures, so each version's
   snapshot carries its own architectures. `feed-publish.yml` always serves x64 and serves
   arm64 only for a final whose published arm64 installer has verified native acceptance:
   its notes point at a successful **Release (accept Windows arm64)** run on `main` whose
   evidence artifact names that release, commit, installer digest and upgrade baseline
   (`tools/deploy/feed-arches.js`, #889). The baseline is the newest earlier published final
   with an arm64 installer that is not marked x64-only, and it must itself carry a verified
   acceptance (records for its installer and a successful acceptance run on `main` whose
   record job, named as the receipt for that release, commit and installer digest, passed); a
   baseline without that proof fails the check instead of counting as a fresh install. A
   snapshot first written before #889 keeps its record when a publish is retried, and is
   never extended to arm64. An attached arm64 installer that is not declined
   (`<!-- orca-x64-only -->`) and does not verify fails the feed run instead of feeding x64
   alone. `feed-r2.sh` lists the published architectures in the snapshot's write-once
   `complete.json`, and the Worker serves a version's channel files, installers and
   blockmaps only for the architectures listed there; a record without the list (every
   version fed before #889, v0.7.0 included) serves x64 only. `SERVED_ARCHES` in
   `tools/deploy/feed-worker/worker.js` equals `FEED_ARCHES` and bounds both: any other
   architecture answers 404. Changing either list is a reviewed change to both, then a
   Worker deploy; do not rely on ring assignment to scope architecture. **Desktop feed
   (update test)** updates an installed N to N+1 through the Worker's own handler on both
   x64 and a native arm64 runner for every change to the feed or the updater.
4. **Desktop feed (automatic)** (`feed-auto.yml`, on while `ORCA_FEED_AUTO` is `true`)
   dispatches **Desktop feed (publish signed)** (`feed-publish.yml`) from main when the
   release is published, with the signing run that **Release (attach signed installer)**
   recorded in the draft's notes, and only if the published installer's digest still equals
   the recorded one. A daily run retries every release published in the last 7 days. To feed
   by hand (a version without that record, such as v0.7.0), dispatch `feed-publish.yml` from
   main with the version and the id of **that same** signing run. Before dispatching, confirm the run's x64
   installer SHA-256 equals the accepted installer's; the job also refuses any served
   installer whose SHA-256 differs from the published release's asset digest.

`tools/deploy/feed-source.js` refuses a version without a published, non-draft GitHub
release for its tag (a tag alone is not enough) and accepts only a successful
`windows-signed.yml` run from main. The job then downloads only the artifact named for the
tagged commit, re-checks each installer's Authenticode signature, timestamp and publisher
(`ORCA_FEED_PUBLISHER_CN`), checks that each channel file names exactly one installer whose
`files[]` entry (what the updater reads) and legacy `path` / `sha512` both match that
installer's name, size and SHA-512, with its blockmap present (`release-assets.py`, which
parses the builder's metadata strictly and refuses anything else), and runs
`tools/deploy/feed-r2.sh snapshot`. Signed artifacts are kept 7 days, so publish and feed
within a week of signing.

`feed-r2.sh snapshot` uploads installers and blockmaps to `VERSION/`, then the two metadata
files, then `VERSION/complete.json`, each written only if absent. An object that already exists must hold identical bytes,
so a rerun after an interruption at any stage resumes and nothing published is ever replaced.
A lookup or write error other than "absent" stops the run. It then offers the version to
`internal`. A version older than anything `internal` already offers, its rollout included (a
hotfix behind an rc), is stored but not offered; promote it explicitly. The Worker serves
nothing of a version, metadata or payload, until its `complete.json` exists, so a partial
snapshot is never visible; completed older snapshots stay readable for differential downloads.

One-time setup (Casey):

1. In Cloudflare, create a private R2 bucket (no public `r2.dev` access) and an R2 API token
   with Object Read & Write on that bucket only.
2. Copy `tools/deploy/feed-worker/wrangler.toml.example` to `wrangler.toml` (ignored by Git),
   set the bucket and your custom domain, and run `npx wrangler deploy` in that directory.
   Deploy the Worker from current main before the first feed run, and again whenever
   `worker.js` changes: an older deployment may serve architectures the feed does not.
3. Mint a token per person with `node tools/deploy/feed-token.js RING`. Give each person their
   token; merge the printed entries into one JSON object and store it with
   `npx wrangler secret put FEED_TOKENS`. Revoke a person by removing their entry.
4. Create the `desktop-feed` environment (Settings → Environments) and under deployment
   branches allow only `main`. No required reviewers (the owner's decision, 2026-11-21): feeding is automatic, and every run
   re-checks the release, the signing run, signatures, metadata and installer digests before
   writing. Store `ORCA_FEED_ACCESS_KEY_ID` and `ORCA_FEED_SECRET_ACCESS_KEY` from the R2 token
   as **environment** secrets there, not repository secrets, so only a run from main can
   write the bucket. Both feed workflows also refuse to run from any other ref.
5. Set repository variables `ORCA_RELEASE_AUTO_SIGN` (`true` to sign and attach finals
   automatically, RELEASING.md), `ORCA_FEED_AUTO` (`true` to feed published finals automatically),
   `ORCA_FEED_ACCOUNT_ID` (the Cloudflare account id),
   `ORCA_FEED_BUCKET` and `ORCA_FEED_PUBLISHER_CN` (the exact signing certificate CN, as in
   `WINDOWS_SIGNING_PUBLISHER_CN`). Until `ORCA_FEED_BUCKET` is set, neither feed workflow
   does anything.
6. Nothing to do by hand for conditional writes: every feed write job first runs
   `feed-r2.sh probe`, which writes a throwaway `ci-probe/` key (never served) with
   `If-None-Match` and `If-Match` conditions that must hold or be refused, deletes it, and
   stops the job before any real write if R2 does not honour them.
7. Before giving testers tokens, run the packaged acceptance on real Windows with signed
   builds from the feed: an opted-in preview install on stable `N` is offered and installs
   rc `N+1-rc.x`; a stable install on `N` is not offered it; neither is offered an older
   version afterwards. `tools/test/feed-client.test.js` checks the same policy with the real
   updater library against the Worker, but substitutes Electron's network stack and
   installation, so it is not that acceptance.

A feed failure leaves the GitHub release in place and the rings unchanged. Rerun **Desktop
feed (publish signed)** with the same inputs. A fresh signing run of the same commit is
**not** a drop-in retry for an accepted final: its bytes differ from the installer that was
accepted and published, so it must not be fed for that version (and `feed-r2.sh` refuses it
once any object of the first attempt exists). If the accepted run's artifact has expired,
stop and decide deliberately; do not substitute new bytes. Do not rerun release creation for
an already published tag.

Windows signing is provisioned through `windows-signed.yml` (Azure Artifact Signing over
OIDC; see the [Windows signing runbook](windows-signing-runbook.md)). The supported Windows
installer for a final is the signed one; the unsigned installers are ordinary CI build
output only and are never the release download or a feed payload. A valid signature
authenticates the publisher but does not guarantee SmartScreen reputation or bypass
enterprise policy. Do not weaken signature validation to get a test green. HTTPS/checksums
protect distribution but do not substitute for publisher identity.

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

Prerequisites for a **source** stage: Linux, Python 3.8+, util-linux/procfs, Git,
authenticated GitHub CLI, mise, and the **actual operator's** service account. A **bundle**
stage ([Prebuilt server bundle](#prebuilt-server-bundle)) needs only Linux x64, Python 3.8+,
util-linux/procfs and HTTPS to github.com and Sigstore. GitHub authentication stays in `gh`'s local
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

### Prebuilt server bundle

From the 0.8 release line (0.8.0's release candidates on), every release also publishes a
signed prebuilt server, `orca-server-X.Y.Z-linux-x64.tar.xz`, beside its manifest and signature
([RELEASING.md](RELEASING.md#the-server-bundle)). Staging from it needs no toolchain, clone or
GitHub CLI:

```sh
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json stage --bundle v0.8.0
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json update --bundle v0.8.0
```

`update --bundle` stages (or reuses an already validated `releases/v0.8.0`) and then activates
through exactly the path above. `--bundle` also takes a directory holding the three files, for a
server without direct access to github.com. A release candidate (`v0.8.0-rc.1`) is accepted by
its full version and sorts before its release; dry runs are never signed and never accepted.

**When a release's bundle is ready.** A final is published only once its bundle is attached
and recorded, so a published final always has one. A release candidate is published first
and gets its bundle from a separate run shortly after (normally within half an hour; a
reconcile retries every 6 hours). The bundle is ready when the release notes carry one
`<!-- orca-server-run: RUN … -->` record whose three digests match the attached files;
`stage --bundle vX.Y.Z-rc.N` checks exactly that before downloading and says
"no complete server bundle yet; retry later" until then.

Before reading a byte of the archive, staging:

1. (by version) requires that single record and downloads only assets whose digests match it;
2. fetches cosign `v3.1.4` once into `tools/` under the deployment root and checks it against
   the SHA-256 pinned in the adapter, on every use (nothing on `PATH` is trusted);
3. runs `cosign verify-blob` on the manifest, requiring a certificate for
   `release-server-bundle.yml` on `refs/heads/main` of `cschadewitz/Project_Orca`, issuer
   `https://token.actions.githubusercontent.com`, trigger `workflow_dispatch`, and a
   transparency-log entry (Sigstore's trust root is cached in `tools/sigstore`);
4. checks the manifest's schema, name, version, platform, and the archive's exact size and
   SHA-256.

A tampered archive, another signer, or a manifest for another version stops here, with an
empty `.staging-*` directory left for inspection. Only then is the archive unpacked, by hand:
regular files and directories under the one expected root, nothing else, bounded in size. The
release records its own `runtime/bin/node` and `orca-daemon.mjs` relative to itself
(`.orca-release.json` `"source": "bundle"`; only exactly these two paths are ever run for a
bundle release, whatever a manifest or record says), and the same compiled-version, demo, config
validation and temporary-daemon hello checks as a source stage run before the rename into
`releases/vX.Y.Z`. Source-built and bundle-built releases activate and roll back into each
other; the store-epoch rule is unchanged.

A bundle release's daemon command line is `runtime/bin/node …/orca-daemon.mjs`, so the
activation check that the service runs the selected release follows the recorded entry rather
than `packages/cli/dist/main.js`. Install the updated adapter (step 2 of the bootstrap) before
the first bundle update.

### Updating a server from the app

A server the adapter launched can also be updated from the desktop app, over the same SSH
profile the app connects with ([daemon connections](daemon-connection.md#ssh-connection-profiles-874)).
When the adapter starts the daemon it passes its own path, the deployment manifest and the
manifest's ring (`ORCA_DEPLOYMENT_ADAPTER`, `ORCA_DEPLOYMENT_MANIFEST`, `ORCA_DEPLOYMENT_RING`,
set for the daemon only), and the daemon reports them in `hello.deployment` to a caller holding
`config.read`. A daemon started any other way reports nothing and the app offers no update.

What the daemon reports is a hint, never what the app runs:

- **You enter the updater's paths.** The first time, the connection dialog shows what the
  server reports and asks you to type the updater's path (it must be an `orca-release.py`)
  and the manifest's path (a `.json` file), shows the exact command, and runs nothing until
  you approve. The app accepts the approval only when what you typed matches what the server
  reports.
- **The approval is for that server.** It is saved beside the profile
  (`server-updaters.json`) with the host key the profile's tunnel authenticated and the
  daemon's workspace identity, and applies only while both are the same. Pointing the profile
  at another server or daemon port, forgetting its host key or removing it drops the approval.
- **A mismatch is refused.** The app runs only the approved paths, and only while the daemon
  still reports exactly those. If it reports another location, the dialog asks again.
- **One preview, checked again.** Everything the dialog shows and you confirm (profile,
  connection, host key, workspace, the server's version and the target version) comes from
  one look the app took. Approving and updating name that look, and the app refuses if the
  connection no longer matches it.
- **Only forward, only the app's release.** The target is the app's own version, it must be
  a release, and the server must be running an older one; the app checks this itself, not
  only the dialog.

The connection dialog shows the server's version, protocol, ring and host key, and whether it
is older than the app. **Update now** runs, over the profile's own ssh (the pinned host key, the
profile's key, no forwards, no ssh config):

```sh
python3 <adapter> --deployment <manifest> update --bundle v<app version>
```

That is the command above, so the server's rules decide: the bundle's signer and digests,
forward-only versions, the update lock and the admission barrier. Nothing installs through the
daemon's RPC. The app streams what the updater prints and then says how it ended:

- **Updated**: the updater succeeded *and* a fresh authenticated hello from the same server
  (same profile, host key and workspace, checked again once the hello answers) reports the
  new version.
- **Unknown**: the SSH session was lost after the updater could have started, or it reported
  success and the server has not confirmed the new version within about a minute. The app
  says what the server last reported, if anything; check the server before trying again.
- **Work is running**: the barrier refused (`Daemon busy`, `Busy: admission.lock`, or an
  unmanaged ORCA process); nothing was cancelled and the old release keeps serving.
- **Another update is running**: `Busy: update.lock`, held by the scheduled updater or another
  operator; this one did not start.
- **Failed**: the updater's own `orca-release:` message, and whether the previous release was
  restored and healthy.
- **SSH refused before it started**: a missing ssh client, a changed or missing host key, or a
  refused key, so nothing ran; the app's own message, never ssh's output.

A development build of the app (a version that is not a release tag) offers no update.

### Recovery and store compatibility

The operator-runtime integration uses **protocol 2.0** and **store epoch
`operator-journals-v4`**, replacing protocol 1.10 / `config-generations-v3`.
Upgrade clients and daemons together. Old hello capability schemas are closed, and
`revision.recorded` adds an event old event schemas cannot parse; these are not
backward-compatible wire additions. Optional operator, admission and revision methods
remain conditional on installed providers and caller authority, not new globally required
release capabilities.

The epoch check belongs to the **managed release updater**, which refuses activation and
recovery across different epochs. Direct CLI and daemon startup do **not** read
`release-compatibility.json`; from 0.7.1 they enforce the store's own format marker instead
(see [Store format carryover](#store-format-carryover) below). Builds before 0.7.1 ignore that
marker, so successfully starting an old binary is still not proof it can read or safely write
an upgraded store. Old full-schema event readers throw on a valid but
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

### Protocol compatibility window

From protocol 2.1 (#880) a desktop and a daemon one protocol **major** apart can still
connect, so an app that updates first does not lose its servers.

- `hello` negotiates. A client sends its own protocol and, while its build has a window
  open, a `fallback`: the last minor of the previous major it still speaks. The daemon
  answers in the highest protocol both sides share and says which in `hello.protocol`.
- A daemon on major N accepts N and N-1 clients for **one release**. A client on N-2, or an
  N-1 client newer in minor than the daemon's N-1, is refused with a protocol message that
  names what the daemon accepts.
- An app on N connected to a daemon on N-1 reads and writes. Everything N added is off,
  because that daemon does not advertise it, and the connection bar says the daemon is one
  major version behind. A daemon outside the window is a version mismatch as before.
- The window is the `PREVIOUS_PROTOCOL` constant in `@orca/protocol`. The release that
  bumps the major sets it to the final N-1.x; the next major replaces it, so N-1 leaves.
- **Within a major, an updated desktop keeps working with older daemons.** Clients offer
  the oldest minor they need (`CLIENT_PROTOCOL`, 2.0 today), not their own, so a 2.1
  desktop still connects to shipped 2.0 daemons. Only the daemon reads `fallback`.
- **2.x opens no window.** 2.0 was cut before the window existed, and 1.10 peers read 2.x
  with closed schemas, so 1.10 stays refused. 2.1 is the first daemon that understands a
  `fallback`, which is what lets the first 3.0 app talk to it.
- The window stays disabled until the major that opens it verifies its previous-major
  wire projection: capabilities, methods and events, not only the version negotiation.
- The window never covers store epochs. A store migration still needs the matching daemon;
  see [Recovery and store compatibility](#recovery-and-store-compatibility).

**Promotion order across a major: servers first.** Move daemons to N while desktops are
still on N-1 (the N daemon accepts them), then promote the N desktop. Desktops that update
early still reach N-1 daemons inside the window. Finish moving every daemon to N before the
next major, when N-1 leaves the window.

### Store format carryover

From 0.7.1 every store records the format (store epoch) and the ORCA version that last wrote
it in `store-format.json` at the top of the store. Every command that opens the store, the
desktop app's bundled daemon included, checks it first (#566). Ordinary startup never
converts a store:

| The store was written in | What ordinary startup does |
| --- | --- |
| Its own format | Opens it in place. Updates that keep the format, such as 0.7.0 to 0.7.1, need nothing else. |
| `operator-journals-v4`, before the marker existed, with intact evidence a released 0.7 build wrote it: `.workspace-identified` holding `1`, a valid `workspace-identity/id` and a 32-byte `private-execution/.execution-key`, none of them linked or foreign-owned. The 0.7 desktop app's daemon and `submit` write all three; 0.6 and earlier wrote none | Stamps the marker and opens it in place. No conversion, no backup, no other byte changed. |
| The previous release's format, or any other unmarked store (incomplete or missing evidence included) | Refuses (`CARRYOVER_REQUIRED`) and changes nothing. Run `orca store carry-forward` once, below. |
| An older format than that | Refuses, naming the release line to open it with first. |
| A format it does not know (a newer ORCA) | Refuses for reads and writes alike and changes nothing. The message names the version that wrote it and, when there is one, the backup that version made. |
| A damaged marker | Refuses until the marker is restored or repaired with ORCA stopped. |

`orca store format` prints the recorded format and what startup would do.

**`orca store carry-forward`** is the explicit, offline conversion. Stop every ORCA app,
daemon and command using the workspace first. Writers from before 0.7.1 take no lock the
command can see, so it also checks for itself, and refuses with the prior format still in
charge if any step fails:

1. No run lease in the store is live, and the leases can be read. Otherwise it refuses (`BUSY`).
   A store that holds links is refused (`UNREADABLE`): the backup must be self-contained and
   the read check isolated.
2. The whole store is copied into a private staging folder under `format-backups/`, and every
   copied file is compared byte for byte with the original.
3. The store's complete file listing (path, type, size, modification time, inode) must be
   unchanged from before the copy to after it. Otherwise another process wrote meanwhile:
   the copy is discarded and the command refuses (`BUSY`).
4. A second, throwaway copy is opened with this build's own readers: every run log, the
   request, work-item, artifact, lease and plan collections and every plan journal. If any of
   them fails to read, nothing changes (`UNREADABLE`). The staged backup must be unchanged
   afterwards, so the readers' own writes stay in the throwaway copy.
5. Just before the marker is written, the listing is checked once more. Then the staged copy
   is published as `format-backups/<time>-from-<format>/` with a `format-backup.json`
   manifest, and only then is the marker stamped.

Retention removes only backups the command made (named as above, with a valid manifest),
keeping the newest two and always the one the marker names, plus the scratch folders of an
interrupted run. Anything else in `format-backups/` is left alone. The folder must be a
private directory owned by the user running ORCA (`BACKUPS_UNSAFE` otherwise).

`carry-forward` is not available on Windows yet (`BACKUPS_UNSAFE`): the copies hold the
execution key and private records, and ORCA cannot yet verify that a destination's ACL keeps
them at least as private as the originals. That, with automatic desktop carryover, is #897.
Marker adoption of 0.7 stores, which copies nothing, works on Windows as everywhere else.

The supported window is this release's format and the one before it, so a store carries
forward across one format change at a time. Closed update validation (`serve --read-only
--no-resume` under an update fence) only checks; it never writes the marker. `validate` does
not open the store and is unaffected. Automatic carryover on the desktop update path, with
proof that the updater owns the store and holds its write fence, is tracked separately and
must land before the next store format change.

The backup covers the store directory only: not the config file, the permission sidecar or
`auth/` beside the config. Agents cannot read `format-backups/`, which holds copies of the
store's private directories. To go back to the older release after a carryover, stop ORCA,
move the store aside, copy the backup back in its place, and start the older release. Work
done after the backup is not in it.

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
