# Updating ORCA

This page is for people who install, update or operate ORCA: Windows and Linux desktop users,
the maintainers who run the update feed, and operators of managed Debian servers. It explains how
each kind of install updates, how to run and stop the feed, how to update a server, and what
happens to a store across versions.

Rules that hold everywhere:

- **Updates never interrupt work.** A busy app or server defers; nothing is cancelled or killed.
- **Desktop and server installs are independent.** Updating the app never installs anything on an
  attached server.
- **The daemon's RPC never installs anything.** The `maintenance` method only closes or reopens
  admission; it takes no URL, path, command or package name.

<!-- rename-keep-start: this section is about the names before the rename -->
## Renaming from ORCA

From 0.9.0 the product is **Orrery**. The rename keeps your data and settings. For one release
(0.9.x) Orrery also reads the old names; 0.10.0 stops reading them.

| Old name | New name | In 0.9.x |
| --- | --- | --- |
| `ORCA_*` environment variables | `ORRERY_*` | Read when the new name is unset, with a warning on stderr. The new name wins when both are set. |
| `.orca/` store directory | `.orrery/` | Moved once, automatically, the first time Orrery opens the store (below). |
| `orca.config.yaml` (`.yml`, `.json`) | `orrery.config.yaml` | Read when no new-name file exists, with a warning. Orrery writes only the new name. |
| `orca.permissions.json` sidecar | `orrery.permissions.json` | Read when no new-name file exists. New grants are written to the new name. |
| `type: orca-daemon` agents | `type: orrery-daemon` | Accepted and treated as the new type. |
| `orca://` links | `orrery://` | Still open the app. |
| `orca` command | `orrery` | **No alias.** Update scripts, wrappers, systemd units and ACP client settings (`orca acp` becomes `orrery acp`). |

**What migrates automatically:**

1. **The store directory.** When only `.orca/` exists beside the config, Orrery moves it to
   `.orrery/` under the store's format lock, while no writer is registered. It leaves a symlink
   at `.orca` on Linux and macOS, and a small marker file on Windows, so an older binary does
   not start an empty store. If the move fails, the old directory is left as it was and opened
   in place. A `storeDir` your config names explicitly is never moved.
2. **Environment variables**, each time a process starts. Change them to the new names before
   0.10.0.
3. **Desktop installs.** The Windows app updates in place: it keeps its installer identity
   (`dev.orca.desktop`), so shortcuts and the update path continue. The Linux package is now
   `orrery-desktop` and replaces `orca-desktop` on upgrade.

**What you change by hand:** config file names (optional until 0.10.0), environment variable
names, anything that runs the `orca` command, and bookmarks to the old documentation site.
<!-- rename-keep-end -->

## Windows desktop

