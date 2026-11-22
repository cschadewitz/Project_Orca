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

1. **Automatic** while the repository variable `ORCA_RELEASE_AUTO_SIGN` is `true` (off by
   default): the same run's `sign` job dispatches **Windows signed (spike)** from `main` with
   `source_sha` set to `SHA` (while `main` still matches it outside notes, docs and
   workflows; later product drift on `main` makes the source check refuse it). Dispatching
   changes no protection: the signed run still waits on whatever the `windows-signing`
   environment requires. Removing its required reviewer is a separate setting (the owner
   chose no reviewer, main only, on 2026-11-21).
2. The signing run itself checks Authenticode status `Valid`, a timestamp, the expected
   publisher, and that `latest-x64.yml` `files[0]` (`url`, `size`, base64 **SHA-512**)
   describes exactly `ORCA-$V-win-x64.exe`.
3. **Automatic** (same switch): when it succeeds, **Release (attach signed installer)**
   (`release-attach-signed.yml`, `tools/deploy/release-attach.sh`) first checks the signing
   run itself: a successful `windows-signed.yml` run of this repository, dispatched from
   `main`, with exactly one unexpired signed artifact. It finds the one final draft targeting
   `SHA`, re-checks both installers' (x64 and arm64) signature, timestamp and publisher,
   records the run and each installer's digest in the draft's notes, then uploads them by id
   (x64 first) and reads them back. Before each write it re-reads that exact draft (still a
   draft, same target and name, only the `.deb`, `.deb` + x64 `.exe` or `.deb` + both
   `.exe`s, no other run's record) and stops if anything changed.
   Because the record comes first, an interrupted upload is resumed with the same run, and a
   later signing run of the same commit is refused. A reconcile every 6 hours re-dispatches
   the attach for any final draft missing an installer or record (the recorded run if there
   is one), which also adds arm64 to a draft attached x64-only; an installer attached by hand
   without a record is left alone. A rerun is a
   no-op; different bytes under the same name stop it. Its summary gives the installer's **SHA-256**. To check by hand:
   `gh api repos/$R/releases/$ID --jq '{draft, name, tag_name, target_commitish, assets: [.assets[] | {name, digest}]}'`
   must show `draft: true`, `name: "v$V"`, `target_commitish` equal to `SHA`, and exactly the
   `.deb` and the two `.exe`s (plus the three server bundle files of step 3a). `tag_name` may
   read `v$V` or `untagged-…`; step 6 sets it.
3a. **Automatic, from the 0.8 line on** ([The server bundle](#the-server-bundle)): the same Release (publish) run's `server-bundle` job dispatches
   **Release (server bundle)** (`release-server-bundle.yml`) for `SHA`, which builds, signs,
   checks and attaches the headless server bundle ([The server bundle](#the-server-bundle))
   and records it in the draft's notes. A reconcile every 6 hours re-dispatches it for any
   release newer than Latest without that record. Step 6 refuses a final from that line without it.
4. If either automatic step did not run (the switch is off, or the signing run was refused),
   dispatch **Windows signed (spike)** for `SHA` by hand, then **Release (attach signed
   installer)** with that run's id (`signed_run_id`); with the switch on the attach follows
   on its own. Attaching entirely by hand (no record, so the feed must then be dispatched by
   hand too) is
   `gh api -X POST -H 'Content-Type: application/octet-stream' "https://uploads.github.com/repos/$R/releases/$ID/assets?name=ORCA-$V-win-x64.exe" --input <file>`.
5. Run native acceptance on the exact staged bytes before anything is public: the signed
   x64 `.exe` and the Ubuntu amd64 `.deb`, each with a digest equal to what step 3's check
   shows on the draft (signature, install, first launch, a built-in sample, reopen). The
   signing run's checks in step 2 are not that acceptance. If either fails, stop: the draft
   stays a draft and nothing is public.

   The arm64 `.exe` is accepted **automatically** (#889): when the attach completes,
   **Release (accept Windows arm64)** (`release-accept-arm64.yml`) downloads the draft's
   exact arm64 bytes, and on a GitHub-hosted Windows arm64 machine re-checks the signature,
   installs it silently over the newest earlier published final that has an arm64 installer
   (a fresh install only when the full release list, read successfully, has none), checks
   the reported version, that the installed `ORCA.exe` is a signed ARM64 binary, and that
   the app starts and reaches a live connection to its bundled daemon. Only then does it
   keep an `arm64-acceptance-evidence` artifact (release id, version, commit, digest, mode,
   prior version and digest; 90 days) and record `<!-- orca-arm64-accepted: RUN sha256:… -->`
   in the draft's notes, pointing at that run. It retries after every attach run (including
   the 6-hourly reconcile) and can be dispatched from `main` with a `release_id`. If it keeps
   failing and the release must not wait, dispatch it with `x64_only` and the `release_id`:
   that records `<!-- orca-x64-only -->` in the draft and removes its arm64 installer, and
   attach, reconcile, acceptance, publication and the feed all keep to that decision.
6. Publish by dispatching **Release (publish final)** (`release-publish-final.yml`) from
   `main` with `release_id=$ID`, `version=$V`, and what step 5 accepted: `source_sha=$SHA`,
   `deb_sha256` and `exe_sha256` (the digests of the exact files that passed). Immediately
   before publishing it compares all of them with the draft: still a draft, named `v$V`,
   targeting `SHA`, exactly those two assets with those digests, and the installer's digest
   equal to the signing record. It also needs either the arm64 installer the same signing
   run recorded, with acceptance verified against the acceptance run and its evidence
   (`tools/deploy/feed-arches.js verify`), or the x64-only decision with no arm64 installer,
   and, from the 0.8 line, the server bundle with its receipt ([The server bundle](#the-server-bundle)): the three
   files with exactly the digests its one record names, the signed manifest naming this
   version, commit and archive digest, and a successful receipt job of the recorded Release
   (server bundle) run committing to this release id, version, commit and those digests. It refuses a version that is not newer than the current
   Latest and an existing tag at another commit, publishes with the tag and target stated
   explicitly, and reads back the published digests, the tag and Latest. It shares one queue
   with the attach, so the two never interleave; publish only through it, not by editing the
   draft by hand.
7. Where the desktop feed is enabled, publishing feeds that signing run automatically
   (step 6 dispatches **Desktop feed (automatic)**, which dispatches **Desktop feed (publish signed)**; see
   [UPDATING.md](UPDATING.md)). Check that run went green.

If `publish` fails or is re-run for a final, it refuses to make a second draft while any
draft named or tagged `v$V` exists, and prints their ids. Reuse such a draft when step 3's
checks pass for the commit you mean to release (upload the `.deb` by id if it is missing).
Delete a draft only when its target or assets are wrong, then dispatch **Release
(publish)** again. More than one draft for the version is always a stop: delete the extras
after checking which one, if any, is valid.

### The server bundle

From the 0.8 release line (`SERVER_FROM=0.8.0` in `tools/deploy/release-attach.sh`: the 0.8.0
release candidates and every final from 0.8.0 on), every real release also carries a prebuilt
headless server (#876), for servers that should install and update without a toolchain, `gh`
or a clone. Releases before it (0.7.x, including 0.7.1) keep their approved desktop asset set:
nothing is dispatched, reconciled or required for them, and server files on such a draft are
unexpected assets.

| File | What it is |
|---|---|
| `orca-server-X.Y.Z-linux-x64.tar.xz` | One directory: `orca-daemon.mjs` (the CLI, daemon and ACP facade, bundled by `build-daemon.js --server`), the two programs it starts beside itself (`native-io-worker.js`, `scripted-agent/main.js`), `runtime/bin/node` (the Node 24 the release workflow built with, and its licence), the shipped `workflows/` and `templates/`, `release-compatibility.json` and `orca-server.json`. |
| `orca-server-X.Y.Z-linux-x64.manifest.json` | Version, source commit, the archive's name, size and **SHA-256**, the entry, the Node version and the compatibility contract. This is the file that is signed. |
| `orca-server-X.Y.Z-linux-x64.manifest.json.sigstore.json` | The manifest's Sigstore bundle: a keyless cosign signature with its short-lived certificate and transparency-log entry. |

**Release (server bundle)** (`release-server-bundle.yml`) produces them, unattended, from
`main`: it confirms the release `vX.Y.Z` targets the commit and the commit is on `main`, builds
that commit, assembles the archive (`tools/deploy/server-bundle.py`, deterministic for its
inputs), signs the manifest with `cosign sign-blob` using the job's GitHub OIDC identity (no
key exists anywhere to store, rotate or leak), stages the signed files with
`orca-release.py stage --bundle` inside a `python:3.12-slim` container that has no `gh`, `git`,
`mise`, `pnpm` or Node, and only then attaches them by release id and records their digests in
the release notes (`<!-- orca-server-run: RUN archive manifest signature -->`).

The expected signer is recorded in `tools/deploy/orca-release.py` (`BUNDLE_SIGNER` and its
neighbours): the certificate must name
`https://github.com/cschadewitz/Project_Orca/.github/workflows/release-server-bundle.yml@refs/heads/main`,
issuer `https://token.actions.githubusercontent.com`, trigger `workflow_dispatch`. A pull
request's runs carry a `refs/pull/…` identity and can never match. Moving or renaming the
workflow is therefore a change to that constant in the same pull request, and servers
verify with the adapter they have installed, so update the adapter on servers first.

**Timing.** A final stays a draft until its bundle is attached: Release (publish final)
refuses it without the bundle's **receipt**, which it checks right before publishing. The
receipt is the one well-formed record (a missing record waits; a duplicate or malformed one
is a stop to fix by hand, and is never written over), the three files with exactly the
recorded digests, the signed manifest itself naming this version, commit and archive digest,
and the recorded run: a successful Release (server bundle) dispatch from `main` of this
repository whose run name is `Release (server bundle) vX.Y.Z at SHA`, whose signing and
clean-host jobs passed, and whose attach job passed under the name
`server bundle receipt: release ID vX.Y.Z SHA sha256:R`. `R` is the SHA-256 of
`orca-server-receipt/1 release=ID version=X.Y.Z sha=SHA files=A M S` (the three files' digests,
`sha256:`-prefixed, archive first), computed by the clean-host job from the exact files it
verified, only after it passed; the attach job uploads only files with those digests. So the
receipt is evidence from the trusted run itself, independent of the notes and the draft. A **release candidate** is different: it is published as
soon as Release (publish) finishes, and its bundle is attached asynchronously by the run that
job dispatches (normally within half an hour). Until the record is in its notes the rc has no
usable bundle, and `orca-release.py stage --bundle` refuses it with "no complete server bundle
yet". Check with
`gh release view vX.Y.Z-rc.N --json body,assets --jq '[(.body | test("orca-server-run")), [.assets[].name | select(startswith("orca-server-"))]]'`.

Dry runs build no server bundle: a rehearsed ref is untrusted and is never signed.
linux-arm64 is deferred; the bundle is linux-x64 only.

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

### Signing and notarisation

The ordinary builds from `desktop.yml` and the release job are **unsigned** on every
platform. Windows finals are signed in a separate lane (`windows-signed.yml`) and only that
signed installer is released; macOS signing and notarisation are not done yet, and stay
written here until they are.

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

- **Windows**: the NSIS installers the ordinary release job and `desktop.yml` build are
  unsigned CI output and are never a final's download. The supported installer for a final
  is the one `windows-signed.yml` signs for the release commit, attached to the draft before
  publication ([Publishing a final](#publishing-a-final)). A valid signature authenticates
  the publisher but does not guarantee SmartScreen reputation or bypass enterprise policy.

  The [Windows signing runbook](windows-signing-runbook.md) covers publisher choice,
  Azure Artifact Signing eligibility/cost, owner-led enrollment, least-privilege OIDC CI,
  builder 26 compatibility, timestamps, updater publisher matching and native acceptance.
  A publicly trusted CA's cloud/HSM offering is an alternative if Azure is unsuitable;
  self-signed/internal certificates do not establish public publisher trust.

- **Linux** has nothing to sign against. An AppImage can carry a detached GPG signature, and
  almost nothing verifies one; it is not on the list.

Release notes say which downloads are signed and supported; a prerelease's page carries
unsigned CI output and its notes must say not to install that output.

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
(Since #856 the feed is the R2 Worker fed only from signed runs; since #865 a final's
Windows download is the signed installer, so no unsigned bootstrap is part of a final.) Do
not describe unit tests as packaged-update or signing evidence.

Review `release-compatibility.json` with every store-format change. A changed epoch blocks
automatic Debian activation and recovery across that boundary; a binary-only rollback is
not a store migration. Runtime version, protocol, capabilities and store epoch are checked
before managed work is admitted.
