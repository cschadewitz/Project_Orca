# Proposed packaged Mac harness

Status: design only, audited source/date in [test matrix](test-matrix.md).
Inputs and output schemas are proposals in [fixture contracts](fixture-contracts.md).
Do not count source builds, missing artifacts or unavailable automation as passes.

## Artifact consumer and executor

1. Receive #405’s proposed `native-mac-artifact.json`, `SHA256SUMS`, referenced evidence,
   exact local DMG/ZIP and expected source SHA
   from #385's approved delivery path. Download authorization stays with the operator or
   protected CI downloader, outside the app and test reports. Never choose `latest`, a
   filename glob's first result or a version-only match. Verify byte length and SHA-256
   against trusted metadata, not metadata regenerated from the downloaded file.
2. Run on an isolated macOS account/VM with a GUI session. Record `sw_vers`, `uname -m`,
   OS build, executor image and arm64 process observations. Require native arm64 app and
   daemon, not just an arm64 host running translated x64 processes. An unavailable GUI,
   architecture probe or signed candidate is blocked execution with a nonzero exit.
3. Mount DMG read-only under the run root or extract ZIP there, rejecting traversal and
   symlinks escaping the root. Copy the app preserving its bundle/signature. Verify
   app identity, architecture and resources before launching. DMG and ZIP receive their
   own test results. Never re-sign, patch `app.asar`, remove quarantine or replace daemon
   bytes. Keep the downloaded artifact digest unchanged through the run.
4. Validate with the Mac's tools: `codesign --verify --deep --strict --verbose=2 APP`,
   `codesign -dv --verbose=4 APP`, `spctl --assess --type execute --verbose=4 APP`,
   and `xcrun stapler validate APP`. Compare observed team/bundle identifiers with the
   manifest's expected publisher, reject ad-hoc signing. Validate the DMG ticket too
   when DMG delivery requires it; ZIP is not itself a staplable target, so validate the
   enclosed app. Retain exit codes and sanitized output. These checks supplement the
   physical first-open assessment; they do not simulate it.
5. Launch the selected `APP/Contents/MacOS/<CFBundleExecutable>` using a separately
   installed harness. The harness may use Node/Playwright; the app must not inherit
   that runtime, its PATH or a checkout. Its working directory contains fixture data
   only. Assert `app.isPackaged`, app/resources paths inside the selected bundle and
   production renderer loaded from that bundle, without a dev server.

