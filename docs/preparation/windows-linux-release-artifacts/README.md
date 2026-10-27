# Windows/Linux release-artifact test plan (preparation)

Preparation for [#772](https://github.com/cschadewitz/Project_Orca/issues/772). Prepared
from main `4d5176c8d57c37f974517900935e6e28ea234082` on 27 October 2026.

This plan **does not choose a release version and does not designate any artifact as the
final candidate.** Candidate acceptance is coordinated separately, and the overarching
release checklist belongs to the owner of [RELEASING.md](../../RELEASING.md); this document
supplies the Windows/Linux artifact part of it. macOS and Apple Silicon work is excluded
throughout (see the `ship-group:native-mac-beta` issues).

Owned by this preparation: this document, the helpers in
[`tools/package-validation/`](../../../tools/package-validation/README.md) and their tests in
[`tools/test/package-validation/`](../../../tools/test/package-validation/inspect.test.js). Application and
updater behaviour, release workflows, `docs/RELEASING.md`, lockfiles,
`release-compatibility.json` and the active observer are not changed.

## What earlier work established, and what it left open

| Source | Established | Explicitly not established |
| --- | --- | --- |
| [#714](https://github.com/cschadewitz/Project_Orca/pull/714) electron-updater 6.8.11 | Real installed-library fixtures for cache, multipart, differential/fallback download, checksum and publisher-refusal dispatch, with owned Node HTTP and a stubbed Authenticode check | Native signed/installed Windows acceptance, App smoke, any actual install or update |
| [#720](https://github.com/cschadewitz/Project_Orca/pull/720) electron-builder 26.18.0 / Vite 8.3.5 | A real unsigned Linux x64 tarball: ASAR production closure, no dev-package leaks, daemon resource byte-equal to the build, eight fonts present; NSIS payload/blockmap probes on synthetic executables | Browser `file://` rendering and CSP enforcement, Electron App smoke, native Windows installed/signature acceptance |
| [UPDATING.md](../../UPDATING.md) | The Windows explicit check → download → restart contract and the failed-update recovery contract from #660/#677 | "Source/fixture tests do not establish packaged Windows/NSIS update success" |

The gaps in the right-hand column are what this plan's runtime procedures are for. The
static helper only re-establishes, for a specific candidate, what can be read from bytes.

## Evidence classes

Keep these separate in any report. Evidence from one class never stands in for another.

| Class | Where it can run | What it can establish | What it cannot |
| --- | --- | --- | --- |
| **S — static inspection** | Any host with Node ≥ 24 and Git, offline | Artifact bytes match the candidate manifest; archive/ASAR contents, bundled daemon path and version stamp, native resource architecture and manifests, CSP text, fonts, update metadata and blockmap shape agree with each other and with the source checkout | Anything about running, installing, signing or trust |
| **L — Linux runtime** | Disposable Linux VM or container with a display (Xvfb), x64 and arm64 | Launch, bundled daemon spawn, rendering, fonts, CSP enforcement, logs, shutdown of the tarball and AppImage | Anything about Windows |
| **W — Windows native runtime** | Disposable Windows VM (snapshot), x64 and arm64 | NSIS install/uninstall, launch, rendering, logs, shutdown | Signing or publisher trust when the installer is unsigned |
| **T — signing and trust** | Native Windows, with provisioned signing only | Authenticode validity, publisher identity, SmartScreen behaviour | Nothing while builds are unsigned: record "unsigned" |
| **U — update** | Disposable Windows VM plus a disposable HTTPS feed | The N→N+1 cycle, failure/recovery and rollback behaviour of the shipped updater | Linux/macOS updating (not shipped), Debian deployment updates (separate owner) |

Current builds are **unsigned** ([RELEASING.md](../../RELEASING.md#signing-and-notarisation-are-not-done)).
Until signing is provisioned, class T has exactly one valid result per installer: *unsigned*.
Do not create, import or trust a certificate to produce a different one.

## Inputs: the candidate manifest

Every run starts from an explicit candidate manifest. Paths and hashes are inputs; nothing
is discovered or defaulted.

```json
{
  "format": 1,
  "commit": "<full 40-character commit the artifacts were built from>",
  "version": "<version stamped into the artifacts>",
  "artifacts": {
    "ORCA-<version>-linux-x64.tar.gz": "<sha256>",
    "orca-daemon-<version>.mjs": "<sha256>"
  }
}
```

1. Record the producing workflow run: repository, workflow file, run id and attempt, the
   run's head commit, and the GitHub artifact names and digests. This is the only link from
   artifact to commit: **no commit is embedded in the artifacts**. The `version` field is
   the only identity stamped into them.
2. Download each artifact into a **new, empty directory** used for nothing else. Treat
   the contents as untrusted data: never run tools from inside that directory.
3. Compute SHA-256 twice, independently (for example `sha256sum` on Linux and
   `Get-FileHash -Algorithm SHA256` on Windows), and write the manifest only from values
   that agree. Store the manifest with the evidence before inspecting anything.
4. List every file the candidate consists of. Partial inspection is allowed only with an
   explicit flag and is reported as incomplete.

The manifest names a candidate under test. It is not a statement that the candidate is
final or accepted.

## S — static inspection

```sh
git -C <checkout> checkout --detach <commit>     # exactly the manifest commit, clean
node <checkout>/tools/package-validation/inspect.js \
  --candidate <evidence>/candidate.json --source <checkout> \
  --artifact <download>/ORCA-<version>-linux-x64.tar.gz \
  --artifact <download>/... \
  --out <evidence>/static-report.json
```

Run it with the helper from the same checkout it compares against, or from a reviewed
newer checkout passed a `--source` at the candidate commit. Exit status 0 is
`consistent`, 1 is `refused` (the report says why), 2 is a usage error. An existing
`--out` file is never overwritten. The helper reads bytes and the Git checkout; it writes
only the report and a temporary copy of the Windows native-addon files (deleted on exit)
so the packaging hook's own manifest check can run unchanged.

It refuses, rather than skips, when:

- the checkout is not exactly the manifest commit, or has local changes under
  `package.json`, `packages/app` or `packages/design/fonts`;
- the root `package.json` version, the manifest version, an ASAR `package.json` version or
  a bundled/standalone daemon's version stamp differ;
- a supplied file is not named in the manifest, its SHA-256 differs, or a manifest file is
  not supplied (unless `--allow-partial`);
- update metadata names an installer or blockmap that was not supplied;
- a file name is a macOS artifact or anything else it does not recognise.

| Requirement | Static check (report `checks` names) |
| --- | --- |
| Artifact-to-commit identity | Manifest SHA-256 for every file; source at manifest commit; version agreement across manifest, source, ASAR and daemon |
| Archive contents | Every tar/zip member and link contained in the archive root; one `resources/app.asar`; Linux `orca` ELF / Windows `ORCA.exe` PE for the named architecture |
| ASAR contents | Recorded per-file SHA-256 integrity; `asar-has:*` entrypoints; `asar-excludes:*` source maps, `.d.ts`, build state, `dist/daemon|release|diagnostics-native`, native addons, development packages; `asar-dependency:*` for each declared production dependency |
| Native dependencies and resources | `electron-runtime:*` presence; Windows `native-diagnostics:*` — exactly three `.node` PE32+ DLLs for the architecture plus a manifest that passes the packaging hook's closed check against the source; Linux has no `resources/native` |
| Bundled daemon | Exactly one file under `resources/daemon/`, at `orca-daemon.mjs`, with one version stamp equal to the candidate; byte-identical across one runner's outputs (Linux tarballs and the standalone `.mjs`; the two Windows zips) |
| Fonts | Every `packages/design/fonts/*.woff2` byte-identical in the packaged renderer, and no extra faces |
| CSP | Packaged `index.html` CSP equal to the source's, no `unsafe-*` or wildcard, no inline or remote script, every local reference present |
| Window hardening | `contextIsolation: true` and `sandbox: true` present in packaged main — static text only |
| Installer, metadata, blockmap | PE image; Authenticode table *absent → unsigned* or *present → unverified*; `latest-ARCH.yml` channel, version, path, SHA-512 and size equal the supplied installer; blockmap chunks cover the installer exactly |
| AppImage | ELF runtime for x64 and a squashfs payload marker; contents not inspected |

Recorded, not judged: entry counts, ASAR and header digests, daemon digests per artifact
(Linux vs Windows builds come from different runners and may legitimately differ),
`app-update.yml` feed URL and whether `publisherName` is present, the Linux
`chrome-sandbox` mode, and declaration files that ship.

### Self-check on a local, non-candidate build

To check the helper against real electron-builder output rather than only fixtures, an
unsigned Linux x64 `tar.gz` and AppImage were built locally from `4d5176c` with the
repository's unmodified `electron-builder.yml`, Electron 44.9.1, Node 24.21.0 and
`--publish never`, stamped 0.6.0 as `desktop.yml` would. These are local validation
outputs only; they were not uploaded and are not a candidate. The helper reported all three
supplied files (tarball, AppImage, standalone daemon) `consistent`: 1,618 tar entries;
1,475 ASAR files with matching recorded integrity; 24 production packages; eight fonts; CSP
equal to source; daemon stamp `0.6.0`, byte-identical in the tarball and standalone file.
It also recorded:

- `dist/preload/index.d.cts` and dependency typings ship, because `files` excludes only
  `*.d.ts`. Harmless; noted for the packaging owner, not changed here.
- `chrome-sandbox` is mode `755` in the archive, not setuid. The Chromium sandbox then
  depends on unprivileged user namespaces on the target host (see L1).
- `app-update.yml` names the deliberately unusable `https://updates.invalid/` and has no
  `publisherName`.
- electron-builder also writes `latest-linux.yml`; `desktop.yml` does not upload it.

No Windows zip or installer could be built here: Windows packaging requires the MSVC-built
native diagnostics addons. Windows static checks are therefore exercised only on synthetic
fixtures until run on real candidate output.

## Runtime procedures (not run in this preparation)

Each procedure runs only in a **disposable** environment created for it and discarded
afterwards: a VM restored from a clean snapshot, or a fresh container. None runs on a
workstation, against a real workspace, over an existing installation, or with production
feed credentials. Stop and record "blocked" rather than changing a security setting
(sandbox sysctls, SmartScreen, Defender, execution policy, certificate stores) to proceed.

Common prerequisites for every runtime procedure:

- The static report for the same manifest is `consistent` for the artifact under test.
- The artifact is copied into the disposable environment and its SHA-256 recomputed there
  and recorded.
- Nothing listens on `127.0.0.1:6722` (the development default the app may fall back to on
  launch; a daemon there would be a different store). Record the check.
- `ORCA_DAEMON_URL`, `ORCA_UPDATE_URL` and `ORCA_UPDATE_TOKEN_FILE` are unset unless the
  procedure sets them. `HOME`/`%USERPROFILE%` and the profile belong to the disposable
  environment, so the app's default workspace (the home directory) is disposable too.
- A synthetic workspace: an empty directory, or one populated with the candidate's standalone
  daemon, which is the whole CLI: `node orca-daemon-<version>.mjs demo --dir <path> --keep`
  (scripted agents, no LLM). No
  real store, credentials or agent installations.

Common evidence layout, one directory per candidate commit:

```
<commit>/candidate.json            the manifest
<commit>/static-report.json        inspect.js output
<commit>/<procedure>-<os>-<arch>/  env.txt  hashes.txt  app.log  processes-*.txt  screenshots/  notes.md
<commit>/SHA256SUMS                over every file above
```

`env.txt` records OS build, architecture, display/DPI, Electron and Node versions reported
by the app, the user-namespace or SmartScreen state as found (not changed), and the time
zone. Never retain feed tokens, bearer headers, personal paths outside the disposable
environment, or real workspace contents.

### L1 — Linux tarball: clean launch, bundled daemon, logs, shutdown

- **Applies to:** `ORCA-<version>-linux-x64.tar.gz` and `-linux-arm64.tar.gz`, each on its
  own architecture.
- **Prerequisites:** a display (`xvfb-run`) and unprivileged user namespaces available as
  provisioned (`unshare --user --map-root-user true` succeeds). If they are not, record
  blocked; do not add `--no-sandbox` or change sysctls.
- **Effects:** extracts into a new directory; creates one profile directory and one
  workspace directory; starts the app and its daemon child; writes only inside those
  directories and the disposable `HOME`.
- **Steps:**
  1. `mkdir -p "$RUN/app" "$RUN/profile" "$RUN/workspace"`, extract the tarball into
     `$RUN/app`, and record `sha256sum` of `orca`, `resources/app.asar` and
     `resources/daemon/orca-daemon.mjs`. They must equal the static report's digests.
  2. **First launch, no workspace set:** `setsid xvfb-run -a "$RUN/app/<root>/orca"
     --user-data-dir="$RUN/profile" >"$EVIDENCE/app-first.log" 2>&1 &`. Record whether the
     window opens on first-run setup (disconnected) or starts the bundled daemon.
     `packages/app/src/main/index.ts` says the packaged app without an explicit target or
     verified selection opens disconnected for setup; `desktop.yml`'s launch step expects a
     listening line in the same situation. Record which this candidate does; do not resolve
     the difference by assumption. Then close it as in step 5.
  3. **Launch with `ORCA_WORKSPACE="$RUN/workspace"`**, same command, logging to
     `app.log`.
  4. Observe within 60 s: a `[daemon]` line `orca daemon <version> listening on
     http://127.0.0.1:<port> (protocol <major.minor>)` with the candidate version;
     `ps -o pid,ppid,args -g <pgid>` shows the daemon child whose arguments include
     `<root>/resources/daemon/orca-daemon.mjs` (from the extracted tree, never another
     path) and whose environment (`/proc/<pid>/environ`) includes `ELECTRON_RUN_AS_NODE=1`;
     the status bar reads connected; `ss -ltnp` shows the port on loopback only.
  5. **Graceful shutdown:** close the window (or send `SIGTERM` to the main process only).
     Expected: the main process exits within 10 s (`SHUTDOWN_DEADLINE_MS`), the daemon child
     is gone, the port is closed, and no `orca-daemon.mjs` process remains. Record the exit
     status and timings. A leftover child is a failure; kill it only after recording it.
- **Logs to retain:** `app-first.log`, `app.log`, process listings before and after, a
  listing (names and sizes only) of `$RUN/profile` and `$RUN/workspace/.orca`.
- **Cleanup:** discard the VM/container. If only a directory tree was used, `kill -- -<pgid>`
  any survivors after recording them, then remove `$RUN`.

### L2 — Packaged rendering, fonts and CSP (Linux and Windows)

- **Applies to:** the launched tree from L1 or W3 on each architecture.
- **Prerequisites:** as L1/W3. For automated observation, Playwright's Electron driver on
  the disposable host launching the **packaged** executable (`executablePath`) with
  `--user-data-dir`; the existing smoke specs launch the workspace build instead, so they
  are a pattern, not a substitute.
- **Effects:** as L1/W3, plus screenshots.
- **Observations:**
  1. Screenshots of the shell in light and dark themes at 100% scale (and 150% on Windows).
     Text renders in IBM Plex (no fallback serif or system UI face), status glyphs render
     from the bundled symbol face, and nothing is clipped at the default window size.
  2. In the window: `document.fonts.check('14px "IBM Plex Sans"')` and the mono and symbol
     faces return true after `document.fonts.ready`; record each `FontFace` family and
     status. The packaged app has no `#type` route; that proof remains a dev-server check.
  3. `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content` equals
     the static report's `renderer.csp`. Inject an inline `<script>` and an inline style
     from the test driver: each must raise a `securitypolicyviolation` event and not
     execute. Normal start-up raises no CSP violation in the console.
  4. `typeof window.orca === "object"`, and `typeof require` and `typeof process` are
     `"undefined"` in the page (preload ran under `contextIsolation` and `sandbox`).
- **Evidence:** screenshots, the console log, a JSON of the evaluated values.
- **Cleanup:** as L1/W3.

### L3 — AppImage

As L1, launching `ORCA-<version>-linux-x86_64.AppImage` from a copy in `$RUN` after
`chmod +x`. If FUSE is unavailable, `APPIMAGE_EXTRACT_AND_RUN=1` extracts to a temporary
directory instead; record which was used. Do not install FUSE on a shared host. Expected
observations as L1; the daemon path is under the AppImage's mount or extraction directory.

### L4 — Standalone daemon

`node tools/probe-bundled-daemon.js <download>/orca-daemon-<version>.mjs` with Node ≥ 24,
from a checkout at the candidate commit. It owns a disposable workspace and its child, and
prints sanitized authenticated `hello` evidence: version equal to the candidate and the
expected protocol. Retain its output.

### W1 — Windows installer: hash, signature status, trust prompt

- **Applies to:** `ORCA-<version>-win-x64.exe` and `-win-arm64.exe`, on matching hardware or
  VMs.
- **Prerequisites:** a VM restored from a clean snapshot with **no ORCA installed**: no
  `%LOCALAPPDATA%\Programs\ORCA`, no `%APPDATA%\ORCA`, no ORCA entry under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`. If any exist, stop: never
  install over an existing application.
- **Effects:** none beyond reading the file and showing the OS trust prompt.
- **Steps and observations:**
  1. `Get-FileHash -Algorithm SHA256` equals the manifest.
  2. `Get-AuthenticodeSignature <installer> | Format-List *`. For current builds expect
     `Status : NotSigned` and no signer certificate, matching the static report's
     `absent-unsigned`. Record the full output. If a signature appears, record subject,
     issuer, thumbprint and timestamp, and report it as an unexpected finding: it is not
     release signing evidence unless signing has been provisioned and documented.
  3. Open the installer as a person would. Record the SmartScreen or unknown-publisher
     prompt (screenshot). Continuing past it is the explicit bootstrap trust decision
     UPDATING.md requires for unsigned installs; record who made it. If policy blocks it,
     record blocked; do not change SmartScreen, Defender or policy.

### W2 — Windows clean install and uninstall

- **Prerequisites:** W1 on the same VM.
- **Effects:** a per-user NSIS install (no elevation expected): the install directory
  (default `%LOCALAPPDATA%\Programs\ORCA`), an uninstall key under `HKCU`, Start menu
  shortcut(s) with AppUserModelID `dev.orca.desktop`. Uninstall removes them.
- **Observations:**
  1. No UAC prompt. Default and changed install directories both offered.
  2. Hash the installed `ORCA.exe`, `resources\app.asar`, `resources\daemon\orca-daemon.mjs`
     and `resources\native\diagnostics\win32-<arch>\*` and compare with the same-arch zip's
     static report (`asarSha256`, `daemonSha256`). Equality ties the installer payload to the
     inspected zip; a difference is a finding to explain, not to ignore.
  3. `reg export` the uninstall key to the evidence directory.
  4. After W3–W5, uninstall from Settings. Expected: install directory and uninstall key
     removed; record whether `%APPDATA%\ORCA` (profile) remains; the synthetic workspace is
     untouched.
- **Cleanup:** revert the VM snapshot.

### W3 — Windows launch, bundled daemon and logs

- **Prerequisites:** W2 installed; `ORCA_WORKSPACE` set for this process only to a new
  synthetic workspace; port 6722 free (`Get-NetTCPConnection -LocalPort 6722` empty).
- **Steps and observations:**
  1. First launch from the Start menu with no `ORCA_WORKSPACE`: record first-run setup or
     daemon start, as in L1 step 2. Close it.
  2. Launch with `Start-Process` and `-RedirectStandardOutput`/`-RedirectStandardError` into
     the evidence directory and `ORCA_WORKSPACE` set. Record whether main-process output is
     observable this way; if it is empty, say so rather than infer a log.
  3. `Get-CimInstance Win32_Process | Where-Object CommandLine -match 'orca-daemon'`: the
     child's executable is the installed `ORCA.exe`, its command line names the installed
     `resources\daemon\orca-daemon.mjs`, and its parent is the app. The status bar is
     connected with the candidate version.
  4. Profile listing (names and sizes) of `%APPDATA%\ORCA`, including `diagnostics` and
     `first-run` if present.
- **Cleanup:** W5, then W2 step 4.

### W4 — Windows rendering, fonts and CSP

L2 on the installed app, both architectures, at 100% and 150% display scaling.

### W5 — Windows graceful shutdown

Close the window. Expected: `ORCA.exe` processes exit within 10 s, no `orca-daemon`
child remains, the daemon port is closed. Repeat with a run in progress in the synthetic
workspace and record that shutdown still completes (it is bounded) and what the workspace
shows on the next launch. Retain process listings with timestamps.

## Update, failure/recovery and rollback (from the current updater contract)

Only Windows has an in-app updater (`packages/app/src/main/update-driver.ts`, contract in
[UPDATING.md](../../UPDATING.md)). It is packaged-win32-only, uses the generic provider on
channel `latest-<arch>`, sends `Authorization: Bearer` from `ORCA_UPDATE_TOKEN_FILE`,
requires an HTTPS `ORCA_UPDATE_URL` without credentials, disables automatic download and
install-on-quit, disallows downgrade and prerelease, and **ignores any offered version
containing `-`**. Consequences for testing:

- A prerelease candidate (`X.Y.Z-rc.N`) is published on the `prerelease-<arch>` channel and
  cannot be offered to a production client at all. The update tests need two
  **non-prerelease** builds, N and N+1, from the same pipeline. Do not rename or edit
  metadata to force a prerelease through: altered metadata is no longer the candidate.
- Choosing N and N+1 is the coordinator's decision. This plan does not choose them.
- The feed must be a **disposable** HTTPS host serving an immutable copy of N+1's
  published assets (`latest-<arch>.yml`, installer, blockmap) with a disposable read-only
  token created for the test, and a certificate the VM already trusts. Installing a root
  certificate to trust a test feed is a security-setting change and is out of scope; if no
  such host exists, record U-tests as blocked. Never point a test VM at the production
  `stable` feed or use its token.

Prerequisites for every U test: W1–W3 completed for N on a fresh VM snapshot; a backup copy
of the synthetic workspace and `%APPDATA%\ORCA` taken while the app is closed; N+1's static
report `consistent`.

| Id | Procedure | Expected observation (from the contract) | Evidence |
| --- | --- | --- | --- |
| U1 | Check → Download → quit normally → relaunch → Restart to update | Check does not download; download does not install; ordinary exit installs nothing (still N); after explicit restart the app is N+1, installed file hashes equal N+1's report, profile and workspace preserved | Screenshots of each state, version before/after, installed hashes, feed access log (status codes only) |
| U2 | Unsaved configuration, permission or answer draft, then Restart | Restart refused until drafts are saved, sent or discarded; nothing installs; retry works afterwards | Screenshots, version unchanged |
| U3 | A running agent operation in the bundled daemon (scripted workflow in the synthetic workspace), then Restart | Admission close refused while work is in flight; no work killed; parked gates survive a later successful restart | Run/event listing before and after |
| U4 | Feed offline, wrong token (401), N's blockmap absent from the feed, corrupt installer (bytes altered, metadata unchanged) | Check/download fails and can be retried; corrupt download is rejected by SHA-512 and never installed; an unavailable differential falls back to a full verified download; network and credential details never reach the renderer | Screenshots, app/feed status codes, version unchanged |
| U5 | Installer outcome unknown: end the installer process after `quitAndInstall` launches it (VM only) | Admission stays closed, no automatic reconnect, failure reported; workspace and first-run journal preserved for review. Do not delete the journal to unblock | Profile listing, app state, notes |
| U6 | Wrong-publisher installer | **Not applicable while unsigned:** `app-update.yml` has no `publisherName`, so there is no publisher to compare. Record "not applicable — unsigned". Run only once signing is provisioned, with N and N+1 signed by the release identity and a wrong-publisher N+1 | — |

**Rollback.** The updater refuses downgrade, so there is no in-app rollback. The supported
rollback is the one UPDATING.md describes: retain the known-good N installer and a
consistent pre-upgrade backup. R1: restore the pre-upgrade VM snapshot, or reinstall N into
a fresh snapshot and restore the backed-up workspace and profile, then repeat W3 and record
that N works on its own data. Installing N over N+1 on N+1-written data is not a supported
downgrade; if the store epoch in `release-compatibility.json` differs between N and N+1 it
must not be attempted, and even with equal epochs it is an observation, not acceptance.

**Linux.** There is no desktop updater on Linux. An N→N+1 change is a new extracted tree;
the applicable test is L1 for N+1 using a copy of the profile and workspace N created, and
rollback is L1 for N on the pre-upgrade copy. The Debian managed deployment
(`tools/deploy/orca-release.py`) is a separate server path with its own verification
boundary in UPDATING.md and is not part of this plan.

## Remaining native runs

None of these was run in this preparation. Each needs a disposable environment and, for the
update tests, a coordinator decision on N, N+1 and the test feed.

| Run | Platform | Status |
| --- | --- | --- |
| S on real candidate output, all Windows/Linux files | Any | Not run (no candidate designated) |
| L1, L2, L3 | Linux x64 and arm64 | Not run |
| L4 | Node 24 host | Not run for a candidate (`desktop.yml` already runs it on build output) |
| W1–W5 | Windows x64 and arm64 | Not run |
| T (signature validity, publisher, SmartScreen reputation) | Windows | Not applicable until signing is provisioned |
| U1–U5, R1 | Windows x64 and arm64 | Not run; needs N/N+1 and a disposable feed |
| U6 | Windows | Not applicable while unsigned |

## Limits of the static helper

- It establishes consistency of supplied bytes, not provenance. Provenance rests on the
  retained workflow run record (step 1 of the inputs).
- It does not verify Authenticode, blockmap chunk checksums (BLAKE2b-144, which Node does
  not expose), or the full transitive production closure (#720 did that against an
  installed tree).
- It does not read AppImage (squashfs) contents, unpacked ASAR entries, or NSIS payloads.
- The Electron runtime list is a presence check of a few core files, not a version check.
- Window hardening is a text check of the packaged main script; L2 observes enforcement.
- Zip64 archives are refused rather than read; current Windows zips are well under its
  limits, and a refusal here is a prompt to extend the reader, not to skip the check.