Install the signed NSIS `.exe` for your architecture from a published final release: x64, or
arm64 from the first final with a natively accepted arm64 installer (#889).

- A release candidate's unsigned installers are never the install. ZIP builds are archives, not
  an update path.
- A desktop older than v0.6.0 has no update control; install v0.6.0 or later by hand once.
- Keep a known-good installer for recovery.
- The Windows app keeps `dev.orca.desktop` as its packaging id so NSIS upgrades and shortcuts
  continue. The macOS bundle id is set in `packages/app/electron-builder.yml`; see
  [application identity](RELEASING.md#approved-application-identity-and-existing-installations).

The header and command palette offer **Check for updates**, **Download VERSION** and **Restart to
update to VERSION**. The percentage is installer bytes, not run progress. Failed checks and
downloads can be retried. Network and credential details never reach the renderer.

### What restart does

1. Interaction freezes. Every window must confirm its configuration, permission and answer
   drafts are clear. Save, send or discard drafts and retry. A missing or unresponsive window
   blocks the restart.
2. The main process asks its **owned** daemon to close admission atomically. Any in-flight
   request, including a running agent operation, blocks the attempt. Parked gates have returned
   their leases and survive.
3. The owned daemon is stopped, then the installer runs silently, keeps the per-user install in
   place and starts the updated app.

An external daemon is never stopped or updated by this path.

### Automatic desktop updates

From 0.8.0 the Windows app updates itself unless you turn it off (#566). Like
[automatic server updates](#automatic-server-updates), it never stops, cancels or waits on work.

| Step | Behaviour |
| --- | --- |
| Check and download | Two minutes after start, then every four hours, in the background. |
| Install when idle | After 15 minutes without keyboard or mouse input, at most every five minutes. `ORCA_UPDATE_IDLE_SECONDS` can raise the 15 minutes, never lower them (only the Windows update test's loopback feed may). Uses the restart above, plus: the bundled daemon's runtime idle proof (`maintenance.runtime`) must close admission. It refuses while any request, run, callback, renewal, dispatch, continuation or recovery is active. Just before the stop the app checks again; if input returned, updates were turned off or the app began to quit, it releases admission and drafts and stops nothing. |
| Install on close | Closing the last window with a ready download tries the same install, without restarting the app. Once per app run. Refused, the window closes as usual. |
| Overdue | After three days waiting for idle, **Restart to update** becomes a highlighted "waiting 3 days" button. It still kills nothing. |
| Off switch | The palette's **Turn off automatic updates** / **Turn on** saves `updates.automatic` in the app's preferences. Off, every step is manual. |
| Failures | An unknown installer outcome follows the contract below; no further automatic attempt that run. |

### Windows failed-update recovery contract (#660, C5a-02)

An installer timeout or ambiguous error is treated as **unknown**: admission stays paused, and the
app reconnects automatically only when installation is known not to have started and the old
child has exited.

| Installer observation | Recovery |
| --- | --- |
| Positively not launched | A failure before invoking the installer, or the driver's explicit non-launch result, allows an exact-token abort. A stopped first-run child must have been seen to exit, and its ownership must settle before saved-receipt recovery. |
| Positively launched | Admission and draft guards stay closed while waiting for exit. Launch alone does not prove replacement. |
| Timeout after `quitAndInstall` | Unknown. Admission stays closed; the attempt and ownership evidence are kept. No abort, no reconnect. |
| Error or throw after invocation | Unknown, same as timeout. An updater error event does not prove non-launch. |

- The Windows driver has no native launch acknowledgement. Its timeout, throw and error event all
  report unknown. A successful install normally exits the process.
- A token-bound preflight refusal **before** the update reservation exists releases only that
  restart's draft hold and allows retry. It sends no resume, stop or installer call. A failure
  after reservation still needs exact-token recovery. A wrong-token refusal, or a refusal during
  stop or install, is not proof nothing was claimed.
- The update keeps the exact old child and first-run reservation. A late exit callback or app
  close cannot settle that reservation while the outcome is unknown. A proven non-launch abort
  appends exact-child terminal evidence; it does not delete the journal or allow a generic
  reconnect.
- Recovery checks the saved selection, configuration and assets, authentication, writable
  capabilities, PID, store, workspace identity and operator discovery through `FirstRunSetup`.
  Only the captured workspace may request a new candidate. Old tokens, changed targets and late
  or duplicate recovery calls cannot start another writer.
- A missing or changed receipt, uncertain child or cleanup, altered ownership evidence, failed
  resume, or unavailable recovery leaves the update blocked and reports failure. A legacy or
  file-mode child without this receipt path does not fall back to generic reconnect. Keep the
  workspace and journal for review; a retry is not evidence installation never began.

## The update feed

### Private feed and authentication

The feed is a private Cloudflare R2 bucket behind a small Worker
([`tools/deploy/feed-worker`](../tools/deploy/feed-worker/worker.js)), separate from GitHub.

Each tester gets their own random **read-only feed token**, stored in an ACL-protected text file
readable only by their account, Administrators and SYSTEM. Never use a GitHub token. Set the
environment ORCA inherits:

```powershell
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_URL', 'https://updates.example.net/', 'User')
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_TOKEN_FILE', 'C:\Users\YOU\AppData\Local\ORCA\feed-token.txt', 'User')
```

- Restart ORCA after changing environment variables. A rotated token file is used at the next
  check.
- URLs must be HTTPS, with no credentials, query or fragment.
- The main process builds `NsisUpdater` with Authorization headers
  ([custom updater configuration](https://www.electron.build/docs/features/auto-update/#custom-options-instantiating-updater-directly)).
  Preload exposes only actions and sanitized state.
- The token is never written to installers, metadata, the repository or renderer storage. The
  packaged placeholder `updates.invalid` is deliberately unusable. There is no credential prompt
  and no fallback to a public feed.

The Worker guarantees:

- **Every** request (`.yml`, `.exe`, `.blockmap`, HEAD, Range) needs a known token or gets 401.
  Only GET and HEAD are served.
- The `FEED_TOKENS` Worker secret holds each token's SHA-256 and ring, never the token.
  Authorization is not logged (keep Workers observability off). Responses carry
  `Cache-Control: no-store`. Nothing redirects off-origin.
- A single byte range gets 206. A multi-range request gets 416, and electron-updater falls back
  to a full verified download.

Whoever can write the bucket can deliver code. The CI R2 token writes only the feed bucket and is
never given to clients.

### Rings and controlled rollouts

The client always asks for `latest-ARCH.yml`. What that resolves to depends on its token's
**ring**:

| Ring | For | Offered |
| --- | --- | --- |
| `internal` | Maintainers | Each version `feed-publish.yml` uploads |
| `preview` | Testers | What **Desktop feed (promote)** moves there, prereleases included |
| `stable` | Everyone else | What **Desktop feed (promote)** moves there, never a prerelease |

**Release candidates need an opt-in.** The client ignores any prerelease version (`0.7.1-rc.1`)
unless `ORCA_UPDATE_PRERELEASE` is exactly `1`. Set it, with the token, for internal and preview
testers only:

```powershell
[Environment]::SetEnvironmentVariable('ORCA_UPDATE_PRERELEASE', '1', 'User')
```

- A stable install is never offered an rc.
- No install is offered a version older than it runs (`0.7.1` ignores `0.7.1-rc.1`; an rc install
  ignores the older stable).
- A preview install without the opt-in waits for a stable version in its ring.
- An rc tester who leaves removes the variable and moves to a stable token, and gets the next
  stable version newer than their rc.

`rings.json` in the bucket names each ring's version and optionally a **rollout**: a newer version
for a percentage of the ring's tokens. A token's place comes from a hash of the token and the
rollout version, so it is stable, and raising the percentage only adds people. For a named subset,
mint those people `internal` or `preview` tokens.

**Rings are targeting, not access control.** Any valid token can download any installer or
blockmap in the bucket by file name. That keeps old blockmaps available for differential
downloads; the same versions are public on GitHub anyway. To keep a build from some testers, do
not put it in the feed.

**Promoting.** Run **Desktop feed (promote)** (`feed-promote.yml`) with a ring, a version the feed
holds and a percentage: 100 offers it to the whole ring, 1–99 starts or changes a rollout, 0 halts
that version's rollout. A ring cannot get a version older than its full version or active rollout.
It runs only from main, in the protected `desktop-feed` environment.

**Rings never move backwards, and a halt is not a rollback.** Clients refuse downgrades, so anyone
who took a bad build keeps it until a newer fix ships. Keep early rollouts small.

### Server bundle channel

From the 0.8 line the feed also serves the signed prebuilt server bundle
([Prebuilt server bundle](#prebuilt-server-bundle)), with the same rings, rollouts, tokens and
pause switch (#877).

- A server asks for `server/latest-linux-x64.yml` and gets flat `key: value` lines naming the
  bundle, its manifest and signature, with SHA-256 digests and sizes
  ([`tools/deploy/feed-server.js`](../tools/deploy/feed-server.js)). The files are served as
  `server/orca-server-X.Y.Z-linux-x64.tar.xz` and so on, with Range and HEAD. The feed is only
  transport: the server verifies the manifest's keyless signature against the pinned workflow
  identity before using anything.
- **Tokens.** Give a server a server-only token: `node tools/deploy/feed-token.js RING --server`
  mints `{"ring": "…", "channel": "server"}`, which reads `server/` only.
- **Publishing.** **Desktop feed (publish signed)** feeds a release's server bundle first (to the
  internal ring's servers), then its Windows installers. It downloads the bundle by the release's
  single `orca-server-run` record, verifies it as a server does (`orca-release.py fetch-bundle`),
  and checks the signed manifest names the tag's commit. An rc's bundle is attached shortly after
  the rc is published; until then the run fails with "retry later" and the desktop job does not
  run. Versions before 0.8.0 have no bundle and skip this.
- **Servers first.** `rings.json` holds server rings beside desktop ones. A ring's desktops are
  never offered a version unless that ring's **full** server version is at least that version
  ("offer the server bundle VERSION to all of RING first"). A server rollout is not enough. So:
  promote with `channel` `server` (rollout, then 100%), then `channel` `desktop`. Servers may run
  ahead (the daemon accepts the previous protocol major for one release). A halt is always allowed.
- **What "servers first" proves:** only that servers were *offered* the version first. Not that
  any server installed it. Only the server updater (#878, #879) knows what a host runs.
- **Pause.** `ORCA_FEED_PAUSE` stops server publication and promotion (except a halt), as for
  desktops.
- **Stop.** **Server feed (stop or resume)** (`feed-server-stop.yml`, main only, `action` `stop` or
  `resume`) sets or clears `serverStop: true` in `rings.json`. While set, the Worker answers every
  server channel file with 503 and `X-Orca-Feed-Stop: servers`, and the server updater activates
  nothing, not even a staged version. Stopping is always allowed; resuming is refused while the
  feed is paused.
- **Watchdog.** The watchdog checks each ring's server channel too (below).
- **Worker version.** Redeploy the Worker from main before the first server publication and before
  using the stop switch. An older Worker answers 404 for `server/`, ignores server rings, treats a
  server token like any other, and ignores `serverStop`.

### Pulling a bad build

Rings never move backwards, so a bad build is contained, then replaced by a newer fix (from T3
Code's bad-nightly runbook, #863). First find out how far it got.

1. **Pause the feed.** Set the repository variable `ORCA_FEED_PAUSE` to `true` (Settings → Secrets
   and variables → Actions → Variables). **Desktop feed (publish signed)** then refuses to start,
   and **Desktop feed (promote)** refuses everything except a halt. The pause is checked when a
   job starts; it does **not** stop a job already past that check. For a bad **server** bundle,
   also dispatch **Server feed (stop or resume)** with `stop`, so servers do not activate a
   version they already staged. Resume once the fix is offered.
2. **Check for running jobs.** In Actions, look for in-progress or queued runs of both feed
   workflows (they share one concurrency group). Cancel any you did not intend, and let a running
   one finish or cancel it before reading the ring state.
3. **Read `rings.json`** (Cloudflare dashboard → R2 → the feed bucket). It is the only record of
   each ring's **full** version and active **rollout**. Decide from it alone. The watchdog's
   canary tokens each sit in one rollout bucket, so they can miss a rollout.
4. **Halt rollouts.** For each ring where the bad version is a partial rollout, dispatch
   **Desktop feed (promote)** with that ring, the bad version and percent `0`. A halt does nothing
   where the bad version is already the full version.
5. **Ship past a fully promoted bad build.** Release a newer fix (a patch or the next rc), sign it,
   unpause (set `ORCA_FEED_PAUSE` to anything but `true`, or delete it), publish to `internal`,
   check it, then promote it in every affected ring, starting small. Until then, tell that ring's
   testers not to update.
6. **Tell affected people what they will see.**
   - An install that already updated, or downloaded the bad version and waits to restart, keeps
     it. Clients refuse downgrades and the feed cannot recall a download.
   - An install offered the bad version before the halt can still download it; the installer
     stays in the bucket.
   - An install that never saw the offer is safe only while its ring no longer offers it.
   - If the bad version cannot start, use the [recovery contract](#windows-failed-update-recovery-contract-660-c5a-02)
     or reinstall the last good release from GitHub.

Leave the bad version's snapshot in the bucket. Deleting it breaks differential downloads from it.

### Feed watchdog

**Desktop feed (watchdog)** (`feed-watchdog.yml`) checks the live feed daily, as a client sees it.
For each ring with a canary token it fetches every channel file and fails when:

- a request without a token is not refused;
- an architecture the Worker does not serve answers;
- a ring is offered a version with no published GitHub release, `stable` a prerelease, or any
  ring a prerelease other than `-rc.N`;
- the channel file's `files[]` entry does not name exactly that architecture's installer, or
  disagrees with the legacy `path` and `sha512`;
- the served installer's size or sha512 differs from that entry or from the published release
  asset;
- on the server channel: the file does not parse strictly, names no published release (or a
  prerelease in `stable`), or a file's size or SHA-256 differs from the release asset; the stop
  answer is missing while `rings.json` sets `serverStop`; or desktops are offered a version their
  servers are not.

It also checks every ring against the live `rings.json`. A first job, run only from main in the
`feed-reader` environment, reads that file with a read-only key (`feed-r2.sh read-rings`) and
passes it on. It never sees a canary token or the publishing key; the canary job never sees a
bucket key. A channel answering 404 although its ring has an offer fails, as does any offer that
is not the ring's full or rollout version, or any offer to a ring with none.

Whether the feed is on comes from the repository variable `ORCA_FEED_BUCKET`. While set, a
missing `rings.json` or a failed read fails the run (an empty `rings.json` is valid). Before it is
set, only servers-first is checked. A promotion landing mid-run can fail it once; rerun. The
watchdog checks offers, never what hosts run.

To turn it on:

1. Create a GitHub environment `feed-canary`, deployment branches limited to `main`. It holds only
   canary tokens, never the R2 write credential.
2. Mint one canary token per ring with `node tools/deploy/feed-token.js RING` and add its
   `FEED_TOKENS` entry to the Worker secret.
3. Store the tokens as the **environment** secret `ORCA_FEED_CANARY_TOKENS` in `feed-canary`, as
   JSON: `{"internal": "…", "preview": "…", "stable": "…"}`.
4. Create a GitHub environment `feed-reader`, limited to `main`. Store an R2 token with **Object
   Read** only, on the feed bucket, as `ORCA_FEED_READER_ACCESS_KEY_ID` and
   `ORCA_FEED_READER_SECRET_ACCESS_KEY`. Never reuse the `desktop-feed` key. Without it the
   watchdog fails once `ORCA_FEED_BUCKET` is set.
5. Set the repository variable `ORCA_FEED_URL` to the feed's https origin. Until then the workflow
   is skipped. It runs only from main.

A canary token is an ordinary read token; revoke it the same way.

### Release and feed provisioning

`desktop.yml` builds each Windows architecture separately, with distinct installer names and
`latest-x64.yml` / `latest-arm64.yml` (`prerelease-*.yml` for prereleases; the Worker serves
either as `latest-ARCH.yml`). Linux and macOS automatic updating is outside this feed.

Packaging uses `--publish never`. The publication job waits for checks, smoke, type proof and
platform builds, flattens assets with collision checks, and checks metadata versions, SHA-512
checksums and blockmaps. A prerelease is uploaded to a draft, then made visible. A final stops at a
draft with only the Ubuntu amd64 `.deb`: no tag, nothing latest, no feed write
([Publishing a final](RELEASING.md#publishing-a-final)).

The feed never takes ordinary release-job builds: their Windows installers are unsigned. For a
final:

1. **Sign.** Staging the draft dispatches **Windows signed (spike)** for the draft's merge commit,
   before publication (automatic while `ORCA_RELEASE_AUTO_SIGN` is `true`).
2. **Attach and accept.** **Release (attach signed installer)** attaches that run's signed x64 and
   arm64 installers and records the run (automatic under the same switch, otherwise dispatched
   with the run id). Native acceptance runs on the exact draft assets (arm64 automatically, in
   **Release (accept Windows arm64)**). Only then is the draft published, which creates the tag.
3. **Architecture gate (#889).** Each version's snapshot carries its own architectures.
   `feed-publish.yml` always serves x64. It serves arm64 only for a final whose published arm64
   installer has verified native acceptance: its notes point at a successful **Release (accept
   Windows arm64)** run on `main` whose evidence names that release, commit, installer digest and
   upgrade baseline (`tools/deploy/feed-arches.js`).
   - The baseline is the newest earlier published final from 0.7.1 on (`ARM64_EVIDENCE_FROM`) with
     an arm64 installer not marked x64-only, and it must itself have verified acceptance.
     Otherwise the check fails.
   - An attached arm64 installer that is not declined (`<!-- orca-x64-only -->`) and does not
     verify fails the run instead of feeding x64 alone.
   - `feed-r2.sh` lists the architectures in the snapshot's write-once `complete.json`. The Worker
     serves only those. A snapshot without the list (every version before #889, v0.7.0 included)
     serves x64 only, and a retried publish never extends it to arm64.
   - `SERVED_ARCHES` in `worker.js` equals `FEED_ARCHES`; any other architecture gets 404.
     Changing either is a reviewed change to both, then a Worker deploy.
   - **Desktop feed (update test)** updates an installed N to N+1 through the Worker's handler, on
     x64 and on a native arm64 runner, for every feed or updater change.
4. **Feed.** **Desktop feed (automatic)** (`feed-auto.yml`, on while `ORCA_FEED_AUTO` is `true`)
   dispatches **Desktop feed (publish signed)** from main when the release is published, with the
   signing run recorded in the notes, if the published installer's digest still equals the
   recorded one. A daily run retries releases published in the last 7 days. To feed by hand (for
   example v0.7.0, which has no record), dispatch `feed-publish.yml` from main with the version and
   **that same** signing run's id, after confirming its x64 installer SHA-256 equals the accepted
   one.

What the feed job checks:

- `tools/deploy/feed-source.js` refuses a version without a published, non-draft GitHub release
  (a tag is not enough) and accepts only a successful `windows-signed.yml` run from main.
- The job downloads only the artifact for the tagged commit, re-checks each installer's
  Authenticode signature, timestamp and publisher (`ORCA_FEED_PUBLISHER_CN`), and checks each
  channel file names exactly one installer whose `files[]` entry and legacy `path`/`sha512` match
  its name, size and SHA-512, with its blockmap (`release-assets.py`, strict parsing).
- It refuses any served installer whose SHA-256 differs from the release asset.
- Signed artifacts are kept 7 days: publish and feed within a week of signing.

`feed-r2.sh snapshot` uploads installers and blockmaps to `VERSION/`, then the metadata, then
`VERSION/complete.json`, each only if absent. An existing object must have identical bytes, so a
rerun resumes and nothing published is replaced. Any lookup or write error other than "absent"
stops the run. It then offers the version to `internal`, unless it is older than what `internal`
already offers (a hotfix behind an rc): then it is stored but not offered; promote it explicitly.
The Worker serves nothing of a version until its `complete.json` exists.

**One-time setup (Casey):**

1. In Cloudflare, create a private R2 bucket (no public `r2.dev` access) and an R2 API token with
   Object Read & Write on that bucket only.
2. Copy `tools/deploy/feed-worker/wrangler.toml.example` to `wrangler.toml` (git-ignored), set the
   bucket and custom domain, and run `npx wrangler deploy` there. Deploy from current main before
   the first feed run and whenever `worker.js` changes.
3. Mint a token per person with `node tools/deploy/feed-token.js RING` (`--server` for a server).
   Merge the printed entries into one JSON object and store it with
   `npx wrangler secret put FEED_TOKENS`. Revoke a person by removing their entry.
4. Create the `desktop-feed` environment (Settings → Environments), deployment branches `main`
   only, no required reviewers (owner's decision, 2026-11-21). Store `ORCA_FEED_ACCESS_KEY_ID` and
   `ORCA_FEED_SECRET_ACCESS_KEY` there as **environment** secrets. Both feed workflows refuse any
   other ref.
5. Set repository variables `ORCA_RELEASE_AUTO_SIGN` (`true` to sign and attach finals
   automatically), `ORCA_FEED_AUTO` (`true` to feed published finals automatically),
   `ORCA_FEED_ACCOUNT_ID`, `ORCA_FEED_BUCKET` and `ORCA_FEED_PUBLISHER_CN` (the exact signing
   certificate CN, as in `WINDOWS_SIGNING_PUBLISHER_CN`). Until `ORCA_FEED_BUCKET` is set, neither
   feed workflow does anything.
6. Conditional writes need nothing by hand: every write job first runs `feed-r2.sh probe`, which
   checks R2 honours `If-None-Match` and `If-Match` on a throwaway `ci-probe/` key and stops
   otherwise.
7. Before giving out tokens, run packaged acceptance on real Windows with signed builds from the
   feed: an opted-in preview install on stable `N` is offered and installs `N+1-rc.x`; a stable
   install is not; neither is then offered an older version. `tools/test/feed-client.test.js`
   checks the same policy against the Worker but replaces Electron's network and install, so it
   is not that acceptance.

**When a feed run fails,** the release and rings stay as they were. Rerun **Desktop feed (publish
signed)** with the same inputs. A fresh signing run of the same commit is **not** a retry for an
accepted final: its bytes differ, and `feed-r2.sh` refuses it once any object exists. If the
accepted run's artifact expired, stop and decide; never substitute new bytes. Never rerun release
creation for a published tag.

**Signing.** Windows signing uses `windows-signed.yml` (Azure Artifact Signing over OIDC;
[runbook](windows-signing-runbook.md)). The signed installer is the only supported final
download; unsigned ones are CI output. A signature authenticates the publisher but does not
guarantee SmartScreen reputation. Never weaken signature checks to get a test green.

## Debian: inventory before migration

Do not assume `/srv/dev/orca-live` uses systemd. Before migrating, inspect locally:

```sh
sed -n '1,200p' /srv/dev/orca-live/orca /srv/dev/orca-live/orca-acp
ps -u "$(id -u)" -o pid,ppid,args
systemctl --user list-units --all '*orca*'
systemctl list-units --all '*orca*'
# For the actual unit, if one exists:
systemctl --user cat orca.service
systemctl --user show orca.service -p MainPID -p ExecStart -p WorkingDirectory -p EnvironmentFiles
```

- Also check cron, shell sessions, containers and Kepler launch settings. Record every launch path
  and every config glob pointing into the old worktree. The inventory is not complete while any
  unmanaged launcher remains.
- The updater also checks same-user `/proc` ORCA processes and that systemd's MainPID is the exact
  selected CLI. An unknown service or PID, unavailable `/proc`, or an old daemon without admission
  support blocks activation.
- This is a **single-user managed deployment**, not a security boundary against someone bypassing
  the wrappers or another account writing the stores.
- Keep `/srv/dev/orca-live` as the operator directory. Keep configs, permission sidecars,
  credentials, `.orca`, `.orca-kepler`, task worktrees and agent installs outside `releases/`. Back
  them up before bootstrap.
- Never install or upgrade Claude Code or its ACP adapter as part of this procedure.

### Bootstrap once, during an idle maintenance window

The updater is a separate Python command on purpose: recovery must work when the selected Node
checkout cannot start, and it owns Debian's kernel `flock` launch boundary. It is the
`orca-release` equivalent of `orca update`.

| Stage from | Needs |
| --- | --- |
| Source | Linux, Python 3.8+, util-linux/procfs, Git, an authenticated GitHub CLI, mise, the actual operator's service account, registry access and staging disk space |
| [Bundle](#prebuilt-server-bundle) | Linux x64, Python 3.8+, util-linux/procfs, HTTPS to github.com and Sigstore |

GitHub authentication stays in `gh`'s own store. Never put tokens in clone URLs or deployment
JSON.

1. Stop admitting new CLI and Kepler work through the existing launcher, let active sessions
   finish, and stop the idle daemon with its **observed** supervisor. Do not kill active work.
2. Copy `tools/deploy/orca-release.py` from the reviewed release to
   `/srv/dev/orca-live/orca-release.py`, outside any replaceable checkout.
3. In both configs, replace only the shipped workflow and template prefixes with a literal
   `${ORCA_RELEASE}`. Keep custom paths and every other key:

   ```yaml
   workflows: ['${ORCA_RELEASE}/workflows/**/*.yaml']
   templates: ['${ORCA_RELEASE}/templates/**/*.md']
   ```

4. Write `/srv/dev/orca-live/deployment.json` with the paths and service you chose. `launchAudit`
   is your assertion after the inventory:

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

5. Stage the first published release:

   ```sh
   python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json stage v0.6.0
   ln -s /srv/dev/orca-live/releases/v0.6.0 /srv/dev/orca-live/current
   ```

   Staging refuses existing directories, unpublished tags and prereleases. It clones, installs and
   builds, checks the compiled version, runs the scripted demo, validates all three configs
   without writing them, and checks a temporary daemon's hello. A failed stage stays as
   `.staging-*` for diagnosis; never select it.
6. Replace the wrapper bodies, keeping required environment:

   ```sh
   # /srv/dev/orca-live/orca
   #!/bin/sh
   exec /usr/bin/python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json cli "$@"
   ```

   `orca-acp` is the same with `acp` instead of `cli`. Keep Kepler pointed at that wrapper. ACP keeps
   its own config and store. The wrapper resolves `current` under its launch lock and runs the
   release's recorded absolute Node. `${ORCA_RELEASE}` expands to that same directory.
7. If systemd is the target, install as the operator's `~/.config/systemd/user/orca.service`:

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

   - Do not add `User=` to a user unit. For a system unit, use `User=OPERATOR`, the matching
     environment and home, and `userService: false`, with only the service-control rights needed.
   - Create `daemon.env` (mode 0600) with the agents' PATH and credentials, without shell commands
     or mise activation. The adapter runs `.orca-release.json`'s absolute Node; review it first.
   - Run `systemctl --user daemon-reload`, then `enable --now orca.service` only after the old
     supervisor is disabled. Check hello and a scripted run before reopening launches.

### Normal update

```sh
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json update v0.6.1
```

1. The tag is explicit. Nothing updates in the background unless you opt in to
   [automatic server updates](#automatic-server-updates).
2. Staging runs while work continues. A validated stage is reused.
3. Activation takes the deployment update lock and the exclusive launch lock, checks the service
   identity and old hello, then closes admission.
4. Active CLI or ACP processes (including idle open Kepler sessions), another update, or daemon
   work produce a blocker and a nonzero exit. Retry later. Nothing is cancelled.
5. The daemon stops, `current` is replaced atomically, and the new daemon starts **with admission
   closed**. Admission reopens only when hello shows the expected version, exact protocol and
   required capabilities. All runtime parts and assets move together.

### Prebuilt server bundle

For a new machine, the app's **Add a machine** and `orca remote add user@host` do the whole
bootstrap from the bundle in one idempotent step, and refuse a machine with an unmanaged install
([daemon connections](daemon-connection.md#add-a-machine-one-step-server-setup-881)).

From the 0.8 line (0.8.0's rcs on), every release publishes a signed prebuilt server,
`orca-server-X.Y.Z-linux-x64.tar.xz`, with its manifest and signature
([RELEASING](RELEASING.md#the-server-bundle)). Staging from it needs no toolchain, clone or GitHub
CLI:

```sh
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json stage --bundle v0.8.0
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json update --bundle v0.8.0
```

- `update --bundle` stages (or reuses a validated `releases/v0.8.0`), then activates as above.
- `update --expect-current X.Y.Z` refuses (`Server moved:`) under the update and admission locks
  unless the active release is exactly `X.Y.Z`. The app always passes it.
- `--bundle` also takes a directory holding the three files, for a server without github.com.
- An rc (`v0.8.0-rc.1`) is accepted by its full version and sorts before its release. Dry runs are
  never signed or accepted.

**When a bundle is ready.** A final is published only with its bundle attached and recorded. An
rc gets its bundle from a separate run shortly after (normally within half an hour; a reconcile
retries every 6 hours). It is ready when the release notes carry one
`<!-- orca-server-run: RUN … -->` record whose three digests match the attached files. Until then
`stage --bundle vX.Y.Z-rc.N` says "no complete server bundle yet; retry later".

Before reading a byte of the archive, staging:

1. (by version) requires that single record and downloads only assets whose digests match;
2. fetches cosign `v3.1.4` once into `tools/` under the deployment root and checks it against the
   SHA-256 pinned in the adapter on every use (nothing on `PATH` is trusted);
3. runs `cosign verify-blob` on the manifest, requiring a certificate for
   `release-server-bundle.yml` on `refs/heads/main` of `cschadewitz/Project_Orca`, issuer
   `https://token.actions.githubusercontent.com`, trigger `workflow_dispatch`, and a
   transparency-log entry (Sigstore's trust root is cached in `tools/sigstore`);
4. checks the manifest's schema, name, version and platform, and the archive's exact size and
   SHA-256.

A tampered archive, another signer or another version's manifest stops here, leaving an empty
`.staging-*`. Then the archive is unpacked by hand: only regular files and directories under the
one expected root, bounded in size. The release records `runtime/bin/node` and `orca-daemon.mjs`
(`.orca-release.json` `"source": "bundle"`); only those two paths are ever run for a bundle
release. The same version, demo, config and hello checks as a source stage run before the rename
into `releases/vX.Y.Z`. Source and bundle releases can activate and roll back into each other.

A bundle release's daemon runs as `runtime/bin/node …/orca-daemon.mjs`, so the service check
follows the recorded entry. Install the updated adapter (bootstrap step 2) before the first bundle
update.

### Automatic server updates

From the 0.8 line a server can follow its ring on the
[server channel](#server-bundle-channel) unattended (#878). Opt in by adding `autoUpdate` to
`deployment.json`:

```json
"autoUpdate": {
  "feed": "https://feed.example.org",
  "tokenFile": "/srv/dev/orca-live/feed-token",
  "interval": "1h",
  "maxDeferralHours": 72,
  "quietHours": "08:00-18:00",
  "settleSeconds": 10
}
```

| Setting | Meaning |
| --- | --- |
| `feed` | Required. The feed's https origin. |
| `tokenFile` | Required. Absolute path to a **server** token (`feed-token.js RING --server`): a regular file owned by the service user, mode 600. The token decides the ring. |
| `interval` | Default `1h`. How often to check (`30min`, `1h`, `1d`, …). |
| `maxDeferralHours` | Default `72`. How long a staged update may wait for idle before it is reported overdue. |
| `quietHours` | Optional local-time window (`HH:MM-HH:MM`, may wrap midnight) with no activation. Staging still happens. |
| `settleSeconds` | Default `10`. Delay between the new daemon's first good hello and a second. |

Install the timer once, as the service user:

```sh
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json install-timer
loginctl enable-linger "$USER"   # once, so user timers run without a login session
```

`install-timer` writes and enables `orca-auto-update.service` and `orca-auto-update.timer` in
`~/.config/systemd/user`. The timer runs 5 minutes after boot, then every `interval` with up to 5
minutes' random delay, and catches up missed runs. Each run is one `orca-release.py … auto-update`;
run it by hand to check now.

A run:

1. **Takes the update lock without waiting.** If held (a manual update or another check), it
   defers and exits 0.
2. **Checks blockers.** An interrupted activation journal: `blocked`, nonzero; inspect and run
   `recover`. A file `auto-update.stop` in the deployment root: `stopped`, exit 0.
3. **Reads `server/latest-linux-x64.yml`**, parsed exactly as `feed-server.js` writes it. No offer
   (404), or nothing newer than `current`: no change. Never moves backwards. The servers' stop
   (503 with `X-Orca-Feed-Stop: servers`): `stopped`, exit 0, even for a staged release.
4. **Stages while work continues.** It reuses a staged `releases/vX.Y.Z` only if its receipt's
   SHA-256 and size for archive, manifest and signature all equal the channel file's. A
   same-version release without a matching receipt is refused (`failed`). Otherwise it downloads
   the three files, checks them against the channel file, and stages them exactly as
   `stage --bundle DIR`. The channel file is only a pointer.
5. **Checks again just before activating:** the stop file, quiet hours against the clock now, and
   the channel file re-read. Stop: `stopped`. Quiet hours: defer. A gone or changed offer:
   `withdrawn`, exit 0. The staged release is kept.
6. **Activates** through the [normal update](#normal-update) path, with a second hello after
   `settleSeconds`, before admission reopens. Both hellos must come from the same process: PID,
   unit invocation ID, process start time and boot are recorded before and must be unchanged
   after. A restart while settling is a failure and is rolled back.
   - **Work is never cancelled.** Active work, open CLI/ACP processes or quiet hours defer (exit 0).
     Past `maxDeferralHours` the run reports `overdue` with a nonzero exit (so the unit shows as
     failed), but still cancels nothing.
   - **Rollback is automatic only while admission stayed closed.** If the new daemon fails either
     hello, `current` returns to the previous release, which must pass its own hello first
     (`rolled-back`, nonzero).
   - **Once admission reopened, nothing is rolled back**, including after an uncertain resume: the
     new release may hold work the old one would lose. The run closes admission again if allowed,
     keeps the activation journal (which blocks launches and updates), and reports
     `failed-not-rolled-back`. Inspect, then `recover`.
   - **Removing the journal can fail** (`finalize-failed`, nonzero): the new release is active and
     admission open. The journal is rewritten durably, so launches and updates stay blocked until
     you `recover`. If even that write fails, the report says so; check whether the journal
     survives.
   - **Another store epoch is never activated unattended** (`refused`). See
     [Recovery and store compatibility](#recovery-and-store-compatibility).
7. **Prunes.** After success it keeps exactly two complete releases (new and previous). Staging
   leftovers are kept.

Every run writes `auto-update.json` in the deployment root and to the journal
(`journalctl --user -u orca-auto-update`): time, `current`, offered version, outcome (`none`,
`current`, `updated`, `deferred`, `overdue`, `stopped`, `withdrawn`, `rolled-back`,
`failed-not-rolled-back`, `finalize-failed`, `refused`, `blocked`, `failed`) and a detail.

To stop updates: `ORCA_FEED_PAUSE` stops new offers; the servers' stop switch also stops servers
acting on earlier offers. For one server, create `auto-update.stop` in its deployment root (remove
it to resume), or run `systemctl --user disable --now orca-auto-update.timer`.

### Updating a server from the app

A server the adapter launched can be updated from the desktop app over the same SSH profile
([daemon connections](daemon-connection.md#ssh-connection-profiles-874)). The adapter passes the
daemon `ORCA_DEPLOYMENT_ADAPTER`, `ORCA_DEPLOYMENT_MANIFEST` and `ORCA_DEPLOYMENT_RING`, and the
daemon reports them in `hello.deployment` to callers with `config.read`. A daemon started any other
way reports nothing, and the app offers no update.

What the daemon reports is a hint, never what the app runs:

1. **You type the paths.** The first time, the dialog shows what the server reports and asks you to
   type the updater path (an `orca-release.py`) and manifest path (a `.json`). It shows the exact
   command and runs nothing until you approve. Your typed paths must match what the server reports.
2. **The approval is per server.** It is saved beside the profile (`server-updaters.json`) with the
   tunnel's authenticated host key and the daemon's workspace identity, and holds only while both
   match. Changing the profile's server or port, or forgetting or removing its host key, drops it.
3. **A mismatch is refused.** If the daemon reports other paths, the dialog asks again.
4. **One preview.** Everything the dialog shows (profile, connection, host key, workspace, server
   version, target version) comes from one look, and the app refuses if the connection no longer
   matches it.
5. **Forward only, to the app's release, from the release you saw.** The target is the app's own
   release version, and the server must run an older one. `--expect-current` makes the updater
   check again under its locks; if the server moved meanwhile, it refuses with `Server moved:`.

**Update now** runs over the profile's own ssh (the tunnel's pinned keys, the profile's key, no
forwards, no ssh config):

```sh
python3 <adapter> --deployment <manifest> update --bundle v<app version> --expect-current <server version>
```

The server's rules decide: signer and digests, forward-only versions, the update lock and the
admission barrier. The app streams the output, then reports:

| Result | Meaning |
| --- | --- |
| Updated | The updater succeeded and a fresh authenticated hello from the same profile, host key and workspace reports the new version. |
| Unknown | SSH was lost after the updater could have started, or it reported success but the server did not confirm the new version within about a minute. Check the server before retrying. |
| Work is running | The barrier refused (`Daemon busy`, `Busy: admission.lock`, or an unmanaged ORCA process). Nothing was cancelled. |
| Another update is running | `Busy: update.lock`, held by an [automatic update](#automatic-server-updates) or another operator. A timer run that finds the app's update holding the lock defers too. |
| The server moved | `Server moved:`. Another update finished in between; check again. |
| Failed | The updater's `orca-release:` message, and whether the previous release was restored. |
| SSH refused before it started | Missing ssh client, changed or missing host key, or refused key. Nothing ran. |

An update from the app is a manual update: `auto-update.stop` and the feed's switches stop only
the timer. A leftover activation journal blocks it (`Recovery pending; run recover first`). A
development build (not a release tag) offers no update.

## Stores across versions

### Recovery and store compatibility

The current protocol and store epoch are in the
[protocol reference](../packages/protocol/README.md) and `release-compatibility.json`. The rules:

- **Upgrade clients and daemons together.** A major protocol change closes old schemas, and new
  events (such as `revision.recorded`) cannot be parsed by old readers.
- **The managed updater** refuses activation and recovery across store epochs. Direct CLI and
  daemon startup do not read `release-compatibility.json`; from 0.7.1 they check the store's own
  format marker ([Store format carryover](#store-format-carryover)). Builds before 0.7.1 ignore
  the marker, so an old binary starting is not proof it can read or safely write a newer store.
- **Before the first upgraded writer runs:** stop admission, finish work, stop every writer, and
  take a complete, consistent backup of both stores and everything below. Keep the matching old
  binary and toolchain, and test the restore offline. The backup must include private and
  protected payloads and all admission, continuation and revision journals.
- **Rollback** means restoring that whole backup before starting the old binary. Never mix files
  from old and new stores. Writes after the backup need separate reconciliation. An in-place
  downgrade is unsupported.
- **Changing a writer** so old binaries cannot safely read its output requires a new epoch in
  `release-compatibility.json` and a store changelog fragment. Never edit the marker to bypass the
  check.
- **A deliberate migration** needs an idle, stopped deployment, a consistent backup of both stores,
  plan journals, artifacts, permission sidecars and configs, and explicit migration and restore
  validation. Never copy a live event store as a backup.

**Activation and `recover`.** During compatible activation, `activation.json` is fsynced before any
service or pointer change. A failed startup or hello restores the previous pointer, restarts it
closed, checks its hello, then reopens admission. If that fails too, the journal stays and
launchers refuse work. After fixing the cause, run:

```sh
python3 /srv/dev/orca-live/orca-release.py --deployment /srv/dev/orca-live/deployment.json recover
```

- It re-checks compatibility and health. It never deletes stores or force-kills work.
- If admission may have reopened, recovery first needs a successful prepare. If the service is
  offline, repair and start the selected service (it reads the persistent closed-admission file),
  then retry.
- Never delete the journal by hand to unblock launches.
- Keep the old checkout and its Node until recovery is no longer needed.
- The daemon checks the durable admission file before every operation, so a supervisor restart
  during activation cannot reopen admission. The journal is written before activity is inspected.
  An uncertain prepare keeps it; a known busy answer removes it without stopping the service.
- A manual downgrade after a completed upgrade needs a separate maintenance and backup decision;
  `update` refuses it.

### Protocol compatibility window

From protocol 2.1 (#880) a desktop and a daemon one **major** apart can still connect, so an app
that updates first keeps its servers.

- `hello` negotiates. A client sends its protocol and, while its build has a window open, a
  `fallback` (the last minor of the previous major it speaks). The daemon answers in the highest
  shared protocol, named in `hello.protocol`.
- A daemon on major N accepts N and N-1 clients for **one release**. N-2, or an N-1 client newer in
  minor than the daemon's N-1, is refused with a message naming what the daemon accepts.
- An app on N with a daemon on N-1 reads and writes; what N added is off, and the connection bar
  says the daemon is one major behind.
- The window is `PREVIOUS_PROTOCOL` in `@orca/protocol`. The release that bumps the major sets it
  to the final N-1.x; the next major replaces it. It is unset today.
- **Within a major, an updated desktop works with older daemons.** Clients offer the oldest minor
  they need (`CLIENT_PROTOCOL`, 2.0 today). Only the daemon reads `fallback`.
- **2.x opens no window**: 1.10 peers cannot read 2.x, so 1.10 stays refused. 2.1 is the first
  daemon that understands `fallback`, which lets the first 3.0 app talk to it.
- The window stays off until the major that opens it verifies its previous-major projection
  (capabilities, methods, events).
- The window never covers store epochs.

**Across a major, promote servers first.** Move daemons to N while desktops are on N-1, then
promote the N desktop. Finish moving every daemon to N before the next major.

### Store format carryover

From 0.7.1 every store records its format (store epoch) and the ORCA version that last wrote it in
`store-format.json`. Every command that opens the store, the app's bundled daemon included, checks
it first (#566). Ordinary startup never converts a store:

| The store was written in | Ordinary startup |
| --- | --- |
| Its own format | Opens it. |
| `operator-journals-v4` before the marker existed, with intact evidence a 0.7 build wrote it (`.workspace-identified` holding `1`, a valid `workspace-identity/id`, a 32-byte `private-execution/.execution-key`, none linked or foreign-owned) | Stamps the marker and opens it. Nothing else changes. |
| The previous format, or any other unmarked store | Refuses (`CARRYOVER_REQUIRED`), changes nothing. Run `orca store carry-forward` once. The app does it itself after an in-app update ([below](#automatic-carryover-after-a-desktop-update)). |
| An older format | Refuses, naming the release line to open it with first. |
| An unknown (newer) format | Refuses reads and writes, naming the version that wrote it and its backup, if any. |
| A damaged marker | Refuses until the marker is restored or repaired with ORCA stopped. |

`orca store format` prints the format, whether metadata is in files or SQLite, and what startup
would do. The supported window is this release's format and the previous one. Closed update
validation (`serve --read-only --no-resume` under an update fence) only checks; it never writes
the marker. `validate` does not open the store.

**SQLite (#339).** A SQLite store has its own format, `operator-journals-v4-sqlite`, refused by
builds that do not know it. `orca store sqlite convert` makes a SQLite store beside the file store
(`.orca-sqlite`) and names it in the config, leaving the file store untouched. Older builds are
fenced out. Stop every older ORCA first: one still running keeps writing the file store
(`orca store format` reports this). To go back, point `storeDir` at the file store. In-place
`orca store sqlite switch` is refused. See
[SQLite metadata](storage/sqlite-metadata.md#choosing-sqlite-for-a-workspace).

**`orca store carry-forward`** is the explicit offline conversion. Stop every ORCA app, daemon and
command on the workspace first. Pre-0.7.1 writers take no lock it can see, so it checks for itself
and refuses, leaving the old format in charge, if any step fails:

1. No run lease is live and the leases are readable; otherwise `BUSY`. A store holding links is
   refused (`UNREADABLE`).
2. The store is copied into a private staging folder under `format-backups/`, and every file is
   compared byte for byte.
3. The full file listing (path, type, size, mtime, inode) must be unchanged across the copy;
   otherwise the copy is discarded (`BUSY`).
4. A throwaway second copy is opened with this build's readers: every run log, the request,
   work-item, artifact, lease and plan collections, and every plan journal. Any read failure:
   `UNREADABLE`. The staged backup must be unchanged afterwards.
5. The listing is checked once more, the staged copy is published as
   `format-backups/<time>-from-<format>/` with a `format-backup.json` manifest, and only then is
   the marker stamped.

- **Retention** removes only backups this command made (with a valid manifest), keeping the newest
  two and always the one the marker names, plus scratch folders of interrupted runs.
  `format-backups/` must be a private directory owned by the user (`BACKUPS_UNSAFE` otherwise).
- **Durability on Linux and macOS.** Copy, manifest, published backup and marker are each flushed
  (files, then their directory) before the next step, so the marker never lands before its backup.
  Tests interrupt each step; that shows a stopped process leaves the old format in charge, not that
  every disk honours flushes on power loss.
- **App workspaces** are refused (`APP_OWNED`): only the app's daemon may write them. The app
  carries them forward itself.
- **The backup** covers the store directory only, not the config, permission sidecar or `auth/`.
  Agents cannot read `format-backups/`. To go back: stop ORCA, move the store aside, copy the
  backup into its place, start the older release (not on Windows; see below). Later work is not in
  the backup.

#### Windows carryover is off (#910)

Every Windows carryover is refused (`UNDURABLE`) and the store stays on its previous format, until
an automated power-cut test on NTFS (#947) proves the design. The design is built and tested with
`WINDOWS_STORE_CARRYOVER` in `packages/store/src/store-format.ts` switched on; enabling it is a
one-line change made with that proof.

Windows documents no way for an unelevated program to order directory-entry writes, so the POSIX
order cannot be shown to survive power loss. It does document that `FlushFileBuffers` reaches the
device, and that a file which survived a restart has its entry on disk. So on Windows the backup is
one ZIP written into a slot that survived a restart:

1. Every write-mode start creates owner-only `format-backups/` and two slot files,
   `store-backup-1.zip` and `store-backup-2.zip`, if missing. Each records its NTFS volume serial,
   file ID and the Windows `BootId` it was created in. A slot whose identity names another file is
   stamped anew.
2. Carryover uses only a private regular slot whose identity is itself and whose `BootId` is not the
   current one. Never the slot the marker names, nor an unfinished archive. With no such slot, or no
   readable `BootId`, it refuses (`UNDURABLE`) having copied nothing: restart Windows and start ORCA
   again. Automatic carryover keeps its handoff for that retry.
3. Steps 1–4 above run as elsewhere. The verified copy and its manifest (naming `from`, `to` and the
   slot identity) are written over the slot as a stored ZIP, truncated, flushed, and read back entry
   by entry. Only then is the marker created.
4. The slot archive is the durable record. On every Windows carry-forward, an archive whose `from`
   matches the marker (or `unmarked`) but whose conversion the marker does not show is found first.
   If the store still matches it byte for byte, the marker is written naming it. Otherwise the
   store is refused (`INTERRUPTED`) and the archive kept. Any archive recording a newer format
   refuses the store (`NEWER`) on every Windows open, even with carryover off. Two unfinished
   records refuse (`INTERRUPTED`).

- **There is no supported restore of a Windows slot archive.** Extracting it does not restore the
  owner-only access on the execution key and private records. Restore comes with #947.
- **Private copies.** Every backup and read-copy directory is created with an owner-only protected
  DACL, and every copied file and directory is checked owner-only and owned by the user before
  publishing (`BACKUPS_UNSAFE`). Files are created new, never copied with their source's security.
- A Windows CI job runs the design as a standard user on NTFS with the switch on for the probe: off
  refuses, fresh slots refuse, the next `BootId` carries, the archive finishes after the marker is
  deleted, and `Expand-Archive` reads it (a format check, not a restore). It stands in for a
  restart; it does not cut power.

#### Automatic carryover after a desktop update

From 0.8.0 the app carries its own workspace's store forward on the first start after an in-app
update, only with proof nothing else can write the store (#897):

1. **Before the installer runs**, the updater closes admission on the bundled daemon, waits for no
   active work, stops it and sees that exact process exit. It then publishes
   `update-handoff.json.<claim>` in the store: the exact store and workspace directories, the
   first-run journal claim of the stopped daemon, and the version being installed. The journal's
   latest attempt must be exactly that claim, settled by that exit, or nothing is published. The
   file is created exclusively and never replaced or deleted by the updater.
2. **On first start**, the new bundled daemon enters as the first-run writer and holds the
   workspace's kernel-lifetime fence, which no other ORCA process can hold at once. It may carry
   the store only if its claim directly follows the record's, the record names this store, and this
   is the installed version.
3. **The carryover** is `carry-forward` above, with the fence checked before the copy, after it,
   after the read check, before publishing the backup and before the marker. Lost fence:
   `FENCE_LOST`, nothing carried.

- A finished or refused carryover spends the record, only while the fence and the exact record are
  still held. A crash is retried on the next start under the same proof, at most three times.
- Without the record, or any part of the proof, startup refuses (`CARRYOVER_REQUIRED`) and
  `orca store carry-forward` remains the way through.
- **Linux `.deb`.** There is no in-app updater and no `orca` command. While running, the app reads
  dpkg's status every 30 seconds. Once `apt` has fully installed another `orca-desktop` version, the
  title bar offers **Restart to finish update** (#905). It runs the Windows sequence above, then
  starts the installed binary, whose daemon carries the store under the same proof.
  - A failure before the stop resumes the current daemon and offers the restart again.
  - The target is checked at the click, after the stop and before launch: dpkg must still report the
    version fully installed, and `/opt/ORCA/orca-desktop` must match the package checksum. If `apt`
    changes the package in the moment before Electron starts it, another version may start; its
    daemon cannot use the record, so it refuses an older store as after a plain reopen.
  - After the stop, the old version is never restarted (apt may have removed it). A moved target, a
    refused handoff or an uncertain stop starts nothing, keeps admission closed, and tells the person
    to quit and reopen, and if the workspace then refuses (`CARRYOVER_REQUIRED`), to reinstall the
    previous package ([INSTALL-LINUX](INSTALL-LINUX.md)). Quitting and reopening writes no record.

## Verification boundary

- Automated tests cover updater state and IPC, daemon admission, real flock contention, pointer
  selection, failed activation and recovery, protocol and capability checks, and store-epoch
  refusal.
- After `pnpm run build`, run a compiled-daemon exercise with
  `ORCA_INTEGRATION_NODE=$(mise which node) python3 -B tools/deploy/test_integration.py`. It uses a
  subprocess supervisor instead of systemd and synthetic versions. It does not prove a real
  release fetch or the live service.
- Before deployment, run a real Windows installed N-to-N+1 cycle in a disposable profile: check,
  download, exit without installing, relaunch, restart, verify N+1. Also test offline, 401, a
  corrupt download, a wrong signature, drafts and an active bundled run, on both architectures with
  signed installers.
- Run a Debian published N-to-N+1 upgrade and an injected failed-start recovery against copied
  stores under the real systemd unit.