Apple's [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
and [verification guidance](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
were consulted 2026-10-02. The commands above are proposed verification, not evidence
that this repository has signing credentials or a notarized artifact.

Use a pinned arm64 executor image selected during implementation. GitHub's
[runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
(consulted 2026-10-02) distinguishes hosted VM capabilities from physical hardware;
record observed architecture rather than trusting `macos-latest`. A controlled Mac
executor is acceptable if hosted execution cannot drive the unchanged signed app.

## Automation feasibility is a gate

Propose Playwright `_electron.launch({ executablePath, cwd, env, args,
chromiumSandbox: true })`, with the packaged executable specified explicitly and
profile arguments accepted by the candidate. Do not pass a checkout's main script.
Inspect effective launch arguments and retain production security settings; no
`--no-sandbox`, CSP bypass or ignored certificate errors.

[Playwright's Electron API](https://playwright.dev/docs/api/class-electron)
(consulted 2026-10-02) calls its support experimental, documents `executablePath`,
and notes dependence on the Node CLI inspection fuse. First prove compatibility
with #385's final fuse/entitlement settings. If the signed app cannot be driven,
record the limitation and choose reviewed native UI automation on a controlled Mac;
do not weaken production fuses, add debug entitlements or build a different app.
Native dialogs require separate handling: any stubbed chooser proves routing only
and must be labeled as such. Physical folder selection remains required.

## State isolation and launch environment

Use one worker and zero automatic retries. Allocate a run root (mode 0700) with a
random marker and exclusive ownership ledger:

```text
<run-root>/owner.json             run ID, canonical root, created paths, owned PIDs
<run-root>/downloads/             immutable selected artifact + manifest
<run-root>/mount/                 this run's DMG mount only
<run-root>/application/           verified app copy
<run-root>/profile/               fresh app preferences/cache/logs
<run-root>/workspaces/Sample α/    synthetic writable workspace
<run-root>/workspaces/Other β/     isolation sentinel, never selected accidentally
<run-root>/scratch/               app CWD, TMPDIR and negative fixtures
<run-root>/evidence/              sanitized allowlisted outputs only
```

Run under a disposable OS account/VM: a `HOME` variable or Chromium user-data flag
alone does not isolate Keychain, TCC, LaunchServices or every Electron path. Confirm
actual `userData`, session/cache/log paths and selected workspace before any sample
write. If #386 has no supported isolation/selection mechanism, block that scenario;
do not silently write `~/.orca`. A separate reused-profile scenario intentionally
reuses only its own state. Check the other workspace's sentinel hash after switches.

Construct a minimal app environment with system PATH `/usr/bin:/bin:/usr/sbin:/sbin`,
disposable account context and necessary GUI/locale variables only. Do not inherit
`ORCA_DAEMON_URL`, `ORCA_DAEMON_TOKEN`, `ORCA_DAEMON_TOKEN_FILE`, `ORCA_RENDERER_URL`,
`ORCA_WORKSPACE`, update-feed credentials, provider credentials, `NODE_OPTIONS`,
`NODE_PATH` or parent `ELECTRON_RUN_AS_NODE`. The app itself sets the last variable
for its bundled child. Do not use a shell startup file or install provider tools.
Record environment key names and allowed nonsecret values only.

Use #386's normal first-run UI to select `Sample α`. An optional separately labeled
runtime case may use the existing `ORCA_WORKSPACE` fixture override, but cannot pass
first-run/Finder acceptance. Confirm no unrelated daemon already serves the test
store. Never stop an unknown listener to make a port available.

## Execution and oracles

Observe app connection/workspace state via its existing bridge; verify OS process
parentage/executable and bundle resource path. Obtain the owned endpoint/token-file
through the reviewed production bootstrap contract, not scanning home directories or
injecting a test daemon. The token stays in a private helper's memory. Cross-check
hello `processId`, `orcaVersion`, protocol, capabilities/methods and store path with
that process, manifest and fixture. Treat unavailable identity as an acceptance gap.

Make missing-token and random-wrong-token HTTP/WS requests without changing the app's
credential. Require authentication refusal; then show valid app authentication and
subscription work. Capture only auth result codes, never headers, tokens or raw frames.
Start sample/gate/cancel actions through the UI; RPC observations may verify results
but must not replace the user action. Read artifacts through production interfaces;
never seed passing event logs directly. Check fixture bytes and semantic event order
while allowing generated IDs/timestamps. Assert no duplicate terminal transitions.

For lifecycle, close a window and reopen via app activation, then explicitly Quit and
relaunch. On macOS closing the last window currently keeps the app alive. Assert owned
daemon exit after Quit, rather than using `electronApp.close()` as proof of the menu
action. For connection loss, use an idle/parked fixture and terminate only the recorded
owned daemon after rechecking PID identity. Recover by the product's documented action;
automatic child respawn is not assumed. For startup failure, use a disposable denied
workspace, not a modified signed bundle. Permissions are restored only on owned paths.

Proposed budgets: launch/hello 60 seconds, UI assertion 15 seconds, sample/answer 120
seconds, explicit Quit 15 seconds, suite 15 minutes. Timeouts fail with the last safe
state; a rerun gets a new run ID and retains the first result. Reconcile budgets with
the candidate's product timeouts before freezing tests. Include a denial outside the
sample directory but still inside the run root; no personal path is a test target.

## Diagnostics and cleanup

Produce the [evidence packet](evidence-template.md) even on preflight failure. Allowlist
structured fields before writing them. Per scenario cap app and daemon tails at 256 KiB
each, assertion JSON at 256 KiB, screenshots at five cropped app images (2 MiB each),
packet at 25 MiB; mark truncation and omitted files explicitly. Disable HAR, raw traces,
videos, full environment dumps and blanket crash-log/store/profile uploads by default.
They can include authentication, private keys and arbitrary file contents even when
the sample text is synthetic. Never upload generated token/protected-key material.

Sanitize run-root/account paths to stable aliases and allowlist screenshots before
upload. Scan for the known generated token and synthetic redaction canary; discard
unsafe diagnostics and report that omission rather than publishing them. Real-agent
testing gets manual review and no automatic prompt/transcript upload. Store approved
packets with restricted access for 14 days (proposed, owner to confirm); record deletion
date. Only sanitized evidence survives cleanup.

In `finally`: request ordinary Quit; wait for owned children; recheck identity before
any test cleanup termination; report timeout/forced cleanup as failure. Unmount only
the ledger's mount and restore only its fixture permissions. Remove only canonical
descendants of the marker-verified root after processes are gone. Reject root/home,
missing markers, symlink escapes or PID reuse. On uncertain cleanup leave the owned
state quarantined for the operator and list safe paths; never `pkill` all ORCA/Node
processes, clear a user's Library, reset global TCC or erase a credential store.
