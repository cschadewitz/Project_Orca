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
   and releasing never has to reconstruct them from commit subjects. CI fails a pull request
   that changes `packages/` and adds no fragment, unless it carries the `no-changelog` label.
   `changelog.d/README.md` has the naming and the four sections; `node tools/release.js notes
   --unreleased` renders what is pending.
3. When the work is done, **close the milestone**. `release-prepare.yml` checks that no
   issue in it is still open, takes the highest bump label, computes the next version, and
   opens a `release: vX.Y.Z` pull request that bumps `package.json`, renders the fragments
   into a dated changelog section and deletes them.
4. Review that pull request. Its body is the release body verbatim — to change the notes,
   edit `CHANGELOG.md` on the release branch.
5. **Merge it.** `release-publish.yml` re-runs typecheck, lint, format, tests, build and
   the compiled-CLI smoke test against the merge commit, runs the reusable desktop smoke
   and three-platform type-proof checks against that same commit, builds the desktop and daemon
   artifacts from that same commit (`desktop.yml`, below), then tags `vX.Y.Z` and publishes
   the release with the changelog section as its body, the artifacts attached, and GitHub's
   generated list of merged pull requests appended underneath.

Closing a milestone stops at a pull request on purpose. A milestone can be closed by
accident and reopened; a published tag cannot be unpublished cleanly. One merge click is
the whole cost of that safety.

**The release pull request shows no CI checks.** GitHub does not start a workflow run from
an event created with `GITHUB_TOKEN`, so the PR that `release-prepare.yml` opens never
triggers `ci.yml`. That is why `release-publish.yml` re-runs the full check set against
the merge commit before it tags: the verification happens, just after the merge rather
than before it. If `release-publish.yml` fails, the version bump is on `main` with no tag
against it — fix forward, then run **Release (publish)** from the Actions tab against
`main` (or the fixed commit). It publishes whatever version that commit's `package.json`
holds, through the same checks, builds and tag step, and refuses if the tag already
exists. Re-running the failed run is not the same thing: a re-run uses the workflow files
of the commit it first ran on, so a fix to the workflows never reaches it; and closing the
milestone again cannot help, since `prepare` refuses to bump to a version `main` already
carries. Giving `release-prepare.yml` a personal
access token instead of `GITHUB_TOKEN` would move the checks back onto the PR, at the cost
of a token to store and rotate; that trade is only worth making if `main` ever gains
required status checks.

## The artifacts

Two, both from the merge commit that gets tagged, so their protocol versions agree by
construction rather than by anyone checking:

| Artifact | What it is | Files on the release |
| --- | --- | --- |
| **daemon** | The CLI, bundled to one ESM file. No Electron. | `orca-daemon-X.Y.Z.mjs` |
| **desktop** | The Electron app, with that same daemon build inside it. | `.AppImage`, `.tar.gz`, `.dmg`, `.zip`, `.exe` |

`.github/workflows/desktop.yml` builds both, on `ubuntu-latest`, `macos-latest` and
`windows-latest`. `release-publish.yml` calls it as a reusable workflow against the merge
commit and attaches what comes out; a platform runner failing therefore means no tag, which
is the right way round, since a release page with two of three installers is not something
a later run can fix. The workflow also runs on `workflow_dispatch`, and on a pull request
that touches the packaging itself — the config, the spawn module, the build scripts or the
lockfile. It is deliberately not part of `ci.yml`, which sets
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` and never launches the app.

Architectures: x64 and arm64 everywhere, except the Linux `AppImage`, which is x64 only —
building an arm64 one on an x64 runner needs an arm64 `appimagetool` to run there. arm64
Linux gets the `tar.gz`, which is the same tree without the single-file wrapper.

### The daemon inside the desktop artifact

`packages/app/scripts/build-daemon.js` bundles the *built* CLI (`packages/cli/dist/main.js`)
into `packages/app/dist/daemon/orca-daemon.mjs` with esbuild: one file, every workspace
package and every dependency inlined, no `node_modules` beside it. electron-builder copies
it into the app's resources as `extraResources`, which means beside `app.asar` rather than
inside it — a file inside an asar archive is not a real file to the operating system, and
this one has to be spawned.

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

**The workspace it serves is `ORCA_WORKSPACE`, or the user's home directory.** That is a
placeholder with a known shape rather than an answer: `orca serve` reads `<dir>/.orca` and
answers an empty run list for a directory that has no store, so a packaged app with no
`ORCA_WORKSPACE` set opens connected to a daemon that has nothing to show. Choosing one from
inside the app landed with #164 — **File ▸ Open a store…** stops that daemon and starts one
over the chosen workspace with `--read-only`, which is an argument to the same spawn module
rather than a second mechanism — so the placeholder is now only the directory the app *starts*
on.

### Signing and notarisation are not done

Both artifacts are **unsigned**, and both platforms say so to the person who downloads
them. This is a follow-up, not an oversight, and it stays written here until it is closed.

- **macOS** shows "ORCA is damaged and can't be opened" or a Gatekeeper refusal, because an
  unsigned app that arrived with a quarantine attribute cannot be opened by double-clicking
  it at all. The way past it today is `xattr -dr com.apple.quarantine /Applications/ORCA.app`,
  which is not something to ask of anyone who is not already a contributor.

  Signing needs an Apple Developer Program membership and, as repository secrets: a
  Developer ID Application certificate exported as base64 `.p12` in **`APPLE_CERTIFICATE_P12`**
  with its passphrase in **`APPLE_CERTIFICATE_PASSWORD`**, and the team in **`APPLE_TEAM_ID`**.
  Notarisation needs an App Store Connect API key — **`APPLE_API_KEY_ID`**,
  **`APPLE_API_ISSUER`** and the `.p8` itself in **`APPLE_API_KEY`** — or, the older way, an
  Apple ID in **`APPLE_ID`** with an app-specific password in **`APPLE_APP_SPECIFIC_PASSWORD`**.
  With those present, `mac.identity` and `mac.notarize` in `packages/app/electron-builder.yml`
  come off `null`/`false` and the workflow gains a keychain step.

- **Windows** shows a SmartScreen "unrecognised app" warning on the NSIS installer, and will
  keep showing it for a while after signing starts: SmartScreen reputation is earned per
  certificate over downloads, not granted by a signature.

  Signing needs a code-signing certificate. Microsoft now requires the private key on an
  HSM, so the practical routes are a cloud signing service — Azure Trusted Signing, which
  wants **`AZURE_TENANT_ID`**, **`AZURE_CLIENT_ID`** and **`AZURE_CLIENT_SECRET`** — or a
  token-backed certificate, which does not fit a hosted runner. A plain `.pfx` in
  **`WINDOWS_CERTIFICATE_PFX`** with **`WINDOWS_CERTIFICATE_PASSWORD`** still works for a
  self-signed or internal CA certificate, which is enough to test the plumbing and nothing
  more.

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
