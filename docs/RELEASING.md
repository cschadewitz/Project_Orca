# Releasing

A release of ORCA is a git tag, a GitHub release, and the `CHANGELOG.md` section they
both quote. Nothing is published to a registry: every package under `packages/` is
`private: true` and they move in lockstep, so there is exactly one version for the whole
repository, held in the root `package.json`.

Releases start at `0.2.0`. `0.1.0` was the untagged groundwork commit.

## The unit of release is a milestone

A milestone is the story: a set of issues that together make a coherent thing to announce.
Closing it proposes the release.

1. Every issue in the milestone carries one **bump label** — `release:major`,
   `release:minor`, `release:patch`, or `release:none` for internal churn nobody upgrading
   needs to know about. An issue with no bump label counts as `release:none`, and the
   release pull request lists those issues so an under-bump is visible rather than silent.
2. Each pull request drops its entry into `changelog.d/` as a **fragment** — one file per
   entry, named `<issue>-<slug>.<section>.md`, holding the bullet(s) verbatim. This is the
   part that matters: the notes are written when the change is fresh, by whoever made it,
   and releasing never has to reconstruct them from commit subjects. The manually dispatched
   Changelog workflow can check a PR number for `packages/` changes without a fragment,
   honoring the `no-changelog` label. It no longer runs automatically on PR events.
   `changelog.d/README.md` has the naming and the four sections; `node tools/release.js notes
   --unreleased` renders what is pending.
3. When the work is done, **close the milestone**. `release-prepare.yml` checks that no
   issue in it is still open, takes the highest bump label, computes the next version, and
   opens a `release: vX.Y.Z` pull request that bumps `package.json`, renders the fragments
   into a dated changelog section and deletes them.
4. Review that pull request. Its body is the release body verbatim — to change the notes,
   edit `CHANGELOG.md` on the release branch.
5. **Merge it.** `release-publish.yml` re-runs `ci.yml`'s full check path against the
   merge commit — typecheck, design-token freshness, format, lint, build, the no-skip
   CLI/ACP retry acceptance, the tests with production MCP acceptance required, and the
   compiled-CLI smoke test, in that order and under the same worker bound — runs the
   reusable desktop smoke and three-platform type-proof checks against that same commit,
   builds the desktop and daemon artifacts from that same commit (`desktop.yml`, below),
   then tags `vX.Y.Z` and publishes the release with the changelog section as its body,
   the artifacts attached, and GitHub's generated list of merged pull requests appended
   underneath. A **final** (`0.7.0`, no prerelease suffix) stops short of that: see
   [Publishing a final](#publishing-a-final).

Closing a milestone stops at a pull request on purpose. A milestone can be closed by
accident and reopened; a published tag cannot be unpublished cleanly. One merge click is
the whole cost of that safety.

**The release pull request shows no CI checks.** GitHub does not start a workflow run from
an event created with `GITHUB_TOKEN`, so the PR that `release-prepare.yml` opens never
triggers `ci.yml`. That is why `release-publish.yml` re-runs the full check set against
the merge commit before it tags: the verification happens, just after the merge rather
than before it. Only `ci.yml`'s coverage thresholds are left out: they are `main`'s
ratchets, and the push the merge makes still runs them in `ci.yml`, without gating the tag.
`tools/test/release-workflow.test.js` fails if the release job's order, production flag,
retry acceptance or worker bound drift from `ci.yml`'s. If `release-publish.yml` fails,
the version bump is on `main` with no tag against it — fix forward, then run **Release (publish)** from the Actions tab against
`main` (or the fixed commit). It publishes whatever version that commit's `package.json`
holds, through the same checks, builds and tag step, and refuses if the tag already
exists. Re-running the failed run is not the same thing: a re-run uses the workflow files
of the commit it first ran on, so a fix to the workflows never reaches it; and closing the
milestone again cannot help, since `prepare` refuses to bump to a version `main` already
carries. Giving `release-prepare.yml` a personal
access token instead of `GITHUB_TOKEN` would move the checks back onto the PR, at the cost
of a token to store and rotate; that trade is only worth making if `main` ever gains
required status checks.

### Publishing a final

A final becomes the repository's "latest", so its page must offer only signed or validated
downloads. The Windows installers `release-publish.yml` builds are unsigned, and only the
Ubuntu 24.04 amd64 `.deb` has native install acceptance. So for a final, `publish` creates
a **draft** through the API, targeting the merge commit, with the Ubuntu amd64 `.deb`
attached and nothing else: no tag exists yet, nothing is latest, and no feed step runs. It
takes the release id from the creation response, uploads by that id, and reads the draft
back (still a draft, the intended commit, exactly the `.deb` with this run's digest) before
the job summary reports the id. The run's other builds stay in its workflow artifacts.

Work on the draft **by id, never by tag**: a draft has no tag yet, and the API can report
its `tag_name` as a temporary `untagged-…` value. With `R=cschadewitz/Project_Orca`, `ID`
the release id from the job summary, `SHA` the commit and `V` the version:

1. Dispatch **Windows signed (spike)** from `main` with `source_sha` set to `SHA`, while
   `main` still matches it outside notes, docs and workflows (later product drift on `main`
   makes the source check refuse it). Its environment reviewer approves the run.
2. Verify the signing run's output: Authenticode status `Valid`, a timestamp, the expected
   publisher, and the run's `latest-x64.yml` `files[0]` (`url`, `size`, base64 **SHA-512**)
   describing exactly `ORCA-$V-win-x64.exe` (`release-assets.py` checks this). Record the
   installer's **SHA-256** separately: that is what the release page and the notes'
   verification step show.
3. Check the draft:
   `gh api repos/$R/releases/$ID --jq '{draft, name, tag_name, target_commitish, assets: [.assets[] | {name, digest}]}'`
   must show `draft: true`, `name: "v$V"`, `target_commitish` equal to `SHA`, and only the
   `.deb`, whose `digest` matches the run's artifact. `tag_name` may read `v$V` or
   `untagged-…`; step 5 sets it.
4. Attach the signed installer by id:
   `gh api -X POST -H 'Content-Type: application/octet-stream' "https://uploads.github.com/repos/$R/releases/$ID/assets?name=ORCA-$V-win-x64.exe" --input <file>`,
   then repeat step 3: exactly the `.exe` and the `.deb`, the `.exe`'s `digest` equal to
   `sha256:` and the SHA-256 recorded in step 2.
5. Publish with the tag and target stated explicitly:
   `gh api -X PATCH repos/$R/releases/$ID -f tag_name=v$V -f target_commitish=$SHA -F draft=false -f make_latest=true`.
   Then `git ls-remote origin refs/tags/v$V` must print `SHA`, and
   `gh api repos/$R/releases/latest --jq .id` must print `ID`.
6. Download both assets from the published page and repeat the native acceptance on the
   exact published files (signature, digests, install, first launch). The signing run's
   checks in step 2 are not that acceptance.
7. Where the desktop feed is enabled, feed that signing run to **Desktop feed (publish
   signed)** ([UPDATING.md](UPDATING.md)).

If `publish` fails or is re-run for a final, it refuses to make a second draft while any
draft named or tagged `v$V` exists, and prints their ids. Reuse such a draft when step 3's
checks pass for the commit you mean to release (upload the `.deb` by id if it is missing).
Delete a draft only when its target or assets are wrong, then dispatch **Release
(publish)** again. More than one draft for the version is always a stop: delete the extras
after checking which one, if any, is valid.

## The artifacts

Two, both from the merge commit that gets tagged, so their protocol versions agree by
construction rather than by anyone checking:

| Artifact | What it is | Files on the release |
| --- | --- | --- |
| **daemon** | The CLI, bundled to one ESM file. No Electron. | `orca-daemon-X.Y.Z.mjs` |
| **desktop** | The Electron app, with that same daemon build inside it. | `.deb`, `.AppImage`, `.tar.gz`, `.dmg`, `.zip`, `.exe` |

`.github/workflows/desktop.yml` builds both, on `ubuntu-latest`, `macos-latest` and
`windows-latest`. `release-publish.yml` calls it as a reusable workflow against the merge
commit and attaches what comes out; a platform runner failing therefore means no tag, which
is the right way round, since a release page with two of three installers is not something
a later run can fix. The workflow also runs on `workflow_dispatch`; it no longer starts
on pull requests. Manually dispatch it when packaging needs verification before release.
It is deliberately not part of `ci.yml`, which sets
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` and never launches the app.

Architectures: x64 and arm64 everywhere, except the Linux `AppImage`, which is x64 only —
building an arm64 one on an x64 runner needs an arm64 `appimagetool` to run there. arm64
Linux gets the `tar.gz`, which is the same tree without the single-file wrapper.

On Linux the `.deb` (x64 and arm64) is the supported install, and the one to point testers
at: Ubuntu 24.04 and later restrict the user namespaces Chromium's sandbox needs, and only
the package's root install script can load the AppArmor profile that lets
`/opt/ORCA/orca-desktop` make them. The Linux executable, package, command and desktop entry
are all `orca-desktop`, because `orca` is Ubuntu Desktop's screen reader. The archive and the AppImage abort before their first window there (#853).
[INSTALL-LINUX.md](INSTALL-LINUX.md) has the install, the reason and what CI checks.

### The daemon inside the desktop artifact

`packages/app/scripts/build-daemon.js` bundles the *built* CLI (`packages/cli/dist/main.js`)
into `packages/app/dist/daemon/orca-daemon.mjs` with esbuild: one file, every workspace
package and every dependency inlined, no `node_modules` beside it. electron-builder copies
it into the app's resources as `extraResources`, which means beside `app.asar` rather than
inside it — a file inside an asar archive is not a real file to the operating system, and
this one has to be spawned.

The standalone daemon requires Node.js 24 or newer, matching the root `engines`
and esbuild target. The packaged app spawns it with `process.execPath` and
`ELECTRON_RUN_AS_NODE=1`, using Electron's bundled Node rather than a system install.
The pinned Electron 44.4.5 already embeds Node 24.21.0; this floor change needs no
Electron upgrade.

It is spawned, not imported. `packages/app` may only import `@orca/protocol` and
`@orca/design` from the workspace (ADR 0008), and the daemon's dependency graph — the
engine, the stores, the agents — is exactly what that boundary exists to keep out. A
subprocess is also what makes "attach to a daemon somewhere else" a case rather than a
rewrite.

`packages/app/src/main/daemon-process.ts` is the whole of it, and it is Electron-free so
that it has a plain test. On launch the app picks a daemon in this order:

1. **`ORCA_DAEMON_URL`**, if set. Someone who has pointed the app at a daemon has said what
   they want, and starting a second one beside it would only confuse which store is on
   screen.
2. **The bundled daemon**, if the app is packaged. It is started on a port the OS says is
   free, on loopback, and the app waits for it to answer `hello` before the first read goes
   out. A free port can be taken before the daemon binds it, so a failed start is retried on
   a fresh one; a daemon that dies or never answers surfaces as an error carrying its own
   output rather than as a hung window.
3. **`http://127.0.0.1:6722`**, the default `orca serve`. This is the development case, and
   it is also where a packaged app lands when its bundled daemon refuses to start *on
   launch*: the window still opens, on a status bar that reads disconnected, because a
   desktop app that will not open is a worse failure than one that shows you it has no
   daemon. **This step is for the launch only (#269).** A daemon that will not start over a
   store somebody chose in **File ▸ Open a store…** is a failed open, and nothing is fallen
   back to: any daemon answering on the default port is serving a different store, and
   showing its runs under a banner naming the chosen path as read-only is worse than showing
   nothing. The app stays disconnected, with the path and the reason on the console.

The daemon is stopped on `will-quit` — `SIGTERM`, then `SIGKILL` if that is ignored — so it
cannot outlive the window that started it.

**The workspace it serves is `ORCA_WORKSPACE` or a verified first-run selection.** Without
either (and without `ORCA_DAEMON_URL` or a saved endpoint) a packaged app starts no daemon and
opens disconnected for setup (`src/main/index.ts`). Choosing a store from inside the app landed
with #164 — **File ▸ Open a store…** stops that daemon and starts one over the chosen workspace
with `--read-only`, which is an argument to the same spawn module rather than a second
mechanism. The Desktop workflow's packaged-app check sets a disposable `ORCA_WORKSPACE` for
this reason.

### Approved application identity and existing installations

The approved bundle ID is **`com.schadewitz.orca`** and the approved Apple Team ID is
**`Q2FP9UY5T4`** (owner decision, 2026-10-03). The bundle ID is the default `appId` in
`packages/app/electron-builder.yml`. The Team ID is public release configuration for
future signing verification; recording it does not provision credentials, select a
certificate, prove membership or activate signing/notarisation. `mac.identity: null`
and `mac.notarize: false` remain in effect.

| Surface | Effect of the bundle ID change |
| --- | --- |
| macOS | `CFBundleIdentifier` becomes `com.schadewitz.orca`; builder-derived helper bundle IDs follow it. `ORCA.app`, product name, DMG/ZIP targets and artifact filenames are unchanged. OS permissions, notification identity and Keychain access must be checked as a new identity, not assumed to transfer from `dev.orca.desktop`. |
| Windows | Explicit `win.appId: dev.orca.desktop` preserves existing NSIS identity. The locked builder derives the installer GUID from that ID and uses the ID for shortcut AppUserModelID. Install/uninstall registration, installation name and updater cache naming remain stable. A Windows ID migration is deferred to a separate product decision; do not remove this override as cleanup. |
| Linux | The default ID changes; product name and artifact filenames are unchanged. For #853 the executable and desktop entry became `orca-desktop` (was `orca`, which is the GNOME screen reader's package and command on Ubuntu Desktop), and the `.deb` installs to `/opt/ORCA` as package `orca-desktop`. This is not a Debian service/store migration. |
| Application data | Package name `@orca/app` and product name `ORCA` are unchanged. Electron's default `userData` is name-based, not bundle-ID-based; preferences and encrypted run intents stay at the same paths. Workspace selection and `<workspace>/.orca` are unchanged. No files are moved, reset or deleted. |
| Updates | Windows remains on its existing NSIS identity and `latest-ARCH` feed channels. This change does not enable macOS/Linux automatic updates, change feeds or publish artifacts. |

For existing Mac installations, app-name/path continuity is **not** proof of identity
continuity. Before distributing a replacement, validate old-to-new install, notifications,
`orca://` handling, OS permissions and access to `admission-intents.enc` through the
existing OS Keychain on a native Mac. Electron documents that [safeStorage depends on Keychain access and consistent
code signing](https://www.electronjs.org/docs/latest/api/safe-storage); the app already
refuses submission when saved intents cannot be decrypted/verified. Do not delete the
journal or reset the keychain to bypass that refusal. If access cannot be retained, the
upgrade/recovery owner must decide and validate recovery before that migration proceeds.
This configuration change implements no migration or cleanup and makes no native upgrade
acceptance claim. The dated preparation source audits retain the old ID as historical fact.

The compatibility exception follows the builder's [NSIS identity contract](https://www.electron.build/v26/docs/nsis/).
Focused tests resolve IDs and names with the locked builder and compare Linux desktop
entries; they do not substitute for running old and new installers on native systems.

### Signing and notarisation are not done

Both artifacts are **unsigned**, and both platforms say so to the person who downloads
them. This is a follow-up, not an oversight, and it stays written here until it is closed.

- **macOS** shows "ORCA is damaged and can't be opened" or a Gatekeeper refusal, because an
  unsigned app that arrived with a quarantine attribute cannot be opened by double-clicking
  it at all. The way past it today is `xattr -dr com.apple.quarantine /Applications/ORCA.app`,
  which is not something to ask of anyone who is not already a contributor.

  Signing needs an Apple Developer Program membership and, as repository secrets: a
  Developer ID Application certificate exported as base64 `.p12` in **`APPLE_CERTIFICATE_P12`**
  with its passphrase in **`APPLE_CERTIFICATE_PASSWORD`**, and the approved team
  **`Q2FP9UY5T4`** in **`APPLE_TEAM_ID`**. The approved bundle ID is **`com.schadewitz.orca`**.
  Notarisation needs an App Store Connect API key — **`APPLE_API_KEY_ID`**,
  **`APPLE_API_ISSUER`** and the `.p8` itself in **`APPLE_API_KEY`** — or, the older way, an
  Apple ID in **`APPLE_ID`** with an app-specific password in **`APPLE_APP_SPECIFIC_PASSWORD`**.
  With those present, `mac.identity` and `mac.notarize` in `packages/app/electron-builder.yml`
  come off `null`/`false` and the workflow gains a keychain step.

- **Windows** shows a SmartScreen "unrecognised app" warning on the unsigned NSIS installer
  that release assets carry (a signed build comes from `windows-signed.yml` and is distributed
  separately), and may still show warnings after signing starts: a valid signature authenticates a publisher
  but does not guarantee SmartScreen reputation or bypass enterprise policy.

  The [Windows signing runbook](windows-signing-runbook.md) covers publisher choice,
  Azure Artifact Signing eligibility/cost, owner-led enrollment, least-privilege OIDC CI,
  builder 26 compatibility, timestamps, updater publisher matching and native acceptance.
  The proposed cloud route keeps keys service-managed and needs no client secret. A
  publicly trusted CA's cloud/HSM offering is an alternative if Azure is unsuitable;
  self-signed/internal certificates do not establish public publisher trust. No route is
  provisioned or enabled by the runbook.

- **Linux** has nothing to sign against. An AppImage can carry a detached GPG signature, and
  almost nothing verifies one; it is not on the list.

Until that lands, the release notes for a version carrying desktop artifacts should say the
builds are unsigned and how to open them.

## Changelog fragments

`CHANGELOG.md` is rendered, not edited. Its `## Unreleased` section holds a pointer, and
the entries waiting for the next release are files in `changelog.d/`:

```
changelog.d/152-runs-surface.added.md
changelog.d/198-preload-cjs.changed.md
changelog.d/101-leases.store.md
```

`<section>` is `store`, `added`, `changed` or `fixed`, and is the heading the file renders
under; `<issue>` is what the entries are ordered by. The body is the entry verbatim —
bullets with their area prefix, or prose for `store`. Two entries mean two files.

A rendered section is grouped twice: by change type, which is the `<section>`, and inside
that by change target, which is the bullet's area prefix, rendered as `#### app` with the
prefix lifted out of the bullet into the heading. A wave-sized release is fifty bullets
under four headings otherwise, and it is the release pull request — whose body is the
section verbatim — that has to be reviewed that way. Targets render alphabetically, entries
inside one keep their issue order, and a bullet with no prefix renders ungrouped above the
headings, which is how `store` prose comes out as it always has. `changelog.d/README.md`
says what that asks of a fragment.

The point is that a pull request creates a file instead of editing a shared list, so two
pull requests in flight cannot conflict over the changelog — and a dropped fragment is a
missing file rather than a lost merge. `changelog.d/README.md` is the reference.

`prepare` renders the fragments into the dated section and deletes them, so the deletions
land in the `release: vX.Y.Z` pull request beside the section they became. Nothing else
reads `changelog.d/`: `notes <version>` quotes the committed `CHANGELOG.md`, which is what
`release-publish.yml` publishes.

## Versioning

Semantic versioning, with one pre-1.0 rule: while the major version is `0`, a
`release:major` label bumps the **minor** version (`0.1.0` to `0.2.0`), the same as
`release:minor`. Under semver `0.x` promises nothing anyway, and reaching `1.0.0` should
be a decision rather than the side effect of a label.

To release a version the labels would not produce — `1.0.0`, or a release candidate — put
a line in the **milestone description**:

```
Release: v0.3.0-rc.1
```

That overrides the labels. A version with a prerelease suffix is published with
`--prerelease`, so it never becomes the repository's "latest".

### A final is its last candidate

A final release (`0.7.0`) should ship the code of its newest release candidate
(`v0.7.0-rc.N`) plus fixes someone chose on purpose, not whatever merged to `main` after the
candidate was tested. Land those fixes as cherry-picks or say why each one belongs. To make
drift visible, the release pull request for a final compares what the release is built
from (`packages/` with its manifests, `workflows/`, `templates/`, the lockfile and the root
build config and `.github/workflows/desktop.yml`, listed as `DRIFT_PATHS` in
`tools/release-pr-body.js`) with the newest
`v<version>-rc.*` tag and either says nothing changed or shows a warning with the
`git diff --stat` and a comparison link. If the comparison output is missing, the
workflow stops before pushing anything rather than reporting that nothing changed. This only works when candidates are released
through this workflow, so they carry tags. Learned from T3 Code, whose stable release
builds the exact commit its last nightly shipped (#863).

### What counts as breaking

Not the TypeScript API — nothing outside this repository imports it. ORCA's compatibility
surface is what lives on disk and what operators write by hand:

| Surface | Where |
| --- | --- |
| Event log and plan journal schema | `packages/store`, `packages/core/src/events` |
| Artifact index and artifact front matter | `packages/store`, `templates/` |
| Workflow and program YAML schema | `workflows/`, `packages/core/src/schema` |
| `orca.config.yaml` schema | `packages/core/src/config` |
| CLI command and flag names | `packages/cli` |
| Supported Node versions | `engines` in `package.json` |

ORCA is event-sourced, so a change to the first two can invalidate an existing `.orca`
store — the failure mode most likely to bite someone who upgrades, and the one least
likely to be noticed in review. Every release therefore carries a **Store format** section
in the changelog — rendered from the `store` fragments, and saying "No change." when there
are none — and a store-format change is at least a minor bump pre-1.0. "No change." is a
claim the release makes on your behalf: write the fragment when it would be false.

Documentation under `docs/` describes `main`, not the last release. Link docs at the tag
(`/blob/vX.Y.Z/docs/...`) when a release note needs to point at them.

## Rehearsing a release (dry run)

Run **Release (publish)** from the Actions tab with **dry_run** ticked and a branch or
commit as **ref**. The ref must contain `efdaf863` (#862) or be newer: the App smoke
workflow's `linux-native` job is required for a rehearsal as for a release, and it installs
the ref's `.deb` and runs `pnpm run app:linux-native`, which older refs (including rc.2,
`c2e617af`) do not have, so a rehearsal of one fails there. The upgrade launch check is the
one step an older ref may lack; it reports not applicable. It runs every job a real release runs (the full check path, the desktop
artifacts, the smoke and type proof) and then uploads the artifacts to a **draft
prerelease** called `vX.Y.Z-dryrun.<run number>`, where `X.Y.Z` is the ref's
`package.json` version without its prerelease suffix. Nothing is tagged, nothing is
published or marked latest, and no feed step runs. The draft's notes start with a
dry-run warning.

Dispatch it with the workflow from `main` (the "Use workflow from" box); the run refuses
any other. The rehearsed ref is untrusted: its code only ever runs in jobs with a read-only
token and no saved git credentials, and the smoke runs on GitHub-hosted runners, never the
self-hosted ones, without the runner health endpoint; the desktop and smoke jobs pick their
runners with `main`'s tooling, not the ref's. The draft is uploaded by a separate job that
checks out `main`'s workflow revision, validates the version and commit, and treats the
artifacts as data. A ref from before the upgrade launch check reports it as not applicable.

A real (non-dry-run) release refuses any commit that is not on `main`, and a manual one must
also be dispatched with `main`'s workflow: its publish job runs the released commit's own
tooling with a write token, so that commit has to be reviewed. Any commit on `main`
qualifies, so fixing forward after a failed publish still works.

Use it before merging a release pull request, or to try a risky change through the
release graph before it lands. A failure costs nothing, unlike a failed `release-publish`
after merge, which leaves a bump on `main` with no tag. Delete the draft when you are done
(`gh release delete vX.Y.Z-dryrun.N`). Learned from T3 Code's preview release train (#863).

## Doing it by hand

The workflow is a wrapper around `tools/release.js`, which is offline and has no
dependencies:

```bash
node tools/release.js version --bump minor    # print the next version
node tools/release.js notes --unreleased      # print what changelog.d/ holds
node tools/release.js prepare 0.2.0           # bump package.json, render the fragments
node tools/release.js notes 0.2.0             # print that release's notes
```

`prepare` refuses to run when `changelog.d/` is empty — a release whose notes nobody wrote
is worse than no release — and when `## Unreleased` has picked up entries written by hand,
which its rewrite would otherwise throw away.

To release without closing a milestone, run **Release (prepare)** from the Actions tab
with a milestone number. To skip the automation entirely, do the three commands above,
merge the result, and `gh release create vX.Y.Z --notes-file <(node tools/release.js notes X.Y.Z) --generate-notes`.

## Repository settings this depends on

- **Settings → Actions → General → Workflow permissions**: "Allow GitHub Actions to create
  and approve pull requests" must be on, or `release-prepare.yml` cannot open its PR.
- **Labels**: `release`, `release:major`, `release:minor`, `release:patch`, `release:none`.
- The repository is private, so releases are visible to collaborators only. The optional
  authenticated HTTPS feed distributes desktop updates without exposing the repository; see
  [UPDATING.md](UPDATING.md).
- The release carries the daemon and desktop artifacts described above, built by
  `desktop.yml` on three platform runners. The `hello` handshake still carries the protocol
  version, because a desktop build will eventually attach to an older daemon on another
  machine — the bundling makes the two agree on the day of the release, not forever.
- Signing secrets, when signing lands: the names are in "Signing and notarisation are not
  done" above. `desktop.yml` is called by `release-publish.yml`, so a reusable-workflow
  `secrets:` block is where they will have to be passed through.

### Release type proof

`release-publish.yml` calls `app-smoke.yml` with the release merge SHA. Publication depends
on both its Linux Electron smoke check and the Linux/macOS/Windows type-proof matrix. A
missing or changed baseline blocks tagging and leaves the report available for review; the
release workflow never updates snapshots. Follow the deliberate screenshot review procedure
in `docs/DEVELOPMENT.md` before retrying. The proof still uses the dev-only `#type` route;
this does not make that route part of the shipped renderer.

## v0.6.0 update distribution

[UPDATING.md](UPDATING.md) documents Windows private HTTPS authentication, initial install,
Debian wrapper/service bootstrap, compatibility markers and recovery. Windows builds now
include architecture/channel-specific metadata and blockmaps; packaging never publishes.
The final job validates both feeds and uploads assets to a draft before publishing, then
optionally activates the private HTTPS feed through a separately provisioned SSH account.
This replaces the older statement that distribution requires making the repository public.
Repository credentials stay with GitHub Actions/`gh`; clients use read-only feed credentials.
The signing setup above remains unproven and unsigned Windows installs require an explicit
bootstrap trust decision. Do not describe unit tests as packaged-update or signing evidence.

Review `release-compatibility.json` with every store-format change. A changed epoch blocks
automatic Debian activation and recovery across that boundary; a binary-only rollback is
not a store migration. Runtime version, protocol, capabilities and store epoch are checked
before managed work is admitted.
