# Changelog

Notable changes to ORCA, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the versioning policy, the
milestone-driven release flow and what counts as a breaking change are in
[docs/RELEASING.md](docs/RELEASING.md).

Every release carries a **Store format** section, because ORCA is event-sourced: a change
to the event log, plan journal, artifact index or config schema can invalidate an existing
`.orca` store, and that is the change most likely to bite an operator who upgrades.

Entries are not written into this file. The PR that makes the change adds a fragment to
[`changelog.d/`](changelog.d/), prefixed with the area the commit uses (`engine:`, `plan:`,
`store:`, `cli:`, …); preparing a release renders the fragments into a dated section here
and deletes them. One file per entry is why two pull requests in flight no longer conflict
over this one. `changelog.d/README.md` has the naming.

A section is grouped by change type (`### Added`) and then by change target (`#### cli`),
the target being that area prefix, which the heading carries so the bullets need not.
Sections through 0.4.0 were rendered before that grouping existed and keep the prefix
inline.

Releases start at 0.2.0. `0.1.0` was the untagged groundwork commit (`8645f28`,
2026-09-15); everything below landed on top of it.

## Unreleased

Pending entries live in [`changelog.d/`](changelog.d/), one file per entry; preparing a
release renders them into a dated section below. Run `node tools/release.js notes --unreleased`
to read them as they stand.

## 0.7.1 - 2026-11-22

### Store format

Stores now record their format and the ORCA version that last wrote them in
`store-format.json`. The store epoch stays `operator-journals-v4`, so upgrading from 0.7.0
needs nothing: a 0.7.0 store (same format, no marker yet) is stamped on first open with
nothing else changed, and builds before 0.7.1 ignore the marker.

Ordinary startup never converts a store. A store written in an older format is refused
(`STORE_FORMAT` / `CARRYOVER_REQUIRED`) without being changed; no 0.7.x store is in an older
format. Converting one takes `orca store carry-forward`, run once offline with every other
ORCA stopped. In this build it refuses on Windows
(`BACKUPS_UNSAFE`, before any copy), and the Ubuntu desktop `.deb` does not ship the CLI.
The command refuses unless no run lease is live, a whole-store copy into `format-backups/`
matches byte for byte, the store did not change during the copy, and every run log,
collection and plan journal reads under the new build; only then is the backup published
(the newest two verified backups are kept) and the format stamped. A store written by a newer
format, or older than the previous release's, is refused without being changed.

### Added

#### app

- Groundwork for connecting to a daemon one protocol major behind: the app can show a bar saying the daemon is a version behind and that newer features are off until it is updated. This build opens no such window (see Protocol 2.1 below); it connects to existing 2.0 daemons as before.
- the Linux `.deb` says when a newer release is out. About 15 seconds after start
  and every six hours it reads the public release list and, when a newer stable release has
  a `.deb` for the machine, shows a notice in the title bar with the release page and the
  `apt` command. It never downloads or installs anything, an offline or failed check is
  silent, prereleases are offered only with `ORCA_UPDATE_PRERELEASE=1` as on Windows, and
  `ORCA_UPDATE_CHECK=0` turns the check off.
- Windows arm64 installs get updates. Finals now attach the signed arm64 installer
  beside x64, accept it automatically on a native Windows arm64 machine (signature, install
  over the previous arm64 release, ARM64 binary, app reaches its bundled daemon), and the
  desktop feed serves arm64 for any release whose arm64 installer passed that acceptance.
  x64 feeding is unchanged.

#### cli

- `orca store format` shows a store's recorded format; `orca store carry-forward`
  converts an older-format store once, offline, after a verified backup and read check (#566).
  It refuses on Windows in this build (`BACKUPS_UNSAFE`), and the Ubuntu desktop `.deb` does
  not include the CLI.

#### protocol

- Protocol 2.1. `hello` negotiates across a one-release compatibility window: a client may offer a `fallback` version from the previous major, and the daemon answers in the highest protocol both sides share. A daemon accepts the current and previous major once a release opens a window; N-2 is refused with a message naming what the daemon accepts. 2.x opens no window, so 1.10 peers stay refused, but a 2.1 daemon is the first that a future 3.0 app can fall back to. Clients offer the oldest minor they need (2.0), so an updated 2.1 desktop still connects to shipped 2.0 daemons.

#### store

- every store open checks the store format marker and refuses a store from a newer
  ORCA or an older format, without changing it (#566).

### Changed

#### agents

- ACP client SDK `@agentclientprotocol/sdk` 1.8.0 → 2.8.0, keeping the patch that leaves peer payloads out of SDK stderr diagnostics.
- SSH hosts read and write files over one persistent SFTP session per host instead of an `ssh` process per call, which makes artifact pickup from remote agents much faster. A session that drops is re-established once; a host without the SFTP subsystem falls back to the per-command path.

### Fixed

#### plan

- the critical path no longer counts overlapping work in full. Along a
  later-phase dependency (`other#build`) the first half of the dependent overlaps the
  upstream item, an item already underway counts half its estimate, and a dependency already satisfied
  (a produced stage) no longer counts toward the path at all (#108).

## 0.7.0 - 2026-11-21

### Store format

**Supported downloads.** Two installs are supported: the Windows 11 x64 installer,
code-signed by **Casey Schadewitz**, and the Ubuntu 24.04 Desktop amd64 `.deb`. A final
release attaches only those two. A release candidate's page instead carries the ordinary
build output, and its Windows installers are **unsigned**: don't install them. On a release
candidate, use the signed Windows installer only when it is separately attached or supplied
to you with its SHA-256, and verified as below. None of the other Windows, Linux or macOS
files on a candidate's page is signed, validated or supported. Before running a Windows
installer, check that its SHA-256 matches the one listed beside it on the release page (or
the one supplied with it) and that **Properties → Digital Signatures** shows a valid
signature from exactly Casey Schadewitz. If SmartScreen warns, choose **More info**, and
choose **Run anyway** only when the publisher reads exactly Casey Schadewitz and both checks
passed; stop at any other SmartScreen screen and at any browser or antivirus warning, and
report what it said. Windows arm64, Linux arm64, the Linux `.tar.gz` and AppImage, and macOS
are not supported in this release. The macOS builds use the new bundle ID
`com.schadewitz.orca` (was `dev.orca.desktop`), so OS permissions, notifications and
Keychain access do not carry over; upgrading an existing Mac install is not a validated
path, and no Mac acceptance is claimed.

**Upgrading from 0.6.0.** 0.6.0 shipped store epoch `ownership-fences-v1`, protocol 1.8
and capabilities `runs.read`, `runs.control`, `runs.subscribe`, `plan.read` and
`plan.write`. This release carries store epoch `operator-journals-v4` and protocol 2.0, and
adds the release capabilities `workflows.validateInputs` and `inputs.live`. The epochs and
protocol versions the notes below name on the way (`protected-execution-v2`,
`config-generations-v3`, protocol 1.9 and 1.10) were never released. They are steps
inside this one upgrade, not versions any release shipped. A 0.6.0 desktop app or
daemon cannot talk to a 2.0 daemon or app, so upgrade both together. This release's managed
updater refuses activation and recovery across the epoch change; direct CLI or daemon
startup does not enforce it. Upgrading an installed 0.6.0 across this epoch, by the 0.6.0
updater or manually, has not been verified on installed builds. Opening an existing store
with this release writes to it, even for read-only commands. Before the upgrade, keep a complete, consistent backup of the store,
protected material and keys with the 0.6.0 binary. Rolling back means restoring that
backup; reinstalling 0.6.0 over an upgraded store is not supported.

The intermediate (never released) epoch `config-generations-v3` introduced this. New protected
configuration-generation records and generation-bound run/admission metadata require a
runtime that understands those bindings. Existing protected-execution-v2 encryption,
keys and records remain intact; this is not a plaintext migration or key rotation.

The managed Debian updater refuses automatic activation/rollback when release metadata
has different store epochs. Direct daemon/CLI startup does not enforce that epoch;
manual rollback to an older binary is not guaranteed to refuse the store and is not a
supported migration. Retain a complete pre-upgrade store backup, including protected
material and keys, with its matching binary. Custom executable plugin registrations
can prevent generation restoration after an engine-process restart; see #394–396.

Generation snapshots now embed their workflow definitions without pinning unlaunched
workflows. Older binaries that ignore those definitions cannot restore a generation when
any catalog workflow lacks a pin, even if both builds report `config-generations-v3`.
Snapshot compatibility is one-way; an equal epoch does not make binary-only rollback safe.

`run.created.provenance` may now include an optional `itemWorkflow` choice with its effective
dispatch default and source. Individual workflow nodes may pin a different child workflow.
The field is additive: existing run records need no migration and simply lack this detail.

Opted-in plugin generations add private versioned restoration descriptors to the
existing protected execution records. Public events and provenance do not expose
the descriptor data. Existing behavior-bearing records are not automatically
migrated; older installations do not gain plugin restoration merely by reading
the same store epoch. Keep a compatible installation and valid protected records
for recovery, or finish unsupported work in its original engine process.

New inactive standing-grant writes use rule version 2 with `expiresAt: null`,
and protected standing approvals use versions 2 or 3. Readers must support these
encodings; older binaries may refuse affected typed sidecars or scoped-grant
material after a downgrade. Existing finite grants are neither migrated nor
extended. Preserve the matching protected approvals and key material; rewriting an
until-revoked grant as a legacy finite grant is not a compatibility mechanism.

An inactive, explicitly versioned permission-sidecar v2 schema retains the legacy
agent map and adds reviewed typed rule records at the existing sidecar path. Normal
operation remains on v1: typed persistence has no production registration, and no
existing sidecar is migrated, repaired or converted by this feature.

Future explicit opt-in requires durable managed enrollment and an accepted compatible
writer/runtime floor. Enrolled workspaces must refuse incompatible binaries and
managed update, rollback, root restoration, retarget and enrollment reset until those
paths have separate reviewed support. Unknown or damaged typed state stays closed;
legacy fallback cannot restore standing authority. Refs #702/#699.

Establish `operator-journals-v4` and protocol 2.0 for operator, admission, continuation and
revision integration. Closed protocol 1.10 capability/event schemas cannot consume the new
wire contract, including `revision.recorded`; upgrade clients and daemons together.
Optional feature methods remain provider- and authority-gated, not globally required.

The managed updater refuses activation/recovery across store epochs. Direct CLI/daemon
startup does not enforce the release marker, and direct in-place downgrade is unsupported.
Before upgrade, stop all writers and retain a complete, consistent backup of both stores,
protected payloads, all journals and associated state with its matching old binary and
toolchain. Rollback requires restoring that complete pre-upgrade backup; switching binaries
cannot undo new writes. Old full-schema readers reject valid unknown events, while filtered
reads may bypass them, so a successful read does not prove downgrade safety. See
`docs/UPDATING.md` for the migration and recovery boundary.

### Added

Add the inbound MCP operator adapter with authenticated stdio/Streamable HTTP entry points,
allowlisted bounded read projections and guarded lifecycle tools. It is for **single-owner
use only**: one owner operating their own daemon. Missing- and invalid-credential refusal
is source-tested only and has not been live-passed (#392). Scoped access for other users or
agents (#598) has not been passed and is not offered.

Add durable continuation admission for supported sealed root decision boundaries,
with authenticated HTTP/WebSocket receipts, current-authority leased attachment,
bounded restart discovery, conservative ambiguous-execution refusal and read-only
durability verification. Child/live/agent-boundary and MCP mutation composition
remain unsupported in this first slice; protocol 2.0 and operator-journals-v4
require coordinated upgrades and complete matching-store rollback.

Add the shared protected retry journal and Request/direct admission services for
client idempotency keys, including durable reservation, bounded contention,
quota refusal and original-work reconciliation. Writable, token-authenticated
daemons with admission retry configured expose `runs.admit`, `admissions.get`
and `admissions.reconcile` to authorized callers with `runs.start` authority;
`runs.start` uses the same durable admission path when configured.

Palette admission intents now persist encrypted before dispatch, recover after app restart, and require explicit confirmation before abandoning an intent for separate work. Authenticated principal/workspace guards prevent retries crossing scopes; unavailable secure storage fails closed.

- Prepare explicit human revision contracts, fenced service and delivery accounting,
  authenticated adapter helpers and a correction card for the coordinated runtime
  integration. Production capability remains gated on the shared retry and ownership
  wiring; ordinary answer notes remain rationale only.

ACP session callers can require context loading with `requireContextRecovery: true` and a nonempty `resumeSessionId`. Unsupported, failed or timed-out loads stop and clean up the owned connection instead of opening a fresh session. This opt-in checks protocol load success; native context verification and durable approval continuation remain separate work under #357.

- Add candidate-bound Mac approval/defer app routing and a gated native ZIP handoff lifecycle; production installation remains unavailable pending complete recovery ownership and signed Mac acceptance.

Add an authenticated runtime idle fence and concrete managed-target Mac admission leases. Active execution, callbacks, renewal and queued admission/recovery work defer acquisition; uncertain results retain ownership. Mac installation and recovery activation remain disabled.

Add internal Mac update guard foundations: nonce-scoped document leases and authenticated
owned-daemon capture. Mac update installation remains disabled, and missing authoritative
attached-execution/callback idle proof blocks admission readiness.

Bind internal Mac update draft leases to Electron window/document lifecycle and the
sandboxed preload. Native interaction and new-window creation remain guarded until
scoped release; Mac installation and daemon admission readiness remain disabled.

Added an internal, disabled recovery inventory and manifest validator for explicitly supplied owned roots, with bounded read-only observations and synthetic protected-state round-trip checks. This does not enable production backup, restore or execution recovery.

Mounted the disabled native diagnostics initializer and enum-only startup observer, and exposed an exact owned-child updater stop receipt with a sealed local restart-admission fence. Production updating/capture and complete-state restore remain gated.

Add local deterministic ESM plugin release candidate production with dependency graph checks and installed verifier/bootstrap coverage. Candidate digests remain unapproved; independent release approval and startup pin delivery are still required for supported custom-plugin recovery.

Added opt-in production bootstrap verification and frozen per-plugin identity mounting for independently pinned closed-bundle release evidence, with exact composition, runtime, identity and byte checks. Trusted attestation production/pin delivery remains a deployment requirement; unsupported plugins continue to refuse restoration.

- Add an authenticated trusted-only installed-plugin serve adapter and an unapproved provider-free M10 candidate/independent launcher preparation for parent-owned restart acceptance.

Opt-in `git-worktree` root isolation on built-in local Linux hosts, with frozen base commits, retained ownership receipts and fail-closed provisioning recovery. Defaults, WorkItem workspaces and child inheritance remain unchanged.

Add disabled, explicitly opted-in diagnostic recovery storage and exact-content preview/local-save controls, with bounded encrypted checkpoints, honest cleanup/unknown outcomes and separately authorized Save again. Production capture and native acceptance remain gated.

- Prepare an independent read-only maintenance MCP package with four closed tools,
  bounded typed health/log projections and synthetic source tests. Production sources
  explicitly remain unavailable; service supervision, credentials, tunnel activation
  and platform access acceptance remain future work (#483).

Prepare opt-in fixed Linux maintenance health and same-user structured observation readers,
bounded source acquisition, and inactive independent launcher/tunnel templates. Unresolved
service identities still fail closed; activation and actual-client acceptance remain pending.

Add a versioned advisory daemon-machine resource contract, deterministic shared
fixtures, bounded on-demand Linux collector and caller-authorized workstream
summary seam. Authenticated API/MCP and UI consumers remain separate work.

Add an opt-in, fixture-tested authenticated daemon/MCP resource-read contract using the shared host snapshot. The proposed host telemetry grant is separate from caller-visible workstream authority and excluded from every preset; production collectors and grants remain unmounted pending policy review and integration.

Added disabled Mac update drain coordination and durable closed replacement recovery
policy, retaining exact approval/target/token and preserving protected-state plus
matching-binary generations when newer writes prevent automatic rollback. Production
activation still requires native writer, recovery and signed lifecycle acceptance.

Added inactive typed policy evaluation and review-registration seams for scoped tool decisions. Existing ACP permission behavior and production defaults are unchanged.

Prepare a default-off Linux typed-workspace owner with durable enrollment intent,
canonical persistence handoff and managed launch/recovery refusals. Add a separate
daemon/CLI/ACP lifetime exclusion mechanism; production activation remains unavailable
pending the stable trusted bridge, complete launch ownership proof and accepted builds.
The exclusion is already enforced: CLI configuration loading and update bootstrap refuse
a workspace beneath a `.orca-typed-workspace` marker. No shipped command creates one.

Prepare shared owner-bound typed store identity and protected scoped approval records,
with current credential/lease checks and safe stored-rule projections. Runtime
composition remains unavailable pending actual qualified captures and integration gates.
Approval events from that inactive path redact their metadata in public events and
notifications while retaining the original encrypted payloads.

Added inactive, owner-injected scoped permission choices in the existing approval card,
with separate one-time answers and reviewed rule saves, safe decision projections,
and conservative stale/uncertain recovery. No production registration or policy defaults change.

Add an inactive Linux disposable-file read acceptance capability with retained descriptor ownership, strict policy/judge/fence composition, and adversarial source tests. No production tool registration or installed-provider coverage is enabled.

- Prepare a default-off Linux owner-local capture bridge over the bounded owned-read
  service, protected facts and original live callback. Unqualified Save/human execution
  remain refused; disposable tests cover delivery, lost acknowledgement and revocation.
- Within that default-off bridge, bind human verdict/permit completion to the actual
  original callback's ephemeral delivery capability, retaining separate Save/answer
  actions and fail-closed installed gates.
- Await settled original delivery before refreshed policy evaluation, preserving
  terminal refusal when the final lease acknowledgement is lost.
- Retain original human eligibility when bound required-review completion requests
  a person, while keeping rule-allow completions ineligible for human attribution.

Add an inactive, bounded Linux owned-file read service with stable resource identity,
private trusted capture/dispatch facade, per-invocation replay protection and actual
read conformance tests. Local emitted-build evidence stays explicitly unqualified;
production activation and stored-rule Save remain gated.

#### agents

- Bound ACP permission callbacks to their original turn and invocation;
  cancellation, timeout and transport loss expire late answers. Explicit session loading
  checks agent capability and reports fresh-session fallbacks.

#### agents/daemon

- Added inactive typed permission sidecar v2 persistence and exact
  read/receipt contracts, with original-principal grant rechecks and disposable-store
  failure/restart tests. Trusted owner injection is required; managed compatibility
  enforcement and production activation remain incomplete. Refs #702/#699.

#### app

- Add an app icon, the ORCA mark (a bracketed hexagon around a fin on a teal
  waterline), to the macOS, Windows and Linux builds. The mark and icon SVGs ship in
  `@orca/design` under `brand/`.
- Structured configuration forms are now available in Config, with review
  before saving and a separate, guarded Apply action. Drafts survive navigation;
  stale or unacknowledged writes retain edits, and restart requirements remain
  explicit.
- The object header shortens a trail that does not fit. Its middle folds into a
  `…` control, nearest the root first, down to `request ▸ … ▸ run ▸ step`; then the run
  folds too, `request ▸ … ▸ step`; only then is the current crumb's name cut at its end. The
  first crumb and the current one never fold, and type labels, id tokens and versions are
  never cut. Fit is measured, so a wide window still shows the whole chain, and the Plan mode
  control and the Workflows header actions keep their width. `…` opens a menu of the hidden
  crumbs, each with its type, name and token, and choosing one goes where that crumb would
  have. It is a button in the tab order, and its accessible name lists the levels it holds
  in order, so a screen reader still hears the whole chain.
- Native first-run project review and separate empty-workspace preparation,
  authenticated owned-daemon connection, and a fixed agent-free launch smoke check.
  Startup without an explicit target or verified selection opens disconnected for setup.
  Unknown Windows ownership remains blocked; native acceptance is still required.
- Open guided launch from Config or the palette, review a configured prepared
  checkout and typed inputs, confirm permission policy, and restore or recover exact
  protected launch intents. New work requires explicit abandonment; beta provisioning
  and native acceptance remain separate.
- Add explicit native pre-signing build identity and trusted signed Mac
  candidate validation with bounded DMG/ZIP containment. Desktop packaging stages
  native addons for every configured Mac architecture; ordinary Mac packaging stays unsigned.
- The workflow viewer, the workflow editor and the plan's dependency graph have
  view controls in the canvas's corner: zoom out and in, the zoom level (press it for
  100%), zoom to fit, a top-to-bottom / left-to-right layout toggle and a minimap of the
  whole graph you can click or drag to move the view. ⌘/Ctrl with the wheel, or a
  trackpad pinch, zooms about the pointer. The direction and the minimap are remembered
  per person and per canvas; they never change the workflow file or its saved layout.
- A visual workflow editor. Edit opens a draft of the workflow on a canvas, with a
  node palette, an outline, an inspector and a validation panel that is always present. Drag
  nodes from the palette onto the canvas or an edge, drag nodes to arrange them, drag from a
  port to connect, undo and redo, then review the YAML diff and publish a new version. Every
  gesture has a keyboard path in the new `workflow-edit` scope.
- A Workflows surface in the sidebar (⌘4): every registered workflow with its version,
  size and draft state, opening into the viewer or straight into the editor
  (`orca://workflow/<id>?edit`). Agents and Config move to ⌘5 and ⌘6.
- Integrate authenticated daemon switching, persistent workspace/boot identity
  and connection epochs, plus connected live-permission invalidation. Correct connection
  error reporting, epoch synchronization and bundled endpoint handling.
- Compose candidate-specific Mac approval/download sessions with reviewed window
  and runtime guards; wait for preparation settlement before candidate cleanup and
  retain evidence on unknown release. Native installation and full recovery remain gated.
- Add disabled main-only Mac candidate binding, process-local approval plumbing
  and bounded owned-download verification against the existing delivery-v1 manifest.
  Production offers, approval IPC, installation and recovery remain disabled pending
  trust/delivery policy, native verification and signed Mac acceptance (#387).
- Add disabled Mac owned-stop and coherent replacement-startup verification,
  backed by fresh disposable daemon fixtures. Verification leaves admission closed;
  production activation, native acceptance and full protected-state recovery remain
  separate gates (#387).
- Add an internal Mac update approval coordinator with candidate-bound consent,
  defer and owned guard handling, and fail-closed unknown outcomes. Production Mac updating
  remains unavailable pending native, trust, identity and complete-state recovery adapters.
- Isolated Mac updater rehearsal combines candidate approval/download,
  window/preload ownership and authenticated runtime admission with reviewed owned-stop
  and fresh replacement verification. The terminal startup result stays verified-closed;
  production updates, signed native installation and complete-state recovery remain disabled.
- Prepare architecture-specific native diagnostics resources and reject missing
  or stale Mac packaging inputs. Capture remains disabled pending native acceptance.
- Add explicit same-boot orphan reconciliation for new, kernel-fenced
  first-run generations, distinguish surviving owned and unknown writers, and
  recover interrupted saved-configuration binding after verified quiescence.
  Preserve retained evidence/work and require explicit continuation after recovery;
  legacy unfenced attempts and native acceptance remain separate gates.
- Add a durable closed update window, verified fixed-path state/binary backups,
  and resumable same-boot restoration. Preserve failed-candidate evidence and refuse
  reopening until validation or full restoration succeeds. Native installation remains
  disabled pending complete owner wiring and real-Mac verification (#387, #571).

#### app/daemon

- Author configured prompt templates through an authorized catalog,
  exact-source review and Save, fixture-only previews, strict-pack variants and reviewed
  workflow instruction assignments. Apply saved assets separately; admitted runs retain
  captured instruction digests. Configuration reference selectors and explicit source
  reconciliation preserve comments, unrelated fields and retained drafts. Desktop IPC
  registration remains in the pinned integration-owner handoff.

#### build

- Manual Desktop packaging can select Windows/Linux together and route Linux
  jobs to a selected self-hosted runner, while release calls retain the full existing platform matrix.

#### cli

- Fence participating writers before initialization and support authenticated,
  read-only replacement inspection without permission resets, credential rotation,
  first-run claim adoption or automatic continuation recovery.

#### daemon

- Workflow drafts: `workflowDrafts.get`, `open`, `apply`, `undo`, `redo`, `review`,
  `publish` and `discard`. A draft is kept beside the workflow in `.drafts/`, edited through
  revision-checked semantic operations on the comment-preserving YAML, validated against the
  active generation, and published by reviewed bytes, a version bump and a generation Apply.
  Dragged positions are layout metadata in `.layout/`, never in the workflow file.
- Authentication and authorization on `/rpc` and `/socket`. Bearer credentials
  (`orca1.<id>.<secret>`, hash-only on disk) with expiry, rotation and revocation; a local
  bootstrap token file for same-user clients; a deny-by-default permission matrix over every
  method; per-principal resource scopes that filter lists, hide other principals' runs,
  artifacts, gates and notifications behind the same not-found a missing id gets; a separate
  grant for standing permission rules; socket credentials re-checked per message,
  notification and interval, closing with `4401` on revocation or expiry; and a JSON-lines
  security audit log. Scope isolation between principals is offline-tested; scoped access for
other users or agents is not offered (#598). `docs/daemon-security.md` has the matrix, deployment and migration.

- Extend authenticated runtime maintenance with owner-bound drain and
  defer actions. Close new workflow/run/request admissions while allowing existing
  work and answers to finish, and require empty activity plus a complete unfinished
  run inventory before sealing the idle fence. Native installation remains disabled.

#### engine

- Added owner-local live permission decision primitives with exact identities,
  actor attribution and ordered standing-rule writes, integrated with daemon authority
  checks and connected app permission-card invalidation.

#### engine/cli

- Plugins can opt in to versioned restoration of custom executors
  from bounded, validated non-secret inputs in a recorded generation. Recovery
  constructs an isolated registry after trusted installed-code/dependency identity
  verification, and refuses unverified, unavailable or incompatible plugins.
  Host/workspace/plan/input callbacks and mixed legacy compositions
  remain unsupported across engine-process restarts.

#### engine/daemon

- Integrate Request admission, configuration generations and live
  permission callbacks under protocol 1.10. CLI/ACP submissions use explicit current
  authority. Explicit same-principal resume can renew revoked execution attachment without
  reviving old tool decisions.
- Add durable Request admission with protected inputs, stable recovery
  IDs and ownership before execution. Daemon and configured CLI/ACP submissions use the
  integrated generation provider. Admission list/inspect/reconcile are available through
  token-mode daemon RPC and local CLI/ACP commands; local reconciliation returns a receipt
  without implicitly starting execution. No app recovery form is supplied.
- Add integrated configuration generations, launch provenance and
  explicit apply. Saved revisions remain distinct from active generations and pinned
  workflow bodies remain immutable. Custom executable plugin registrations bind the
  entire generation to its original engine bootstrap, including workflows that never
  use them; restarting that engine process can prevent restoration. No-op/declarative
  plugins retain conditional restart compatibility. Cross-process custom-plugin
  restoration is tracked in #394–396. Boot preserves unrelated recovery after unused workflow
  edits, configured literal redaction distinguishes ordinary arguments from credentials,
  and restoration checks reject incompatible executable plugins in both directions.

#### integrations

- Add a bounded JEV restoration adapter with pinned defaults,
  compatibility refusals and current credential binding checks behind an explicitly
  provisional injected interface. The shipped plugin remains non-restorable across
  process restarts until the shared restoration substrate is integrated (#394).

#### protocol

- Add inactive coverage and decision projection helpers with approved opaque
  references, explicit lifecycle uncertainty and separate recording, delivery, dispatch
  and effect observations. Production surface wiring and privacy acceptance remain separate.

#### runtime

- Integrate builtin validation, typed launch preflight and revision guards,
  token-authenticated CLI/app/updater clients, exact pre-execution run ownership and
  lease-validated standing permissions. Keep sensitive execution inputs and replay payloads
  in owner-only storage with sanitized public event/read/log projections.

#### tests

- Add a separate candidate-only Linux owned-read trace verifier with
  retained physical bindings, descriptor/inode reconstruction, valid-action
  refusal observations and controlled negative executions. No accepting
  qualification, coverage upgrade or production registration is introduced.

### Changed

The inactive owned-read composition can reserve its initial approval intent before
the human wait, then obtain a fresh bounded action only after the final original
acknowledgement. Historical previews remain non-executable; Save and denial do not
read the resource. Cancellation, current authority checks and owned cleanup remain
mandatory. This does not enable a production guard or provider callback recovery.

#### agents/engine/integrations

- The Agent Client Protocol SDK is updated from 1.4.0 to
  1.8.0.

#### app

- Adopt the approved macOS bundle ID `com.schadewitz.orca`, retaining the
  Windows packaging identity for existing NSIS upgrades. App names and data paths
  stay unchanged; signing remains disabled. Existing Mac permission and Keychain
  continuity requires native validation before distribution; no data migration is included.
- Upgrade electron-builder to 26.18.0 and Vite to 8.3.5. The upgrade was
  reviewed against production dependency, archive/blockmap and renderer compatibility
  checks; application runtime source is unchanged.
- The disabled crash-diagnostics flow prepares current or recovered reports
  for explicit local export, with a separate destination picker and Save. Report
  contents stay in main until saved; the in-app viewer is removed. Production
  capture remains disabled pending independent review and native acceptance.
- The Dedicated project setup section on Config is laid out in steps: the
  selected directories in one sunken list, the next action as the primary button, a
  refusal in its own block, and reopening and recovery actions grouped below.
- A run's variables, a workflow node's configuration in the Workflows inspector and
  the variables in the guided launch's review card are now one display: each name in mono,
  because it is an identifier ORCA produced, a short value on the line beside it, and an
  object or array as indented JSON in a sunken well, clamped to eight lines with a
  "Show all" button. A node's `options` or a launch's object input no longer reads as one
  compact line of JSON, and a withheld launch input is listed by name as "Withheld". A
  correction's values on an Attention card are set in the same sunken well.
- Ids are shown by name and tail. Wherever a row or a header printed a raw id —
  `wi_01M4M899VKJZRZSBHNDY5M579G`, whose first ten characters are a timestamp every id minted
  with it shares — it now leads with the object's name and follows it with a faint token: the
  kind's glyph and the id's last six characters, `Database schema ⬡ 5M579G`. An object with
  no name on any read model (a request) is its token alone. If two ids in one list share six
  characters, just those two grow. The whole id is on hover, in a new **Copy id** in the
  object header's crumb menu, in the detail pane, and in the command palette, which matches
  any part of it. This covers the Agents claimed-work list, the Plan table, rail and
  inspector, the Runs header, palette labels and danger confirmations, the permission card,
  the artifact panel and the workflow viewer's run picker. Event timeline rows name an event
  by its sequence number (`#148`); the row's menu copies its id. Link notices, correction
  summaries and launch receipts keep ids whole, with the tail picked out. Six object-kind
  glyphs are bundled: `☰` run and `⬡` work item (the Runs and Plan rail glyphs), `❝`
  request, `◫` step, `⊓` gate and `✦` event. The step's is a split square because at id size
  a plain rectangle reads as a dash.
- The desktop app runs on Electron 44.10.0 (from 44.4.3), within the existing 44 line.
- Windows installs that set `ORCA_UPDATE_PRERELEASE=1` (internal and preview testers)
  are offered release candidates from the feed; all others still ignore them, and downgrades
  stay refused.

#### daemon

- `startDaemon` refuses to start without an explicit `auth` policy, and the
  unauthenticated `loopback-unauthenticated` compatibility mode is refused off loopback. A
  non-loopback bind needs a TLS-terminating proxy named in `trustedProxies`; requests that
  bypass it, arrive over plain http through it, carry a disallowed `Origin` or a non-loopback
  `Host`, or put a credential in the URL are refused. A method missing from the operation
  inventory is `AUTH_FORBIDDEN` even when a method table answers it.

#### permissions

- Prepare until-revoked owned-read rules without extending existing
  grants. Separate pending human review from fresh bounded Save and read authority,
  preserving cancellation, current credentials, workspace scope and one-use checks.
  Production activation and disconnected-provider continuation remain separate.

#### protocol

- The protocol reference now documents the whole 2.0 surface: an inventory of
  all 83 daemon methods with the grant each needs and what installs it, the 32 capabilities,
  `maintenance.runtime` with drain and defer, `ORCA_MAINTENANCE_TOKEN` and
  `ORCA_ADMISSION_FILE`, `runs.admit` and `admissions.*`, continuation, revision, the six
  operator reads (a stale cursor is a `restartRequired` page) and ten operator mutations, and
  the eight `templates.*` and eight `workflowDrafts.*` methods, which arrived within 2.0
  without a minor bump. It corrects what it said about `PROTOCOL_VERSION` (a client-side
  code; a version mismatch answers `NOT_SUPPORTED`), `config.set`'s grants (`config.write`
  and `config.read`), `runs.start` under default `orca serve` (a durable admission that
  refuses with `RUN_STATE` when it needs reconciliation), and the 1 MB `/rpc` body limit.

#### release

- the private Windows update feed is now a Cloudflare R2 bucket behind a small
  Worker, with rings (internal, preview, stable), percentage rollouts and the
  `Desktop feed (publish signed)` and `Desktop feed (promote)` workflows. Only verified signed
  installers for a tagged commit enter the feed, offered to `internal` first. It replaces the
  SSH feed host (`ORCA_FEED_HOST`); the feed stays off until `ORCA_FEED_BUCKET` is set
  ([UPDATING.md](docs/UPDATING.md#rings-and-controlled-rollouts)).

#### runtime

- Node.js 24 is now the minimum supported version for development and the
  standalone daemon. CI retains Node 24 checks and retires the Node 22 lane.

### Fixed

First-run startup reservations now survive app restart. Unconfirmed ownership or
missing/altered evidence blocks competing local startup and preserves the selected
store; orphan ownership requires a separately reviewed reconciliation authority.

Retain desktop app writer ownership through first-run, connection and shutdown work.
During a reserved Mac update drain, allow existing run completion and observation while
durable admission remains closed; keep new work and final-stop dispatch blocked.
Enroll selected managed configuration roots before their producers and enforce durable
admission closure on the running daemon. Compose candidate, commit and full-pair recovery
under the independent activation hold.
Native replacement activation and diagnostics remain disabled pending their bindings
and acceptance.

Bind held Mac update composition to the existing native image verifier, secure-storage
and intent readers, read-only OS permission observations and one-use owned daemon startup.
Cancelled native inspection waits for cleanup. Closed validation keeps uncertain children
owned and observes retained work without reconciliation. Activation remains disabled.

Omit free-form agent text from operator event rows so embedded workspace paths cannot
cross a projection that promises path omission. Retain event identity and sequence
metadata and explicitly report the agent-text omission.

Avoid durably rewriting an unchanged retry recovery cursor while holding the shared admission catalog lock. Changed pages still publish durably; admission deadlines, authority checks and retry behavior are unchanged. Refresh the reviewed Linux/macOS type-proof fixtures for the existing ObjectId samples and expanded object-kind glyph catalog.

Honor the existing bounded diagnostic key-envelope contract in Windows DPAPI wrappers.
Preserve complete control/session metadata and legacy Electron envelopes without rewrapping.

Windows diagnostic key wrappers now use asynchronous current-user DPAPI protection without depending on Electron's delayed first-profile Local State write. Preserved Electron wrappers retain their existing read authority. Diagnostics capture remains disabled.

Keep ACP SDK notification-failure payloads and unknown response IDs out of daemon stderr diagnostics.

First-run configuration review now separates local executable observations from unknown provider/version/sign-in evidence, explains ACP and recovery handoff, preserves the #594 exact-command hold, and supports cancelling an unbound review. Truncated Mach-O headers no longer imply an architecture mismatch.

Use bounded UTF-8 blocks for diagnostics previews, with explicit main/preload/renderer disposal and complete exact selectable text. Keep Save authority tied to the frozen main bytes and preserve disabled production capture and all acceptance gates.

Reduce diagnostic metadata and report allocation churn by growing reusable payload storage to demand within the existing memory ceilings. Production capture remains disabled pending native/resource acceptance.

Reduce diagnostics heap churn by reusing report scheduling callbacks and a compact
event cursor, scanning the exact canonical event grammar, and reusing validated
preview text. Keep checkpoint bytes in their owned arena lease through disk
settlement. Preserve report/event limits, exact Save content, erasure and consent;
production capture remains disabled pending the separate acceptance gates.

Build Windows diagnostics clock, storage and key-protection addons with MSVC C11
and the selected architecture's verified Node import library. Keep native staging
bound to the exact source and PE architecture; production capture remains disabled.

Prevent competing continuation replays from marking completed runs blocked during
receipt settlement. Preserve recoverable receipts when settlement publication fails
after execution finishes, without repeating the decision or execution.

Coalesce repeated local diagnostics opt-out clicks while revocation is pending, preserving failure feedback and deliberate retry without delaying opt-out during Save.

Compose same-boot first-run recovery and explicit saved-configuration binding with template
authoring. Block setup transitions during an updater drain reservation and keep the app's
YAML dependency consistent with its existing locked resolution.

Compose captured authenticated drain ownership with the final Workspace freeze and updater
guards. Closed replacement bootstrap gates also refuse staged connections before child startup;
ordinary quit does not force-stop an updater-reserved daemon. Native activation remains disabled.

Bound legacy standing-rule Save review and verification by cancellation and the
original action, review, lease and credential deadlines. Legacy Save now requires
an explicit owned-work reviewer contract; unscoped ports remain unavailable for
Save while existing grants and ordinary answers retain their semantics.

Scoped permission choices now report a reply lost after dispatch as uncertain rather than refused,
release a review handle that arrives after a reconnect, let a stale (unsent) choice be reviewed again,
and point a refusal at refreshing authoritative state. Inactive UI only; no policy semantics change.

Create typed-policy temporary files privately regardless of ambient umask, and
refuse existing temporary evidence without overwriting or deleting it. Managed
ownership/privacy checks and default-off activation remain unchanged.

Fix Linux fixed-path recovery validation when timestamp conversion rounds below a millisecond boundary.

Use non-creating Windows synchronization handles for durable run ownership and existing journal verification while retaining integrity checks and missing-record refusal.

#### agents

- An agent can no longer grant itself permissions. ORCA's own files — the config,
  `orca.permissions.json`, the store (but for the `work/` and `program/` deliverable areas) and
  `auth/` — are refused to every agent ahead of any permission rule, `default: allow`
  included, and by the `fs/read_text_file` and `fs/write_text_file` handlers; `auth/` and the
  store's key directories cannot be read either. Paths are resolved through symlinks and `..`.
  A wildcard `allow` in the sidecar is ignored with a warning (write one in `orca.config.yaml`
  instead), and an unreadable sidecar turns every `allow` decided after it into `ask` rather
  than letting a default allow through.
- Explicit config and permission-sidecar guards stay protected even when the
  configured store places them inside a workflow's writable area.
- Refuse replacing an existing permission sidecar with an unsupported
  explicit version, even when a legacy replacement document is valid. Typed rule
  persistence remains disabled pending writer compatibility and recovery acceptance.

#### agents/engine

- Close owned agent sessions when handshake or startup event
  bookkeeping fails. Direct-child cleanup now waits for exit with bounded SIGTERM
  and SIGKILL grace periods, reports incomplete cleanup separately, and preserves
  the original startup failure.

#### app

- Starting runs from the palette or guided launch no longer stops working after
  about 1,000 runs. The encrypted run-intent journal now drops abandoned intents when it
  next writes, including ones an earlier version left behind, and its 1,000 limit counts
  only retained intents, which are never pruned. At that limit the refusal says too many
  intents are retained instead of pointing at the OS keychain.
- **Always deny** on a permission card no longer lets the call through. It sent the
  selected option, usually **Allow once**, with a deny rule; it now answers with the deny
  option, and **Always allow** with an allow option. When the ask names no single option that
  goes that way, the button is disabled and says why.
- On an Attention card, `Enter` on a focused button presses that button. It used to
  answer with the card's selected option instead, so tabbing to **Deny** or **Always deny** on a
  permission ask and pressing `Enter` sent **Allow once**. The same holds in every list and
  canvas: `Enter` on a focused button or link is the control's, while a list's or a tree's own
  `Enter` on its selected row is unchanged.
- A push no longer moves focus while a person is working in an Attention card. A new
  permission ask, or a gate answered from somewhere else, used to move focus to another card or
  out of a half-typed note, so the next letters became card shortcuts and `Enter` could answer
  the wrong card. Focus now stays put, and moves to the next card only when the focused card
  itself goes.
- A palette row for an Attention card acts on the card it names, or on nothing. It
  used to act on whichever card was current when it ran, so a card answered elsewhere while the
  palette was open could turn "Answer" or "Cancel the run" into an answer or a cancel for a
  different run. When the named card has gone or changed, nothing is sent and the surface says
  so.
- Holding `Enter` in the command palette no longer confirms a destructive row. The
  key's auto-repeat counted as the second press, so a cancel could run without its confirmation
  being read.
- Keep keyboard focus in Attention when its final focused gate or permission
  card is removed, while preserving focus the user moved elsewhere (PR #646).
- Buttons, menu items, the sidebar's surfaces, segmented controls and the Plan's
  filters are set in the 13px label style the design gives them, rather than the 14px body
  text a font reset gave them by accident, and the schedule's **why** in its caption size.
  Plain buttons set as machine text — validation findings, the editor's graph trail and edge
  links — are in mono again, as everything ORCA produced is.
- Counts agree with their nouns and stay on one line with them. The workflow editor's
  inspector said "1 edges" and "1 nodes", the Plan's decision list "0 of 1 decisions", the
  template editor "1 changed sources", and the workflow inspector "up to 1 attempts"; a count
  such as "4 changes" or "16 nodes" could also break between the number and its word. Every
  count is now written through one helper that picks the noun and joins the two with a no-break
  space, so a line can wrap between counts but never inside one.
- The object header's crumbs and its `…` are set in the 13px label style the design
  gives them, rather than the 14px body text they inherited by accident.
- Run tree rows for a step that never ran line up with the status column again,
  the run summary no longer says its status twice, and a permission rule cut short in a
  narrow panel shows its whole text on hover.
- Deleting from the workflow editor's inspector no longer drops keyboard focus on the
  page. After **Delete** or **Delete with its connections** the selection moves to the next node
  in file order (the previous one if it was the last), after **Delete edge** to the node the
  edge left from, and focus goes to the canvas, where `⌘Z` takes the delete back. The canvas's
  own Delete key moves the selection the same way. Focus moved elsewhere while the delete was
  out stays where it was put.
- **Delete** and **Delete edge** in the workflow editor's inspector are quiet buttons
  instead of red ones on every selection. They still do not ask first, on purpose: each takes
  something out of the unsaved draft, **Undo** (`⌘Z`) brings it back, and nothing reaches the
  workflow file until **Review and publish**.
- First-run setup's **Connect selected local workspace** now says when `ORCA_DAEMON_URL`
  is what stopped it. With that variable set, the launch is pinned to that daemon and setup
  cannot start its own, but the card showed the generic "could not verify the selected
  directories" refusal, which pointed at the folders instead.
- The first-run ownership journal no longer stops the workspace after about 255
  launches. A reservation folds settled history into a verified checkpoint that keeps the
  claim chain head and effective configuration, and a journal that already reached the old
  limit is folded on its next start.
- A commit, pull or branch switch in the selected project no longer invalidates
  the saved first-run selection and strands its store. Reopening checks the repository's
  directory identity; the reviewed branch and base stay in the receipt as provenance.
- A first-run workspace whose last session ended uncleanly before a restart is no
  longer blocked for good. Config offers **Mark previous session ended**, which asks on
  its own row. On confirmation it checks that nothing holds the workspace's startup fence,
  then records a person-confirmed settlement. Startup continues, and retained runs wait
  for explicit inspection. It never happens automatically.
- First-run project setup now says why it refused (for example a non-empty app
  workspace, a project with no branch checked out, Git missing, or an app update in
  progress) instead of one generic "Setup was refused" message. Raw operating system and
  Git text still never reaches the screen.
- The window no longer draws an OS title bar above its own on macOS and Windows.
  The traffic lights and the Windows caption buttons now sit inside the title bar's
  platform insets, follow the theme, and Linux keeps its window manager's frame.
- Graph nodes on the workflow viewer, the workflow editor and the Plan dependency
  graph keep a fixed height, so edges meet them where the layout drew them. A long name used
  to wrap onto as many lines as it took, and a running node's meta line ("running · attempt
  2 · 3 nested graphs") onto several more, growing the box past its slot. Now a node's name
  is at most two lines and its kind and meta line one each, all cut at their end with the
  full text in a tooltip. The full name is still in the node's accessible name, after its
  status, and in the inspector. The node height token, `node-h`, goes from 64px to 96px, and
  a node's padding from 8px to 6px above and below, so the kind, a two-line name and a meta
  line with a status chip fit whole; start and end pills stay as tall as their text and are
  centred in their slot.
- Typing or pasting a run id into the command palette now jumps to runs admitted
  through a request or a direct launch, whose ids are `run_` and a UUID. Only the 26-character
  form was recognised, so the runs started from the app were the ones that could not be
  found by id. A bare UUID without `run_` is still not taken for a run.
- On macOS, only a packaged app mounts the update-recovery startup gate, so
  development runs and the app smoke tests start normally instead of opening only the
  recovery shell.
- A packaged Mac app no longer opens only the recovery shell after Migration
  Assistant, a Time Machine restore, a renamed home folder, a moved or deleted workspace,
  or a crash during first-launch setup or enrollment. An open update window that no
  update attempt holds is re-anchored to its directories' new identities; when its
  records are lost or unreadable, the recovery shell offers a confirmed reset. A recorded
  update attempt still keeps startup closed. Source- and offline-tested only; no packaged
  Mac acceptance is claimed.
- Menus are no longer see-through. Every popover stood on the dialog scrim's
  translucent grey; menus now stand on the raised surface with the popover shadow. A
  destructive menu item is drawn with a `✕` in the danger tone and is never the item focus
  lands on when the menu opens. The guided launch's workspace-root menu says why a root is
  unavailable in a note that wraps, instead of an uppercase line past the menu's edge.
- Menu hints that are machine text are no longer uppercased. A workflow's
  `ai-sdlc · v3 · 7 nodes` in the palette's picker, a run's `status · vN` in the workflow
  viewer, a retained launch's intent id and the crumb menu's `orca://` were set in the
  eyebrow style, which re-cased them; they are now mono and verbatim. Runs in the workflow
  viewer's picker also carry their id token, since runs of one workflow share a name.
- Fix the native updater journal's storage namespace and envelope limit;
  retain interrupted recovery evidence and seal ordinary bootstrap before journal
  commits or handle closure. Native installation and protected-state restore remain
  disabled pending complete writer ownership and recovery contracts.
- The type icons on workflow and dependency graph nodes, and in the editor's palette,
  are drawn with the 1.5px stroke the design gives inline icons, as the canvas controls are,
  rather than a 1px hairline.
- Hovering a command palette row no longer moves the selection, so a stray mouse
  cannot change what `Enter` runs. Clicking a row selects it, so a destructive row armed
  by a click is the one the next `Enter` confirms.
- Saving the Agents policy panel no longer erases a grant written while the draft was
  open, or puts back one somebody revoked. The draft holds the rules of the agents a person
  edited rather than a copy of `orca.permissions.json`, and Save writes them onto the file as
  it is now, so an "allow always" answered meanwhile for another agent is kept; one that
  changed the same agent's rules stops the save with a conflict and **Reload**. What is typed
  while a save is out stays in the draft, and **Discard** waits for the write instead of
  hiding a save that still lands.
- The permission editor now labels wildcard sidecar allows as ignored and explains
  why they do not grant permission, including while editing a draft. Existing saved rules
  remain intact, and permission evaluation is unchanged. Title patterns do not establish
  exact-command approval evidence; that support remains unavailable under #594.
- **Remove** on a written grant in the permission policy panel is a quiet button
  instead of a red one on every grant. It still does not ask first, on purpose: it takes the
  grant out of the unsaved draft, nothing is written until **Save**, and **Discard** brings
  it back.
- Removing a grant in the permission policy panel no longer drops keyboard focus on
  the page. Focus moves to the next grant's **Remove**, to the previous one's if it was the
  last grant, or to **Add a grant** if the list is now empty, and the same happens when a
  re-read takes away the grant focus was in. Focus moved elsewhere stays where it was put.
- Releasing a claim on the Agents surface no longer drops keyboard focus on the page.
  When the release goes through and the claim leaves the list, focus moves to the next row's
  **Release**, to the previous row's if it was the last row, or to the "Claimed work" section
  if the list is now empty. Focus moved elsewhere while the release was in flight stays where
  it was put, and a refused release keeps its row and its focus. The result, which used to
  vanish with the row, is shown under the section's heading.
- Releasing a claim on the Agents surface asks on the row instead of in a menu.
  **Release** is a quiet button at rest; pressing it arms the row in the danger tone, with
  **Keep** (focused, so a second `Enter` keeps the claim) and **✕ Confirm release**, and a
  second line saying what releasing does: the work item goes back to the scheduler, its run
  loses the claim, and another run may claim it. Keep, `Esc`, moving focus away or arming
  another row disarms it, and nothing is sent until Confirm. The controls are named by the
  work item's title. The command palette's release row on the Agents surface now arms on the
  first `Enter` and sinks below the safe commands, as the Plan surface's already did.
- Keep the reader's run and step selection after following a link, while still
  honoring the same link opened again. Hold live lists when keyboard, minimap or output
  search navigation moves to earlier content, so new output does not pull the view away.
- A copied Mac update namespace with missing or torn enrollment cannot take over
  roots whose original namespace still exists. A confirmed reset removes enrollment before
  removing the last startup guard, so an interrupted reset can be retried or provisioned again.
- Run tree rows indent by their depth again. `.orca-tree-row` pads by `--level`,
  which nothing set, so every row sat at level 0 and only the hairline guides moved.
- **Save** and **Discard** on the Config surface and in the permission policy panel no
  longer drop keyboard focus on the page when they empty the draft and the save bar goes away.
  Focus moves back to what the draft was editing: the form's first section or the YAML text on
  the Config surface, the written grants in the policy panel. Focus moved elsewhere while a
  save was out stays where it was put.
- The Plan schedule's **why** links line up. A classified item drew its why inside the
  tinted schedule badge and a settled item drew it after its outcome chip, so the tint ended
  after "why" on some rows and before it on others. Every row is now the mark, then the why —
  a control is never drawn on a state's tint — and the badge and the settled item's chip take
  one width in that column (the longest schedule word, "waiting on deps"), so every why starts
  at one edge. A schedule badge is also never narrower than its word.
- Status chips no longer clip their word, on any surface. The run tree and the Agents
  claims list each held the chip to a 12ch column, narrower than "✓ succeeded"; the run tree
  was fixed on its own and the claims list kept the bug. The chip now sizes itself and is never
  narrower than its glyph and word, and a list whose statuses form one column asks the chip for
  it (`StatusChip`'s `aligned`) rather than setting a width.
- The run summary in step detail no longer scrolls sideways. An object or array
  variable is set as indented JSON in a sunken well under its name, clamped to eight lines
  with a "Show all" button, instead of one compact line that held the pane open; a long
  artifact name truncates inside its chip, whole in its title; and long ids, paths, error
  messages and tool-call bodies break inside the pane rather than running past it.
- An agent card with many roles wraps them inside the card instead of running them
  past its edge and under the card beside it. The card's name no longer breaks at a hyphen
  ("scripted-" over "slow"): it keeps one line and the host label gives way, truncating at
  its end with the whole value in its title. The same fix covers the other places a row of
  labels could outgrow its box: the workflow inspector's kind and attempt chips wrap, a
  request id filter on the Plan rail truncates at its end instead of running past the rail,
  and the titles of the step, run and workflow-editor inspectors, the editor's node list and
  the permission panel's agent id stay on one line, cut at the end with the full text in
  their titles. A run of chips is one class in the component layer, `.orca-chips`, rather
  than a copy per surface.
- Text that does not fit is handled one way everywhere. A label in an outline (a
  chip, a badge, the "pinned" pill, the waiting count in the title bar, a key, a button) stays
  on one line and inside its outline. The save bars and the status bar stay one line: when a
  narrow window runs out of room, their explanatory sentences are cut at the end, with the
  whole sentence on hover, and the change count and the buttons keep their place.
- Upgrade electron-updater to 6.8.11, picking up its upstream fixes for cached
  filename validation, multipart differential downloads and consistent installer/blockmap
  caches. ORCA's update behaviour and Windows recovery contract are unchanged.
- The connection bars and a link's landing notice sit in the primary pane under the
  object header, as `docs/design/40-connection-states.md` places them, instead of stretching
  across the window above the sidebar and squeezing the app into the status bar's row. The
  landing notice appears only when a link could not be honoured (an unknown URL, no daemon
  answering, a work item the plan does not hold, a counterpart the app cannot follow yet);
  a link that worked no longer says "Opened …". Dismissing the notice no longer closes the
  workflow it was about. The Runs left column also no longer spills under the step detail
  when the detail is dragged wide.
- Support reviewed first-run creation of a new private Windows workspace
  under a selected safe parent, using verified token SID and native NTFS identities.
  Native lifetime writer fencing preserves duplicate-writer refusal and receipt
  verification across reopen; unsupported ancestry and legacy Windows receipts refuse.
  Validated on a source-built Windows app, not from a release artifact.
- Keep malformed structured-form scalar values blank instead of coercing objects or
  arrays, and display launch Request identifiers only when they are strings.
- Keep reference selectors focused after structured array and record edits, and
  fit Config fields and review actions within narrow windows and 200% zoom.
- Resolve authorized Request override choices in the mounted launch route, retain
  typed drafts across navigation, verify the reviewed selection provenance before protected
  admission, and recover pending intents under their independent inspection grants.
  Consume confirmed intent abandonment across same-target authority refresh so the next
  explicit launch can be edited while preserving target and permission checks.
- Show authoritative template diagnostics and permit authorized fixture previews
  when source writes are unavailable.
- Yield bounded diagnostics report serialization and exact validation between
  batches, preserving all retained events and exact local export bytes. Capture remains
  disabled pending packaged native performance, memory and privacy acceptance.
- The artifact panel's `[` and `]` keys step through the versions on screen as
  soon as a new version is committed, instead of a stale list.
- Keep the latest adjacent edit to the same configuration field so extended
  typing does not exhaust the structured operation limit. Preserve typed paths,
  structural operation order and review invalidation.
- Windows update timeout and ambiguous installer errors keep admission closed
  instead of silently reconnecting. A proven non-launch abort recovers a first-run
  workspace only after exact-child termination and ownership settlement, through its
  verified saved selection. Uncertain recovery retains evidence and reports failure.
- Keep the selected option and rationale when a plan decision is refused, and
  disable submission while the daemon cannot accept writes. Late responses leave newer
  drafts intact.
- Update a selected step's tool-call rows live as calls start, run, finish or
  fail, while preserving buffered output and permission transitions.
- Committing a matching buffered-output search with Enter focuses the output
  lines, so `n` and `Shift+N` navigate matches without editing the query.
- Plan's Waive and Reopen confirmations focus Keep on opening, return to
  their trigger after cancellation or refusal, and preserve focus in the inspector
  when a dependency or decision changes. Late results leave newer questions and
  focus moved elsewhere alone.
- Keep configuration variant reviews available through unchanged rerenders while
  invalidating reviews when the union value, path or schema changes.
- Refresh mounted Produced artifact chips and panel version lists when matching
  artifacts are recorded, preserving the selected version, comparison and immutable bodies.
  Show metadata failures beside the version choices while keeping loaded bodies and diffs visible.
- Keep uncommitted workflow inspector text and selection while the definition
  refreshes, with visible refresh errors and changed-definition status.
- Connect a workflow pointer wire once under StrictMode. Cancelled or
  unrelated pointers cannot complete the wire or move its node (PR #686).
- Keep workflow inspector text and validation errors with their selected node or edge,
  so leaving an equal-valued field cannot write another selection's text. Preserve focused Id
  input during renaming and unsent text while the current selection refreshes.
- Retire workflow publish reviews when the draft changes or write access is lost,
  and ignore late review responses after editing resumes.
- Retire configuration review evidence queued during setup reads before a new
  action, so a failed rereview cannot leave a stale saved-configuration Bind control.
- Ship a `.deb` for Linux x64 and arm64 and make it the supported Linux install.
  On stock Ubuntu 24.04 the `tar.gz` aborted before its first window because Chromium's
  sandbox could not start; the package's install script loads an AppArmor profile for
  `/opt/ORCA/orca-desktop` alone, so the app starts with its sandbox on and nothing else on
  the system changes. The Linux executable, package and desktop entry are now
  `orca-desktop`, apart from Ubuntu's `orca` screen reader. See `docs/INSTALL-LINUX.md`.
  (#853)
- a refused protected-storage key is now a specific, actionable state in guided
  launch instead of a generic error. Cancelling or ignoring the Linux keyring prompt, a
  locked keyring or one not set up yet, a session with only `basic_text` storage and an
  unavailable OS keychain each name their cause and say what to do. On Linux that is quit
  and reopen ORCA and follow the system prompt to create or unlock the keyring, because the
  keyring is asked only once per app start; an unavailable OS keychain offers Retry launch
  with the same reviewed command. If the refusal happens before submission, nothing is
  submitted, and there is still no plain-text fallback. A launch the daemon accepted before
  storage refused its receipt, or one that may already be retained, stays on the recover
  path until ORCA has read its retained launches.
- On Linux under Wayland (stock Ubuntu 24.04 Desktop), the app no longer starts with
  no window. The window was shown only when Electron reported its first paint, and a hidden
  Wayland window often never paints, so the daemon and renderer ran with nothing on screen.
  The window is now also shown half a second after its page loads, or four seconds after it
  was created, whichever comes first.

#### cli

- Safely render malformed event and plan journal display fields without object
  stringification. Legacy gate labels, structured journal JSON and stored events are preserved.
- With `humanInput: { mode: cli }`, the terminal prompt shows the published question
  and options, with sensitive values withheld as `orca status` shows them. Answers are
  unchanged.
- `orca validate` preserves absolute workflow filenames and globs instead
  of prefixing the working directory. Relative arguments still resolve from the
  working directory, and configured defaults from the config directory.

#### daemon

- `config.get` leaves a sidecar wildcard `allow` out of the effective policy, as
  evaluation does.
- `inputs.answer` refuses an `always` whose one-time answer goes the other way
  (`NOT_SUPPORTED`), before anything is answered or written.
- Reject fresh stale continuation intent before reserving a retry operation
  or continuation ID, while retaining successful replay and lost-ack recovery.
- Closing a daemon now waits for dispatched RPC method handlers after
  closing HTTP and WebSocket transports. A caller disconnect still does not cancel
  an admitted operation; shutdown no longer reports settlement while its handler
  can still write.
- Require raw configuration read authority for every Save/validation receipt.
  Recheck credentials and grants after reads and before configuration or permission-sidecar
  replacement and generation activation; remove staged files on refusal. Apply continues
  to require configuration write authority alone and returns no raw editor bytes.
- Validate Request descriptors and selections against the exact captured
  configuration and workflow before admission. Suppress sensitive schema defaults and refuse
  overrides for direct workflows that cannot carry them.
- Track exact partial consumers, reject blank template IDs, and record Apply
  history from the reviewed source revisions.
- A competing continuation reconciliation refused with `RUN_LEASED`
  preserves the winning receipt, including before execution lease acquisition.
  Retained-key replay no longer publishes a transient blocked state; the winning
  continuation still records one decision, attachment, execution and settlement.
- Graceful shutdown now settles background direct-admission receipt
  verification before exiting, so its event-lock owner publication cannot be
  interrupted by a normal restart. Workflow execution keeps its existing lifecycle.
- A socket closed or revoked while subscription authorization is pending
  no longer attaches a source listener or starts replay when authorization finishes.

#### engine

- Permission-ask options from an ACP `reject_once` / `reject_always` kind are marked
  `destructive`.
- A `parallel` branch or `custom:plan-dispatch` item that starts after another
  has finished no longer sees that sibling's artifacts, and neither do sequential siblings
  bound to different work items. A program dispatching two items at a time no longer hands
  the third item an earlier item's `testReport` and `review` as feedback for its first build.
- Skip dependency reconciliation for unchanged artifact signals while
  retaining replay recovery after a saved decision encounters a journal or reconciliation failure.
- Validate all builtin plan and program custom-node fields at workflow
  load time and before execution, preserving omitted defaults, templates and
  sparse scheduling policy overrides.
- Refuse unregistered Request item-workflow defaults and caller selections
  before admission, using the captured configuration's workflow registry.
- Reject malformed artifact YAML through the existing bounded repair prompt;
  skip malformed optional deliverables and preserve operational error propagation.

#### examples

- The beta first-job fixture (`examples/beta-first-job/fixture.js`) runs on Windows.
  It pointed Git's global configuration at `NUL` there, which Git for Windows refuses as a
  config path; it now uses `/dev/null`, which Git for Windows also reads as the null device.

#### integrations

- Preserve original ACP permission option IDs, kinds, labels and
  order in non-live forwarding; refuse invalid metadata and unknown answers rather
  than fabricating allow/reject choices. Exact-command live approval remains
  unsupported (PR #674).

#### store

- Discard failed document mutation batches when directory setup or lock
  acquisition fails, so reads and later writes do not revive rejected changes.
  Preserve mutations queued for subsequent writes.
- Publish content-addressed artifact blobs without overwriting shared bytes,
  synchronize them before indexing, and reject corrupted bodies on read or reuse.
  Existing blob paths and index records remain compatible; no migration is required.
- For a run with sensitive launch inputs, `agent.turn.started` publishes
  `promptPreview` as `[REDACTED]`. A rendered prompt can hold a sensitive value formatted as
  YAML, transformed by a template function or cut at the 400-character preview bound, which
  literal scrubbing cannot recognize. `promptHash` and the encrypted original are unchanged,
  and event logs written earlier are not rewritten.
- A sensitive `itemWorkflow` input is withheld from public launch provenance. Its
  source, and an explicit `itemWorkflow` override, stay visible.
- Replay validated accepted retry receipts during catalog acquisition
  contention, retaining authorization, intent comparison, operation locking and
  durable receipt checks without allocating or repairing retry state.

#### testing

- Serialize shared scripted-agent counter transactions across processes,
  preserving failure and cancellation consumption behavior in concurrent demos.

## 0.6.0 - 2026-09-29

### Store format

`PlanKeySchema` is stricter: a plan key is now at most 48 characters and cannot end in `-`.
Keys ORCA generates through `slugify` always had that shape, so a store built by ORCA is
unaffected. A store whose plan journal holds a hand-written key (front matter `key:` or a work
item `slug`) longer than 48 characters or ending in `-` fails to parse on replay and has to be
edited by hand; there is no migration.

`run.created` payloads may now carry `workspace.previousBranch`, an optional string: the branch
(or detached commit) a `local` workspace was on before ORCA checked out the work item's
`orca/<slug>` branch. It is additive; existing stores need no migration, and runs created
before this change simply lack it.

The store gains a `workflows/` directory: `startRun` keeps the definition each run starts on
as `workflows/<id>@v<version>.json`, written once, and a resumed run walks that definition
rather than the file on disk when the file has moved to another version. `run.created` gains
an optional `workflowStored: true` saying the definition was kept. Runs that predate this
carry no `workflowStored` and have no stored definition; they resume on whatever workflow file
is current, exactly as before. Nothing needs migrating. A run that does carry
`workflowStored` but whose version is neither in `workflows/` nor on disk (a store copied
without that directory) refuses to resume with `WORKFLOW_VERSION_NOT_FOUND`.

`run.created` gains an optional `overrides` field carrying the run's selection record (role
→ agent, model, item workflow, template pack), so a replay resolves the same agents the live
run did even after the config's role mapping changes. It is additive: run logs written before
v0.6.0 have no such field and read as a run with no overrides, and nothing needs migrating.
An older ORCA reading a v0.6.0 store drops the unknown key rather than failing, so such a
run replays there with the config's role mapping instead of its recorded selection.

`agent.session.opened` gains an optional `model`: the model the session was opened on — the
run's selection as applied, or the agent's own current model when the run selected none. Logs
written before v0.6.0 have no `model` and read as before; nothing needs migrating.

### Added

- cli: Add the standalone Debian `orca-release` deployment adapter with versioned staging, pinned-toolchain builds, CLI/ACP launch locking, atomic activation, hello checks and compatibility-aware recovery. Resolve shipped workflow and template paths to the selected concrete release.
- protocol: Add protocol 1.8 daemon admission preparation for safe local maintenance, with no installation endpoint. 1.8 also covers the v0.6.0 additive fields (#312: `resultIsPreview`, `workflowPinned`, step `model`, workflow `pinned`, `WORKFLOW_VERSION_NOT_FOUND`).
- app: Add explicit Windows NSIS update checks, downloads and guarded restart from the header and command palette. Private HTTPS feed credentials stay in the main process; drafts and bundled-daemon work block restart.

#### agents

- an agent session keeps the config options its agent advertises in `session/new`
  (a model list, a mode, a reasoning level) as `AgentSession.configOptions`, normalised into
  ORCA's own `SessionConfigOption`; legacy `modes` become one select with `category: "mode"`,
  and `configOptions` wins when an agent sends both. `setConfigOption(configId, value)` sends
  `session/set_config_option`, an unsolicited `config_option_update` refreshes the cache and
  is logged as an agent update, and ORCA now tells agents it can set boolean options. The
  scripted agent advertises a configurable option set (`configOptions` on the playbook and on
  `scriptedAgentSpec`).

#### app

- Plan gains a Dependencies mode: the plan's dependencies as a derived, layered
  graph (pan, zoom and select, never dragged) with work items, decisions and external targets
  as nodes of their own kind, each dependency's kind as its stroke and its state as its colour
  and in words, and the `blocks` cycles `schedule.get` reports drawn heavy. The selected
  schedule row is the focused node and back, the row filters are shared and a second rail
  holds the graph's own controls, a pinned strip under the canvas shows the selected item's
  row, and the docked panel holds the relationship inspector — blocked by, blocks, and a waive
  that names what it unblocks and updates the graph from its own answer. The canvas's keys
  live in a new `plan-graph` scope. `orca://plan?mode=deps&focus=<id>` opens it, and a work
  item's "Dependencies" counterpart now follows that link.
- the workflow canvas's layout is now `layoutGraph`, a plain `{ nodes, edges }`
  layout with many roots; `layoutWorkflow` is a thin adapter over it. No new dependency.
- Plan gains a Risks mode: the plan's likelihood × impact matrix, sized by its own
  `riskMatrix.scale` and banded by its own thresholds, with every risk labelled in place (key
  in mono, title in sans), cells above the plan's risk appetite outlined, and the critical band
  hatched so it separates in greyscale. The risk register sits under it behind a stacked,
  remembered splitter (`plan-risk`), the filter rail is the schedule's, and selecting a risk
  opens its status, the work items it holds and the journal entries that name it in the docked
  panel, whose head now names what it is showing.
- Plan gains a Decisions mode: the plan's decisions as a list over the selected
  one's weighted matrix — criteria with weights and direction, options with scores, the
  weighted totals, and the recommended column outlined in accent, with `close` or `tie` said
  beside a recommendation that was not clear, and a preview labelled as one. A person decides
  from a column (with an optional rationale, sent exactly as `orca plan decide` sends it) or
  from the palette; a decided decision shows who, when and why, and reopening asks once,
  naming the items whose dependencies it reopens. The list and the matrix are split by a
  stacked, remembered splitter (`plan-decision`).

#### cli

- `orca status` names each step's agent and model, and `orca events` shows the model
  on the session line; the daemon's `runs.get` step view carries `model`.
- `orca run` takes `--agent <role>=<agentId>` and `--model <agentId>=<modelId>`, both
  repeatable, plus `--model <modelId>` alone when the run uses exactly one agent and
  `--template-pack <name>`; `orca submit` and `orca plan dispatch` take the same flags and
  `--item-workflow <id>`. They become the run's selection record, so an unknown role, agent,
  model or workflow is refused with the known set before the run starts.
- `orca plan dispatch --workflow` is documented as choosing the *program* workflow,
  and one without a `custom:plan-dispatch` node is refused with `CONFIG_INVALID`.
- `orca agents` lists each agent's declared models with the default marked, and the
  models a running daemon has discovered, or "not probed".
- `orca validate --template-pack <name>` reports which templates the pack overrides
  and which the validated workflows inherit, and fails with `TEMPLATE_NOT_FOUND` on a pack that
  overrides nothing; `orca run`/`submit`/`plan dispatch --template-pack` refuse such a pack
  the same way.
- `orca validate` loads the configured plugins first, so it reports what an
  executor says about its node under the node's path (`nodes.jevShadow.rubric`), and
  bootstrap refuses to start on the same errors, the way it does for a missing template.

#### core

- `RunOverrides`, a per-run selection record — `roles` (role → agent id), `model`
  (one model id, or agent id → model id), `itemWorkflow` and `templatePack` — recorded in
  `run.created` and projected onto `Run.overrides` and `RunSummary.overrides`. `AgentSpec`
  gains optional `models` and `defaultModel` declarations.
- `TemplateRegistry.packs()` lists the packs present, which the CLI's pack check and the
  ACP facade now share.
- Template packs. `TemplateRegistry.get(id, { pack })` tries `<pack>/<id>` and falls
  back to `<id>`, so a pack overriding one template inherits the rest; an agent step renders
  from the run's `overrides.templatePack`. `templates/strict/` ships an example pack with a
  stricter `sdlc/review`, loaded by the default `templates` glob.

#### daemon

- `workflows.get({ id, version })` answers a stored older version instead of
  refusing it, and `WorkflowView` carries `pinned` (the view is not the version on disk);
  `runs.get` adds `run.workflowPinned`, and its traversal edges come from the run's pinned
  definition.

#### design

- `stroke-dash-soft` and `stroke-dash-informs`, the `.orca-dep-edge--*` stroke
  and state rules and `.orca-dep--open|failed`; `DependencyNodeProps` corrected against the
  graph (no `kind`, no `onWaive`).
- `RiskMatrixProps` in `component-api.d.ts` corrected against the wire — a variable
  `scale`, `thresholds`, an `appetite` level word, and risks by `key` and `title` — and the four
  `risk-*` grounds documented as the four core levels rather than fixed 5×5 score bands.
- `DecisionMatrixProps` corrected against the wire (`key`/`name`, criterion
  `direction`, `scale`, `result`, `onChoose`), and the recommended column of `.orca-matrix`
  outlined in accent.

#### engine

- a run is pinned to the workflow version it started on. Publishing a new version
  affects runs started afterwards; a run already under way resumes and finishes on the
  definition it began with, kept in the store's workflow-version store. `orca resume` on a run
  whose version is neither stored nor on disk fails with `WORKFLOW_VERSION_NOT_FOUND`, naming
  the versions that exist.
- `startRun` takes `overrides`, refuses an unknown agent or an unfilled role with
  `AGENT_NOT_FOUND` before the run is created, and hands every step a run-scoped view of the
  agent registry (`AgentRegistry.withOverrides`) instead of changing the shared one. Child
  runs inherit their parent's overrides. `plan-dispatch` picks its item workflow from the
  node's pin, then `overrides.itemWorkflow`, then `vars.itemWorkflow`; `ProgramService.submit`
  accepts `overrides`.
- a run's selected model reaches the agent. After `session/new` the model from
  `run.overrides.model` (or the agent's `defaultModel`) is set through the session's
  `category: "model"` config option; an agent that offers none runs only on a model its config
  declares in `models`. A model in neither place fails the step with `AGENT_MODEL_NOT_FOUND`,
  listing what is available, before any turn starts and without a retry. A pooled per-run
  session whose agent drifted off the run's model has it re-applied before the next step, and
  is closed and reopened if the agent refuses.
- `Orchestrator.onAgentSessionOpened(listener)` hands each downstream
  `AgentSession` to in-process listeners as it opens.
- a `NodeExecutor` may declare `validate(node) => { errors?, warnings? }`, and
  `NodeExecutorRegistry.validateNode` hands it to `validateWorkflow` through the new
  `ValidationContext.validateCustomNode` hook, so a plugin's custom node is checked when the
  workflows are loaded rather than when a run reaches it. A `custom:*` type no executor
  registers is a warning saying its fields were not checked.
- a decision's `source: { kind: artifact }` (and `kind: agent`) reads `field` as
  a dotted path into the artifact's data, so `field: answers.conflict.choice` routes on a
  nested record such as a `custom:jev-eval` evaluation without an expression that names the
  producing node. An exact top-level key wins over a nested path, preserving literal dotted
  front-matter keys. A deliverable's `validate.requiredFields` and `validate.fieldValues`
  use the same rule.

#### integrations

- the ACP facade advertises session config options in `session/new` and
  handles `session/set_config_option`: `orca/workflow` (category `mode`: submit a Request
  through the program workflow, or run one workflow directly with the prompt as `vars.prompt`),
  `orca/item-workflow`, one `orca/agent.<role>` per role the configured agents fill (grouped
  by host when the candidates span hosts), `orca/model` (category `model`) and
  `orca/template-pack`. A client that advertises boolean config options also gets
  `orca/use-client-cwd`. The choices become the next run's `overrides`; a client that sets
  nothing gets exactly the previous behaviour.
- the ACP facade's `orca/template-pack` option lists the template packs in the
  registry (the shipped `strict` pack among them); choosing one records `overrides.templatePack`
  for the next run.
- the ACP facade's `orca/model` lists real models. At `session/new` it offers
  each agent's declared `models` (or just "agent default"); when an agent's first downstream
  session opens, its advertised options replace the declaration and every open facade session
  receives a `config_option_update`, cached per agent for the facade's life. The select is
  grouped by agent when more than one agent offers models, and choosing one records
  `overrides.model` as `{ <agentId>: <modelId> }` for the next run. Downstream options in the
  other reserved categories (`mode`, `model_config`, `thought_level`) are proxied as
  `orca/<agentId>/<configId>`.
- the ACP facade advertises `/run <workflowId> [key=value ...]` and `/status`
  as ACP `available_commands_update` after `session/new`, so clients render them as real slash
  commands. An unknown `/word …` prompt (or a bare `/run`) now answers with the command list
  instead of being submitted as a Request titled `/word …`.
- `custom:jev-eval`, a proof-of-concept node that judges explicitly selected
  artifacts with TypeSafe's JEV primitives (Choice, Score, Noul) and records an `evaluation`
  artifact carrying the rubric version, input provenance, resolved model, answers,
  distributions, confidence and token usage — never a credential. Opt-in through
  `plugins: ["@orca/integrations/jev-eval"]` with `TYPESAFE_API_KEY`; thresholds and routing
  stay in `decision` nodes reading `steps.<node>.result.data.answers`. An example shadow
  workflow lives in `examples/jev/`; `docs/INTEGRATIONS.md` has the setup, the bounded-input
  rule and the live smoke procedure.
- `custom:jev-eval` validates its node at load time with the schema it
  already parses at run time; a missing `rubric:` or a `model: jev-latest` now fails
  `orca validate` instead of the run.

#### protocol

- `DecisionView.resultIsPreview`. A decision with no stored `result` now
  carries the matrix's recommendation computed on read (`core`'s `evaluateDecisionMatrix`),
  flagged `resultIsPreview: true`; nothing is written.

### Fixed

#### core

- `PlanKeySchema` now bounds a plan key to `SLUG_MAX_LENGTH` (48) characters and
  rejects a trailing hyphen, so a key authored in front matter has the same shape as one
  `slugify` generates. `SLUG_MAX_LENGTH` moved next to the schema in `model/plan.ts` and is
  still exported from `@orca/core`.

#### engine

- the `local` workspace provider, when its directory is a git checkout and the run
  is for a work item, checks out `orca/<slug>` (creating it from the current HEAD, or reusing
  it) and returns it as `workspace.branch`, recording the branch it replaced as
  `workspace.previousBranch`. The build agent no longer picks a branch of its own and leaves
  the shared checkout on it; the previous branch is recorded, not restored.

#### templates

- `sdlc/build` and `sdlc/deploy` name `{{ workspace.branch }}` when there is
  one, instead of "the current branch".

## 0.5.2 - 2026-09-22

### Store format

Event logs, artifact indexes and claim records retain their existing schemas.
Lease records add backward-readable `guardedTtlMs`, `guardedHost` and `guardedId`
coordination metadata. Existing on-disk TTL and host fields contain sentinels that
prevent older automatic TTL/PID takeover; upgraded readers restore the actual values.
All legacy or unreadable leases require quiesced recovery, even after a legacy PID
has died. Mutexes use transient directories with unique owner tokens, preventing a
delayed stale remover from deleting a successor. Abandoned legacy lock files and
empty/unknown mutex directories also fail closed. Stop old writers and use upgraded
administration tools; see `docs/v0.5.2-ownership-compatibility.md` for recovery and
downgrade limits.

### Changed

#### tools

- Gate release publication on Electron smoke and all three platform type proofs of the release merge commit, without automatically updating baselines.

### Fixed

#### agents

- Resolve Windows drive and UNC paths against the workspace when evaluating and
  recording permission rules, preserving configured rule precedence.
- Reject silent initialize and session/new handshakes at their configured timeout
  and clean up the failed transport.

#### app

- Keep pending run-detail reads alive across ordinary rerenders and make renderer test synchronization deterministic; reduce redundant queries in the ten-thousand-event paging regression.
- Announce pane restoration through the shared accessibility channel, including the count restored by the palette command.
- Reconcile missed run, input, agent and selected-run state after subscription reattachment, including outages too short to show a connection banner.
- Preserve newer notifications across delayed initial snapshots and resolving reads; a stale read no longer rolls back completion or reopens an answered input.

#### cli

- Reject unknown flags and values on boolean flags. Command help now describes the
  selected command, including the plan subcommands (#113).
- Decode the demo's repository file URL correctly on Windows, so its generated
  configuration locates the shipped workflows and templates.

#### core

- Reject malformed dependency references at decomposition and artifact-signal input boundaries with a field path, while keeping previously stored raw references readable.

#### design

- Ignore CSS comments when checking declaration literals, preserving accurate locations for real violations.

#### engine

- Preserve decided choices and their rationale during automated matrix evaluation; explicit human overrides and reopening remain available.
- Render decomposition, risk assessment and design prompts with the current plan risk scale instead of a hard-coded 1–5 range.
- Clear stale decision rankings when matrix inputs change or a decision is reopened, recording the invalidation in the plan journal.
- Repair abandoned work-item projections before releasing claims: missing children become pending, unowned interrupted children are durably cancelled before redispatch, and recorded terminal outcomes are preserved. Live or parked children remain in progress.
- Reopen failed as well as satisfied dependencies when their decision is reopened, keeping persisted state and the journal consistent with scheduling.
- Warn when a plan-dispatch node pin shadows the configured item workflow, and record the selected default and its source in the step result.
- Resolve a declared work-item input from the stored item or validated
  `vars.workItem`. Missing or malformed task context fails before an agent opens,
  rather than rendering an unspecified task and collapsed artifact paths.
- The shipped SDLC workflow checks the deployment report before reporting
  delivery success. A blocked or unrecognized status produces a failure outcome;
  the deploy report remains the evidence for PR and CI status.
- Collect agent deliverables from a fresh directory for each run and
  step visit, including retries and back-edges. Old reports remain explicit stored
  inputs and cannot satisfy a new output contract in either completion mode.
- Fence execution writes, artifact recording and work-item projection
  under the same ownership guard as lease mutation. Expired heartbeats stop local
  execution even when renewals fail or hang; obsolete holders cannot replace a
  successor's lease or append after a forced takeover.
- Accept one answer to a parked human-input request under concurrent
  callers. Validation rereads the durable log under ownership, shared with resume
  and cancellation, so a later answer cannot replace the accepted choice.
- Recover a persisted terminal step's outcome and message after a crash
  before run completion, without rerunning its executor or side effects.
- Settle Requests using the program's actual outcome and return the updated
  persisted Request. ACP submissions now use the same settlement as CLI submissions (#292).

#### integrations

- Show child-run workflow nodes in ACP plans beneath their owning container,
  prefixed with the workflow chain.
- Suppress identical ACP plan snapshots, preserve update order, and label
  failed, cancelled and skipped steps explicitly instead of showing them as pending.

#### store

- Serialize artifact-index appends across processes, recover torn trailing
  writes, warn on corrupt JSON, and refresh readers after another writer appends.
- Retry transient Windows sharing violations while waiting for a mutation lock, preserving the current holder and the existing bounded wait.

## 0.5.1 - 2026-09-21

### Store format

No change.

### Added

#### app

- Every pane boundary in the window is draggable, and the width is remembered. The
  sidebar, the docked panel, the Runs step detail, the run tree over the event timeline, the
  Plan request rail and the workflow node inspector each carry a `role="separator"` with a tab
  stop, `←`/`→` (or `↑`/`↓`) by one grid step, and `Enter` or a double-click to put the
  boundary back where the design had it. Each has a floor and a ceiling so a drag cannot make
  either pane unusable, each stays out of the way of the collapsed sidebar and the overlaid
  panel below their breakpoints, and each size is kept per boundary in the app's own
  preferences file beside the density choices.
- Config's **App preferences** section now lists every pane boundary that has been
  dragged — its size, and a **restore** that puts it back where the design had it. A pane
  width is the one remembered appearance a person can set by accident, and until now the only
  way back was `Enter` or a double-click on the boundary itself, which nothing said. A
  boundary still at its default is not listed, so the section does not grow five rows that all
  read "default".
- **Restore the pane widths** in the command palette, with no key, forgets every
  remembered boundary at once.

#### design

- `--splitter-thickness`, `--pane-step` and the five `--pane-min-*` / `--pane-max-*`
  size tokens, with `PANE_GEOMETRY` in `@orca/design` for the arithmetic a `var()` cannot do;
  `.orca-splitter` in the component layer. A pane's width is now
  `var(--pane-<boundary>, var(--<token>))`, so the token stays the single statement of the
  default and a dragged width is an override of it.

### Changed

#### app

- the Electron smoke test now *measures* scrolling rather than taking the
  stylesheet's word for it. With the window shrunk too short for any surface, each surface and
  the docked panel have to overflow the box they say they scroll, take a scroll to its end,
  and have their last content on screen when they get there. The renderer's sweep runs under
  happy-dom, which has no layout engine and so can only check the declaration.
- the run tree's share of the Runs left column is remembered as a **ratio** rather
  than a height in pixels, so a split chosen on a tall monitor is the same split on a laptop.
  It is the one boundary between two stacked panes, where what a person chooses is "more tree
  than timeline" and not a length; the four boundaries between two columns are still px,
  because a side pane is sized to what it holds. The drag, the arrow keys and the separator's
  reported position are unchanged.

#### design

- `.orca-attn__row` is bound to `--row-h` like every other row class, rather than
  being padded to a height of its own. The Attention surface's failed-runs and running-runs
  lists are virtualised, and the virtualiser reads a row's height back off that token, so a
  padded row was a row the window arithmetic was wrong about. The app's own correcting
  modifier is gone with it.
- `.orca-agent__health` — the glyph-and-word an agent card leads with — is in the
  component layer next to `.orca-agent__name`, where the rest of the card already was. It was
  written in the Agents surface's own stylesheet because nothing named it here.

### Fixed

#### app

- surfaces no longer clip content that outgrows the window. The Attention surface
  scrolls at its root, so gates and permission asks below the fold are reachable instead of
  silently cut off, and the failed-runs list keeps a floor rather than being squeezed out by
  a tall stack of cards.
- the docked panel scrolls its body, so anything a surface puts in the dock — the
  Plan inspector today — is readable to the end whatever the window height, with the panel's
  header staying put above it.
- the Agents surface scrolls its cards again in a short window. It is a split
  layout — cards beside the policy inspector — but it scrolled at its root, and the split
  under that root shrank to the window while the host sections and the claims inside it
  spilled out below its bottom edge: the scrollbar moved a box the content had already left,
  so the claims were unreachable. The cards column is the scroll region now, the summary
  above it stays put, and the inspector beside it still scrolls on its own. Found by the
  measuring smoke test in the same release (#277).

#### design

- `.orca-main` and `.orca-panel` are bounded by the window (`min-height: 0`)
  rather than stretching past it, which is what gives a scroll region inside a surface a
  height to scroll against; `.orca-panel__body` is the dock's scroll region.

## 0.5.0 - 2026-09-21

### Store format

A `.orca` store now has a `<file>.lock` beside each of its document collections —
`requests.json.lock`, `work-items.json.lock`, `plans.json.lock` and so on — because every
`JsonFileDocumentStore` mutation runs inside that lock (#196). The lock is created when a
write happens and removed when it finishes, so one is only on disk while somebody is
writing, or after a process died mid-write; a stale one is broken by the next writer on the
same rules the JSONL logs have always used, and a lock file is never a thing to clean up by
hand. Nothing reads them but ORCA, they carry no data, and a store copied or committed with
one in it loads exactly as it would without.

The collections themselves are written through a temp file named with a random tag rather
than the writing process's pid alone, and flushed before the rename, so a crash or a power
loss mid-write can leave a `<file>.<pid>.<tag>.tmp` behind but can never leave the
collection itself half-written. A leftover `.tmp` is safe to delete.

An artifact's body is now bytes rather than a UTF-8 string, so a PNG, a PDF or any other
binary an agent produces round-trips through the store intact. **No field was added to
`artifacts/index.jsonl` and no blob has to be rewritten:** a blob is still a file named by
the sha-256 of its content, and hashing a string in Node hashes its UTF-8 bytes, so every
blob an existing `.orca` store holds is already the same file under the same name. An index
written by an earlier ORCA loads unchanged.

One value written into the index does change meaning. `size` is now the body's length in
**bytes**; it was its length in characters, which was the same number only for pure ASCII.
Nothing computes with it — it is what the artifact panel shows and what `artifacts.get`
quotes when it declines to carry a body — so an old row's `size` is read as it was written
and is at most slightly low on prose with an em dash in it. New rows are exact.

### Added

#### agents

- `replacePermissionPolicyFile` and `parsePermissionPolicyDocument`, the
  operator's half of the sidecar writer.

#### app

- `window.orca.plan` and `window.orca.claims.release` on the preload bridge, so the
  Plan surface (#170) and the palette's write actions (#178) have something to call.
- the Plan surface — what is coming, why it is not moving, and what it depends on.
  The schedule table lists every work item in the order the scheduler put it, with its
  classification, slug, title, priority score, risk exposure and the run holding its claim;
  the badge's **why** opens the scheduler's own explanation, word for word, in the app's one
  popover. `orca://item/<slug-or-id>` lands here with that item selected and its explanation
  open, which is the last line of the deep-link table that named an unbuilt screen.
- the Plan sidebar is requests and filters, not a list of sub-screens (option B in
  `docs/design/80-dependency-graph-options.md`). Classification, status and request are
  `items.list` parameters the daemon applies to the whole plan; the text field narrows what
  is held, and the count says which — "3 of 9 items". The counts beside each classification
  are the plan's own.
- selecting a row opens the work-item inspector in the docked panel — the panel is
  a Plan surface as well as a Runs surface now. It shows the priority reasons verbatim, the
  item's dependencies with **both** the status stored on the document and the scheduler's
  live evaluation of it, the risks that name the item, and the claim as a link to the run.
  Every write on this surface is still the palette's (#178).
- a Journal mode over the plan journal: newest first, one row per entry with the
  daemon's own summary line and the origin that wrote it, paging backwards with "Load
  earlier entries". The surface repaints from `plan.changed` and never polls — a frame's
  `kinds` say which lists went stale, and a sequence number already folded is dropped.
- the object header gained a mode segmented control, a new `ObjectHeader` variant
  (`ObjectHeaderProps.mode`). It has two positions; the dependency graph (#171), the risk
  matrix (#172) and the decision matrix (#173) are absent from it rather than disabled,
  because a segment that never does anything is a dead end.
- a `plan-journal` scope in the keyboard map, for the second list on the screen —
  one `VirtualList` per scope, so `J` means "next" in whichever of the two the focus is in.
  `Enter` on a schedule row explains it. `docs/design/50-accessibility-and-keyboard.md` has
  the table; every key in it is in the command palette.
- the schedule table carries the **request** an item was decomposed from and the
  item's **own status**, which is not the classification beside it — the classification is
  where the scheduler put the item, the status is what the item says about itself, and an
  item is routinely `pending` *and* `ready`. The status is a plain chip with its own word
  and glyph; the tinted chips still mean a run status and nothing else.
- the table pages. `items.list` answers a window, so the surface sends its own
  `limit` and walks it with `offset`; "Load more items" appends the next page in place,
  leaving the rows and the selection where they are. The count is about what is held, so it
  no longer claims rows that were never read.
- a `plan.changed` frame re-reads the table *in place*. It used to blank it, which
  dropped the selection, tore the inspector out of the dock and put it back a tick later —
  a repaint is not somebody asking a different question. A filter still blanks it, because
  that is one. The inspector's dependencies and risks re-read on a frame too, so the stored
  status and the live evaluation beside it cannot drift apart.
- the plan journal's rows are selectable. `J`, `K` and the arrows moved the scroll
  but never the selection, and `aria-activedescendant` was never set. `Enter` on a journal
  row still does nothing — those acts are #171's and #178's — but a screen reader is now
  told where it is.
- the docked panel opens on a *selection*, not on the inspector's content
  changing, so `⌘\` right after clicking a row no longer closes a panel that comes straight
  back. And a deep link is acted on once: `orca://item/<slug>` no longer drags the surface
  back to Schedule on every later frame.
- a `schedule.explain` that fails is shown as an error rather than as one of the
  scheduler's lines — an error among them was a menu row a person could choose and copy, as
  though ORCA had said it about their work item.
- `window.orca.config.get` / `.set` on the preload bridge and `DaemonClient`.
  Plumbing for the Configuration and Agents surfaces (#175, #176); no UI yet.
- `workflows.list` and `workflows.get` on the daemon client and the preload bridge
  (`window.orca.workflows`), ready for the workflow viewer. No UI yet.
- the Config surface. `orca.config.yaml` as a form over the schema the daemon
  describes — a field per key with its dotted path shown, a `Menu` for an enum, a card per
  element of `agents:`, and whatever the schema cannot describe as read-only JSON — beside
  the raw file, editable, with **raw** on any field jumping to the line that key is written
  on. The save bar counts what would be written rather than what was typed, validates
  without writing, places the daemon's errors on the fields they name, and refuses to lose a
  draft when somebody else edited the file: `CONFIG_STALE` shows the conflict and offers
  **Reload**. `⌘S` saves, and the command palette lists it.
- Config shows the ADR 0009 permission sidecar as its second document (#266): each
  agent's effective policy in the order ORCA evaluates it, every rule chipped `config` or
  `sidecar`, the machine-written ones carrying when they were added and which tool call was
  answered "always", and the fallthrough named as the config's. It is readable here;
  editing grants is still to come.
- the app's own preferences — theme and per-surface density — are a section of
  Config, labelled as stored by the app rather than in `orca.config.yaml`, and save the
  moment they are chosen. There is still no settings screen.
- `orca://config` and `orca://config/permissions` open the surface on the document
  they name.
- the form and the save bar are absent, not disabled, in file mode and against a
  daemon whose `hello.methods` has no `config.set` — the method the button calls, which the
  connection snapshot now carries, rather than the `runs.control` capability above it.
  Disconnected and reconnecting keep the bar and the change count, with the reason on
  Validate and Save.
- a configuration draft survives going to another surface and coming back: the
  draft model is mounted above the surface switch, and the Agents surface's policy panel
  reads the same one rather than a second copy.
- an agent card carries **Permissions**, which opens that agent's policy as an
  inspector beside the cards: the whole effective policy in the order ORCA evaluates it, with
  the configured rules read-only — they are `orca.config.yaml`'s, and the panel links to the
  Config form rather than rewriting an array a person curated — and the `orca.permissions.json`
  grants editable. A grant can be removed, narrowed or widened by kind, path, path prefix,
  scope or title pattern, or added by hand, in which case it records the time and
  `granted for added by hand in the app` so a reader of the diff can tell it from one a run
  wrote (ADR 0009, #266).
- saving a grant sends the whole sidecar as `config.set` on the `permissions`
  document, over the Config surface's own draft model: the same `expectedRevision`, and the
  same refusal that never costs a draft — `CONFIG_STALE` shows the conflict, offers
  **Reload**, and what was edited is still there afterwards. Rules nobody touched keep when
  they were added and what for, and a fallthrough is never written into the sidecar.
- ORCA's own default rules are drawn as their own read-only group, **ORCA's
  defaults**, on the policy panel and on the Config surface's read-only view: no file holds
  them and `config.set` cannot address them, so there is no link out of the group and nothing
  to edit — writing a fallthrough in the config is what opts out of them (#140).
- the sidecar's round trip is lossless or it is refused. A key this app does not
  recognise rides through a save untouched, so editing one grant cannot delete a field on
  another; and a document with an unknown `version`, or a rule with no `match` or an unknown
  decision, shows the "cannot be edited here" state and points at the raw view rather than
  being rewritten into a shape it guessed at. A sidecar somebody hand-wrote with its keys in
  another order now counts one edit as one change rather than counting every row.
- a read-only daemon's policy panel shows its grants as text throughout. The enum
  menus already degraded; the path and pattern fields were boxes that quietly refused typing.
- a run answering "allow always" reaches the open policy panel through
  `config.changed`, so the rows are the file's rather than the ones that were read.
- a claim whose owning run cannot resume gets **Release**, with a confirmation
  naming the work item, the run it is taken from and what happens next; a claim the daemon
  would refuse says why on the control instead. What releasing did *not* fix comes back from
  the daemon in words and is both announced and shown on the row — a dead run's log never
  moves on, so the item can still read in-progress. Forcing a release out of a run that could
  still resume stays `orca claims release --force`.
- both are in the command palette as keyless actions on the object — *Edit
  permissions for `<agent>`* and *Release claim on `<work item>`*.
- neither control is drawn at all against a daemon with no `config.set` or
  `claims.release`; the policy is still readable there, because reading it is a read.
- ORCA still does not count auto-approvals. The policy panel says so where a count
  would have gone rather than tallying one in the client.
- the workflow viewer. `orca://workflow/<name>` draws a workflow as a graph —
  derived layout, never dragged — and `orca://workflow/<name>?run=<id>` draws the same graph
  with that run's path over it: the status glyph and word on each node it visited, the
  attempt count where it went round more than once, the node it is at now marked, and the
  nodes and edges it never reached faded. Pan by dragging the canvas or with a shifted arrow,
  zoom with `+` / `-` / `0`, move the selection with the arrows; the selected node's
  configuration is in the inspector beside it. The run header's "the workflow it executes"
  now opens the viewer with that run overlaid, instead of saying it cannot.
- the graph's layout is ORCA's own — `renderer/src/workflow/layout.ts`, no new
  dependency. Layers are longest-path dependency depth, order within a layer is the
  barycentre of a node's predecessors, and an edge that returns to a layer it has passed —
  `ai-sdlc`'s review verdict going back to the build — is drawn as a back edge routed above
  the graph rather than through it.
- a `subworkflow` or a `parallel` is collapsed by default and says how many graphs
  it is hiding; expanding one draws each nested graph in a group box of its own, named by the
  `parent::node::branch` id the daemon addresses it by.
- a run pinned to a version that is no longer the newest carries the `◷ pinned`
  chip, and the viewer says in words which definition is on screen instead — ORCA records the
  version a run started with but keeps no copy of it, so the graph drawn is always the one on
  disk and the viewer never implies otherwise.
- a `workflow` scope in the keyboard map, for a canvas whose arrows move between
  nodes rather than between rows. `docs/design/50-accessibility-and-keyboard.md` has the
  table; every one of its keys is in the command palette. A shortcut on a punctuation key now
  matches the press a keyboard actually makes: `+` is Shift and Equal, so the shift is
  spelling the character rather than modifying it and is dropped — `Shift+ArrowUp` and
  `Shift+Enter` are unchanged.
- the run header names the workflow a run executes *with the version it is pinned
  to* — `sdlc v2` on the run crumb, from the version the run recorded. Whether that version
  is still the newest is the viewer's `◷ pinned` chip, which needs the definition on disk and
  so stays where it is read.
- every write the daemon serves is in the command palette, as a keyless action on
  the object in focus: **Answer `<gate>`: `<option>`** for each option a selected card
  offers, **Cancel** and **Resume** on the run a card is waiting on or the run selected on
  Runs, **Start a run**, and on the Plan surface **Waive dependency on `<target>`**,
  **Decide `<key>`**, **Reopen decision `<key>`**, **Update risk `<key>`** and **Release
  claim on `<item>`**. Nothing was added to the chrome of any screen: the palette is the
  only place a phase-2 write has to be discoverable.
- the answer rows are the card's own options in the card's own order — the
  destructive one last, as `bindOptions` puts it — and they call the same `inputs.answer`
  path the card does. A free-text ask gets no rows: there is nothing to type into in a list
  of commands. "Always" stays on the card, where the button can say what it will actually
  promise.
- a destructive row confirms inside the palette rather than in a dialog. Choosing
  it swaps its label for the confirmation — *Cancel run-42 — confirm* — in the danger tone,
  and a second **Enter** commits; typing, moving the selection or **Esc** disarms it and
  nothing has been sent. A destructive row also never sorts first, for the same reason a
  gate's destructive option is never bound to `1`.
- **Start a run** replaces the palette's list with a picker of the daemon's
  workflows — name, id, version and node count — and starts the chosen one with the
  workflow's own vars, then opens the new run through the route table. **There is no vars
  form**: nothing in the protocol says what a workflow's inputs are called, so the row says
  what it starts with rather than offering fields it would have had to invent.
- a write the daemon does not serve has no row at all, and a daemon that is not
  answering keeps the rows with `useWritability()`'s own sentence beside them — absent where
  ORCA is a viewer, disabled with a reason where it is waiting.
- `runs.start` reaches the app for the first time: the daemon has served it since
  protocol 1.4 and nothing could call it until there was a workflow picker.

#### daemon

- `orca serve` answers all fourteen over `PlanService`. A plan read is one
  snapshot and one schedule per call, so an item arrives with the scheduler's classification,
  its priority score and reasons, its risk exposure and the run holding its claim at once; a
  `schedule.explain` returns `orca plan explain`'s lines word for word rather than a
  paraphrase. The writes journal with `origin: { kind: "human", actor: "daemon" }`.
  `orca serve --read-only` omits all five, from the dispatch table and from `hello.methods`.
- `orca serve` serves the workspace's configuration. `config.get` returns the
  raw text, the parsed document and a description of the config schema — field paths, types,
  enums, defaults — walked off `OrcaConfigSchema` rather than written out by hand.
  `config.set` takes a whole document or a list of field patches; a patch edits the YAML in
  place, so comments and formatting survive and no schema default is materialised into the
  file. A schema failure comes back as `CONFIG_INVALID` with the errors keyed by dotted path
  (`hosts[1].type`), and `validateOnly` reports them without writing. A write against a
  revision the file no longer has is refused with `CONFIG_STALE` rather than overwriting
  what landed in between.
- `config.set` reloads nothing — the daemon goes on serving the configuration it
  booted with until the next `orca serve`. It takes no run lease and appends no event, so
  editing the config while a run is in flight disturbs neither.
- `config.get` returns the ADR 0009 permission sidecar
  (`orca.permissions.json`) as a second document beside `orca.config.yaml`, each with its own
  path and its own revision, and reports the effective permission policy per agent — the
  configured rules first, then the sidecar's, then the built-in defaults, in the order
  `decidePermission` matches them, each labelled with where it came from (`config`,
  `permissions`, `default`) and carrying its `addedAt` / `grantedFor`. A client can now show
  why an agent was allowed something without re-implementing the layering.
- `config.set` on the `permissions` document writes it through the existing
  writer in `@orca/agents`, under the same `link()` lock and in the same fixed key order, so
  an operator editing a grant and a run answering "allow always" both land instead of one
  silently overwriting the other. A document carrying a `default` is refused: answering one
  prompt must not change the answer to every other one.
- `config.changed` is pushed when ORCA writes the sidecar itself, not only when
  a client does, so a screen watching the policy sees a grant a run just recorded.

#### daemon/cli

- `claims.release` over the wire — the daemon half of `orca claims release`
  (#88). Refused while the owning run could still resume unless `force`, and it answers with
  the same "still in-progress" note the CLI prints.

#### design

- `SCHEDULE_PRESENTATION` carries a glyph as well as a word for each of the five
  classifications, so a schedule badge is never its tint alone (rule 4). The wire's two
  settled classifications, `done` and `failed`, have no badge and are drawn with
  `StatusChip`'s succeeded and failed; `component-api.d.ts` says so. Five `col-*` tokens for
  the schedule table's fixed columns, and a `plan` crumb type.
- a `workItemStatus` vocabulary in `semantics.json` — the word and glyph for
  each of the seven work-item statuses, reusing the glyphs of the run statuses and schedule
  classes that mean the same thing. No `fg` or `bg`: it is drawn as a plain chip, so colour
  is not one of its channels. `col-request` and `col-status` size the two new columns.
- `Menu` takes an optional `note` — something a popover has to *say* rather than
  offer, for an error where a list of choices was expected. It is not a `menuitem`, is never
  focused, typed to or chosen, and a menu with a note and no items still opens; focus lands
  on the list itself so `Esc` still returns to the trigger.
- `Menu` takes an optional controlled `open` / `onOpenChange`, for the one case
  a surface cannot press a trigger itself: a deep link that has to arrive with the
  explanation already open. Everything else — focus in and back, `Esc` through the layer
  stack, the roving keys, the placement — stays the primitive's.
- `node-w`, `node-h`, `layer-gap` and `rank-gap` tokens, and `GRAPH_GEOMETRY` in
  `@orca/design` — the four of them as numbers, because an SVG path's `d` cannot reference a
  custom property. `WorkflowNode` is built and `component-api.d.ts` says so.
- a back edge is dotted, not dashed — `--stroke-dash-back` beside
  `--stroke-dash-untaken`, and a legend row for it. "Runs backwards" and "was not taken" are
  different facts about an edge and an edge can be either, so they are no longer one stroke.
  A pinned run's chip is a chip tone rather than `--status-running`, and a selected node is
  `--surface-selected` plus an accent rail rather than an accent outline that read as the
  focus ring.

#### protocol

- the plan surface, at protocol 1.7. Nine reads under the `plan.read`
  capability — `plans.list`, `plan.get`, `items.list`, `schedule.get`, `schedule.explain`,
  `dependencies.list`, `risks.list`, `decisions.list`, `journal.list` — five writes under
  `plan.write` — `dependencies.waive`, `decisions.decide`, `decisions.reopen`,
  `risks.update`, `claims.release` — and a `plan.changed` notification carrying which kinds
  of thing moved. Nothing in the new views carries a date estimate.
- `config.get` and `config.set`, the `config.changed` notification and the
  `CONFIG_STALE` error code; protocol 1.7. `config.get` is a read under `runs.read` and
  `config.set` a write under `runs.control`, so a `--read-only` daemon answers the first and
  does not have the second.
- `workflows.list` and `workflows.get` (protocol 1.7), the workflow files as a
  display graph: nodes with the per‑type fields a viewer shows, edges with their conditions
  and labels, and the graphs written inline inside a `loop` or a `parallel` carried under the
  `parent::node` ids the engine addresses them by — so a nested graph can be drawn where it
  is or fetched again by id. Both are `READ_METHODS`, so `orca serve --read-only` answers
  them. `WorkflowView.versions` is which versions of a workflow the daemon can *see* — the
  one on disk plus the ones the store's runs recorded — and `workflows.get` still serves only
  the one on disk, because ORCA keeps no copy of the definition a finished run used.
- `runs.get` gains an optional `traversal`: the nodes a run took, in order, one
  entry per attempt, with the status, the timestamps, the child runs a container spawned and
  `viaEdge` — which edge of the definition the run arrived on. An edge nobody authored is
  never invented: a retry, a run resumed mid‑graph and a workflow the daemon no longer has
  all leave it absent.
- the `workflows.changed` notification. Nothing emits it yet and that is
  deliberate — there is no workflow reload path in the runtime — so a client may subscribe
  now and will hear one when workflow editing can honestly send it.

### Changed

#### agents

- an `ask` that has no human-input channel at all is now recorded as
  `ask:no-answerer` rather than a bare `ask:cancelled`, because "the policy wanted a person
  and there was none" is the one a reader of the log has to act on. It was already refused
  rather than parked — a permission cannot outlive the session that raised it — so it fails
  the tool call and not the run.
- the ACP session evaluates the *effective* policy rather than the configured one.
  It read `agents[].permissions` straight from the parsed config, which was right only for as
  long as parsing injected the default rules into it; now that they are an explicit layer,
  `openAcpSession` applies it. Without this an agent with no `permissions:` block would have
  been asked about reading files in its own workspace.

#### app

- Attention lists the runs that are in flight when nothing is waiting and nothing
  has failed, instead of saying "nothing needs you" over a blank page. It is the app's
  landing screen, and a person whose runs are all moving was being told the one thing they
  did not need to know while the one thing they did — what is actually running — was
  withheld. The rows are the failures' rows, `Enter` opens the selected run, and a running
  run is still not a tier and is still not in the waiting count: it appears here and only
  here, and the moment anything waits or fails the tiers above take the screen back. No
  second subscription — one more read on the page, folded into the feed the surface and the
  title bar already share. With nothing waiting, nothing failed and nothing running, the
  empty state stands, because then it is true.
- the sidebar reads its order, words and glyphs from `@orca/design` instead of
  declaring them. Every item keeps its label as its accessible name and its `⌘1`–`⌘5`
  address at every width; the expanded sidebar is unchanged.

#### build

- a rendered release section is grouped twice — by change type, which is the
  fragment's `<section>` and has always been `### Added`, and inside that by change target,
  which is the bullet's own area prefix and is now `#### app`. The prefix is lifted out of
  the bullet into the heading, so nothing is said twice, and a fragment whose bullets name
  different targets is split between them rather than filed under the first. Targets render
  alphabetically; entries inside one keep their issue order. This is the body of the
  `release: vX.Y.Z` pull request as much as it is `CHANGELOG.md` — v0.4.0 was fifty bullets
  under four headings, and "what moved in the part I use?" had no heading to answer it.
  Bullets with no prefix, which is what `store` prose is, render ungrouped above the
  headings exactly as before.

#### core

- an agent that declares no `permissions:`, or declares one and leaves `default:`
  unset, no longer gets `default: allow`. The policy it gets instead allows reads, searches, edits, deletes
  and moves **inside the run's workspace** and asks about everything else — `execute`
  wherever it runs, the network, any path outside the workspace. `execute` is asked about
  because ORCA sees a shell command only as the permission title: the agents that matter run
  commands in their own process rather than through ACP's `terminal`, so there is nothing to
  scope the grant by. This is a property of the agent and not of how the run was launched, so
  one config behaves one way. The defaults are ordinary rules and they are the **last** layer:
  configured rules are matched first, then `orca.permissions.json`, then these, and then
  `default:` decides whatever none of them matched. So a hand‑written `deny` still wins, and a
  `reject_always` recorded in the sidecar beats the default allow that made the prompt appear
  (ADR 0009). Spelling the default rules out in your own `rules:` is not a no‑op: it moves them
  ahead of the sidecar, where a recorded `reject_always` can no longer reach them.
- **writing `default:` at all opts an agent out of those default rules** — `ask`
  exactly as much as `allow`. `permissions: { default: ask }` with no rules now means what it
  says: ask about everything, in‑workspace reads included; it is no longer the same policy as
  leaving `permissions:` off. `permissions: { default: allow }` is the other end and is the
  right thing for a sandbox. If you had `default: ask` written down and want the workspace
  allows back, delete the line.
- `orca.config.yaml` parses to exactly what it says. The default rules used to be
  injected into the parsed config, so anything that read it back — `orca demo`'s generated
  config, `config.get`'s per‑rule provenance — reported rules nobody had written as if an
  operator had written them.
- a permission rule can match on `scope: workspace | outside-workspace` — whether
  every location of the tool call is inside the run's workspace or any of them is not. It is
  the one match that needs no path written down, because the path it is about is the run's
  own. A call with no locations at all matches neither and falls through to `default`.

#### daemon

- `runs.events` and a subscription resuming from a cursor take that page rather
  than reading the whole log and cutting it in memory. Scrolling a run whose log is tens of
  thousands of `agent.update` lines now costs a page; the answers are unchanged.
- `artifacts.get` still declines a binary body — it is the JSON-RPC wire that
  will not carry 200 MB, not the store any more — and the size and media type it names in
  `omitted.detail` are now the real ones.

#### design

- the five surfaces have designed glyphs — ◆ Attention, ☰ Runs, ⬡ Plan,
  ◉ Agents, ❋ Config — declared in `semantics.json` and bundled in the symbol face, so the
  rail the sidebar collapses to below 960px draws the same five shapes on every platform.
  They replace the placeholders the app had picked for itself, among them a ⚙ that no
  bundled face carried and so came from whatever the operating system had, and a filled and
  an outlined diamond that differed by a hairline on the two surfaces a person moves between
  most. The five are now told apart in greyscale at icon size: a solid diamond, three bars,
  a hollow hexagon, a ring round a dot, a radial burst. Attention keeps the waiting status's
  ◆ on purpose.

#### engine

- `humanInput: { mode: auto }` refuses an agent `ask` permission rather than
  answering it with the agent's first option. A permission request's options are the agent's,
  in the agent's order, and the first of them is conventionally "allow once" — so taking it
  turned every `ask` in an unattended run back into an `allow`. Gates and questions are
  unchanged, and `option:` still answers a permission when it names an id the agent offered.
- an artifact's `size` is its length in bytes, not in characters.

#### store

- `EventStore.readRange(runId, { after, before, limit, types, match })` reads one
  page of a run's log, and `lastSeq(runId)` reads the end of it. The JSONL store scans to the
  page a chunk at a time and stops there — forward from the start for `after`, backward from
  the end for `before` — so neither the file nor its parsed events are ever held whole.
- `ArtifactStore.put` takes a `string` or a `Uint8Array`, and `bytes(id)` reads a
  body back byte for byte. `content(id)` still returns UTF-8 text and is unchanged for every
  caller ORCA has today.

### Fixed

#### agents

- "Allow always" now takes effect. The `orca.permissions.json` sidecar (ADR
  0009) was written but never read at session time, so a standing grant a person recorded
  was asked about again on the very next tool call. `session/request_permission` now
  evaluates the agent's configured rules, the sidecar and the defaults together, re-reading
  the file per ask, so a grant recorded mid-run applies to that run's next tool call.

#### app

- an artifact diff against an empty version no longer counts a removed line that
  does not exist. `"".split("\n")` is one empty string, so v1 of an artifact — or a body a
  tool recorded as the empty string — diffed as a file of one blank line and the panel said
  "1 added, 1 removed" for what is a pure creation. An empty *body* now contributes no
  lines, in either direction: a creation reads "1 added", an emptied artifact reads "1
  removed", and two empty versions are no change at all. The gutters and the line bodies
  were always right; only the sentence above them lied. Splitting is unchanged, so a file
  whose one line is blank is still a file with a line in it.
- a chosen store whose daemon will not start is a failed open rather than a silent
  attachment to whatever else is listening. **File ▸ Open a store…** used to report the
  failure and then carry on to `ORCA_DAEMON_URL` or `127.0.0.1:6722`, so a store on a USB
  drive that could not be served showed some other store's runs under a banner naming the USB
  path as read-only. It now builds no client and opens no stream: the daemon it stopped on the
  way in stays stopped, the status bar reads `disconnected`, and the reason names the path on
  the console. The fallback is unchanged for the launch case, where the daemon that would not
  start was the placeholder over the home directory and the one on the default port is the
  daemon the app expected anyway.

#### cli

- `orca serve` advertises `plan.read` / `plan.write` only when it actually serves
  the plan methods, instead of always. A client hiding a plan surface on the capability now
  hides it at the right times.
- `orca` installs `unhandledRejection` and `uncaughtException` handlers at its
  entry point. Anything that escapes a command is logged with its ORCA code instead of
  arriving as Node's default crash, and `orca serve` keeps serving through it — one run's
  failed append used to lapse the lease of every other run the daemon was driving.

#### daemon

- `config.set` no longer drops a permission grant recorded while the operator's
  form was open. The `CONFIG_STALE` revision check and the write were two unsynchronised
  steps, so a run answering "allow always" between a client's `config.get` and its
  `config.set` landed in the window between them — and since `config.set` is a replace and
  not a merge, the save then wrote the grant away with nobody told. The revision is now
  re-hashed inside the lock the write takes: the sidecar's own `link()` lock, via a new
  `expectedRevision` on `replacePermissionPolicyFile`, and `<configFile>.lock` for
  `orca.config.yaml`. Two saves made against one revision can no longer both land; the second
  is refused with `CONFIG_STALE` and both revisions, which is what it was always supposed to
  be.
- `runs.start` and `runs.resume` report a lease taken by (or taken away for)
  another process as `RUN_LEASED_ELSEWHERE`, the way `runs.cancel` already did, instead of an
  unclassified internal fault with no run id on it.
- `claims.release` is served by any daemon that drives runs, not only one that
  also has a plan. It has always been in the `runs.control` capability's method list on the
  wire, and it needs no plan at all — but it was behind the plan's writing half, so a daemon
  over a store with no plan in it advertised the method and then answered "unknown method".

#### design

- the command palette's field draws a focus ring again. It carried the system's
  one `outline: none`, deferring to a ring on the palette that was never written — so ⌘K put
  focus into the only focusable thing on screen and nothing indicated it. The suppression is
  gone rather than the compensating ring being invented: the field takes the same
  `:focus-visible` ring as everything else, from `--border-focus`, because one ring keyed the
  way the spec keys it is better than a second one on the overlay that would also draw itself
  after a mouse click. Its offset is inset by the ring's own width, since the overlay clips
  its content and a full-width field would otherwise lose three sides of an outward ring.
  Nothing in the component layer or the app's stylesheets suppresses focus now (RULES.md
  rule 10), and the test that allowlists suppressions is down to an empty list.
- the component layer has a `.orca-visually-hidden` utility — in the
  accessibility tree, nowhere on screen — so nothing app-side has to rewrite the clip. The
  polite announcer wears it and `app.css` is back to the window filling the window, which
  takes the app's `orca-allow-literal` count to zero. One note moved with the class and is
  now the only one in the tree: a single exemption covering the `1px` box that keeps the
  element rendered, arguing the permanent case rather than naming an issue to wait on —
  `display: none`, a zero box and `visibility: hidden` each drop the element out of the
  accessibility tree in some screen reader, which for a live region is not "hidden" but
  "off". It is a class and deliberately not a component: its callers are a `div`, an `h2`
  and a `label`, and a wrapper would have to pick one.

#### engine

- an interpreter whose run lease is taken away stops without writing to the log
  it no longer owns. It used to abort the run and then append `step.cancelled` and
  `run.cancelled` through the same context — into the log the operator had just handed to
  another interpreter, which cancelled the run the takeover was meant to continue. A lost
  lease is now told apart from a cancel we own: the interpreter logs why, closes its agent
  sessions, writes nothing, and raises `RUN_LEASED` to whoever called `run()`. The run is
  left exactly as its last write found it, for the new holder to re-attempt.
- attaching to a run takes the lease *before* it reduces the run's log, so an
  attach refused with `RUN_LEASED` leaves no half-read state behind for the next one to
  reuse. A finished run is still read without a lease and still never leaves one on file.
- a lease lost in the moment between being taken and the run's log being loaded
  refuses the run rather than driving it. That window was the one the heartbeat could not act
  on — it fired, found no interpreter to stop, and returned — and the attach then went on to
  execute, and write, holding no lease. It now raises `RUN_LEASED` as soon as there is a
  context to stop, having written nothing.
- a failed `agent.update` append no longer ends the process. The streamed
  output of a turn goes onto one serialised chain rather than a fire-and-forget promise per
  update, so a store that refuses a write — a torn lock file, a full disk, a store directory
  that went away — is caught, logged once against the step, and surfaced when the turn ends
  as a `STORE_WRITE` failure of that step, which the node's retry budget then applies to.
  Coalescing is unchanged: the buffer still flushes at 4000 characters and when the kind of
  update changes.
- an artifact that is in the index but whose body cannot be read no longer renders as
  an empty string. The read raises `ARTIFACT_MISSING` naming the artifact, its version and its
  content hash, so the step fails and the retry policy or a person decides, and the failed read is
  not cached — the next render tries again once the store is whole.

#### store

- two processes over one store no longer lose each other's documents. A
  `JsonFileDocumentStore` collection used to be read once and rewritten whole from that
  first view, so a long-lived `orca serve` beside a one-shot `orca plan decide` wrote back a
  stale map and dropped whatever the other had written in between — and never saw it on a
  read either. The cache is now trusted only while the file's `{ino, size, mtimeMs}` is
  unchanged, so every `get`/`list` picks up another writer's work, and every
  `put`/`putMany`/`delete` runs inside the `<file>.lock` lock, re-reading under it before it
  renames the new collection into place. Requests, work items, plans, dependencies, risks
  and decisions are all covered; writes are still coalesced, still atomic (tmp + rename) and
  the on-disk format is unchanged.

## 0.4.0 - 2026-09-21

### Store format

Two event payloads grew, and both old shapes still read, so **an existing `.orca` store needs
no migration** — point this release at one and it replays as it did, including runs parked at a
gate.

`agent.update` now carries the tool call's arguments and its result alongside the title and
status it already had. Each is capped at 2,000 characters when the event is written, and stored
with the length it had before the cap, so a reader can say "this was 48,000 characters, you are
seeing 2,000" rather than guess: a tool call that reads a large file does not put the file in the
log. Both fields are optional, and every `agent.update` written before this release simply has
neither — a tool call row from an older run shows its title and offers nothing to expand.

`human.requested.options` was a list of strings and is now a list of records —
`{ id, label, consequence?, destructive? }`. `id` is what an answer carries, so a label can be
reworded without invalidating a `human.answered` already in a log. A bare string in an older log
reads as `{ id: s, label: s }`, which is exactly what it meant: the words were both the identity
and the label, and the answer recorded against them still matches. Gates written from here on
store records, so the two shapes coexist in one log without either being rewritten. Nothing in
this release produces a `consequence` or a `destructive` option yet; the fields exist so the
attention surface can carry them without a second store change.

Both changes are in the same discriminated union and landed together, deliberately: this is the
only store-format change in v0.4.0, and the cost of one grows with every real event log.

No change to an existing `.orca` store: the event log, plan journal and artifact index are
untouched, and so is `orca.config.yaml`.

There is one new file, and it is not in the store. `orca.permissions.json` appears beside
`orca.config.yaml` the first time someone answers an agent's permission prompt with
"always"; until then it does not exist, and a workspace without one evaluates permissions
exactly as before. It is a project file rather than store state on purpose — the grants in
it are meant to be reviewed — so decide whether to commit it or ignore it the way you would
any other file in the repository. Committing it is the intended default.

The `permissions:` rules in `orca.config.yaml` keep their meaning and keep their precedence:
they are evaluated before anything in the sidecar. A rule may now match on `path:` (one
exact location, resolved against the run's workspace when relative) as well as the existing
`pathPrefix:`; configs written before this release parse and behave unchanged.

Two event payloads grew, both additively, and neither old shape stops reading, so **an
existing `.orca` store needs no migration** — point this release at one and it replays as it
did, including runs parked at a gate.

`human.answered` gains `note`: the free text a person writes beside their answer. It was
accepted by `inputs.answer` and by `orca answer` before, and it went to the *operator's* log,
because the event had nowhere to put it — reasoning that a person believed they had attached
to a decision, living instead in whichever terminal the daemon was logging to. It is now
recorded with the answer. The run still branches on the answer alone. The field is absent on
every answer written before this release and on every answer given without a note, and it
must stay absent rather than render as empty.

`human.requested` gains `agent`: `{ id, hostId }`, the agent whose turn a permission ask is
holding open (#248). It is recorded rather than looked up because the `input.opened`
notification is a pure function of this one event, and a push that had to scan a log to say
who is waiting would turn every append into a projection. Only what the moment of asking
knows is stored; a host's *transport* is configuration, so it is resolved from the registry on
a read and never frozen here. A workflow gate has no agent and writes no field, and a
permission ask recorded before this release has none either — `inputs.list` answers for those
logs from the `agent.session.opened` scan it already did.

Not a store change, but in the same area and worth reading together: a workflow's gate and
decision options may now be records rather than words (#247). That is the *authoring* shape
in `orca.config.yaml`'s workflows; what the log holds has been
`{ id, label, consequence?, destructive? }` since v0.4.0's wave zero, and a bare word still
reads as an option that is its own id and label.

### Added

- **app:** `VirtualList`, the list substrate every list surface is built on: a window over
  fixed-height rows read from `--row-h`, a clickable status minimap over the whole list, a
  sticky context header that lifts only once content is beneath it, and `J`/`K`, the arrows,
  `Home`/`End` and the page keys registered in the keyboard map's `list` scope. The Runs
  surface is the first to adopt it, so a store of fifty thousand runs is a few dozen rows in
  the document.
- **app:** the Runs surface is a run tree. A run opens into its step groups, its earlier
  attempts, its child runs and the fan-out branches that never ran, from one `runs.get` per
  run and then `run.changed` and `step.changed` — never `agent.update`. `→`, `←`, `⇧→`,
  `Enter` and `F` are registered in the `run-tree` scope beside the substrate's movement
  keys, indentation stops at six levels with the ancestor chain in the sticky header, and a
  running run draws an indeterminate meter: ORCA has no completion percentage and none is
  invented.
- **app:** the event timeline, under the run tree: the selected run's log, paged backwards
  from `runs.events` and tailed forwards from `event.appended` and `agent.update`. A
  coalesced batch of agent updates is one row and says how many; a gate a policy settled
  renders quietly and names `gate:auto` rather than a condition the event does not carry.
  The sticky header shows the current step and the run's own cursor — "as of event *n*" —
  because sequence numbers are per run and the status bar's store-wide cell has no single
  number to show.
- **protocol/daemon:** `runs.events` takes a `stepRunId` filter beside `types`, which is how a
  step's output is read (#158). A step's output *is* the `agent.update` events it appended, so
  it is one filter on one method rather than the `steps.output` method the issue sketched — a
  second method would have meant a second cursor semantics for file mode and the read-only
  daemon to support. The filters are an AND, run-level events match no step, and the cursors
  stay the run's own sequence numbers, so paging back from a page's `prevCursor` crosses a trim
  boundary with no gap and no duplicate. One consequence worth knowing: a client buffers
  **events, not lines** — one `agent.update` renders many lines, so the design's "last 50,000
  lines" is a count of events on this wire.
- **app:** step detail and the agent output pane. A step says its node, attempt, agent, host
  and duration, lists the artifacts it produced as chips, folds its `agent.update` events into
  tool-call rows — arguments, result, and the permission ask that settled it — and streams its
  output as fixed-height lines at `row-log` over the list substrate. The stream follows or is
  held, offers **Jump to latest** with the count of new lines, buffers the last 50,000 events
  and pages backwards across the trim boundary with **Load earlier output**; `G`, `⇧G`, `/`
  and `N` / `⇧N` are on the keyboard map in the `stream` scope. A reconnection leaves
  `◷ paused — reconnecting` and `── reconnected hh:mm:ss ──` inline, where the gap fell. With
  a run selected and no step, the same pane is a minimal run summary. No cost and no token
  count: ORCA cannot supply either, so the header's sixth metric slot stays empty.
- **app:** the docked artifact panel. An artifact chip, a version strip and the panel's open
  state are one seam: the artifact is an address — `{ runId, name, version, compareWith? }` —
  held above every surface, so a step's chip opens it today and a deep link can open it later.
  `[` and `]` step versions in the `panel` scope, a body the daemon declines shows its reason
  in words where the body would have been, consumed-by links come from the run's steps, and a
  comparison renders as a line diff with `+` / `−` gutters, never colour alone. Markdown is
  raw: the rendered toggle is absent rather than disabled, because a renderer is a dependency
  decision (#245).
- **protocol/daemon:** `artifacts.list` and `artifacts.get` — the artifact index filtered by
  run, name, kind or producing step, and one artifact with its body (#159). `version` is
  monotonic per (run, name), so asking `artifacts.list` for one name in one run is the version
  list the docked panel steps through, and `artifacts.get` takes either an `artifactId` or the
  `runId`/`name`/`version?` triple a deep link carries. A body that is not text, or is past the
  call's `maxBytes`, is declined with the reason rather than served or refused: the panel still
  shows what the artifact is. Both are in `READ_METHODS`, so `hello` advertises them and a
  read-only daemon answers them; protocol version is now 1.3.
- **app:** `inputs.answer`, `runs.cancel` and `runs.resume` on the preload bridge, and an
  `alerts` channel beside it for the OS-notification half. `runs.start` is deliberately not
  there: starting a run needs a workflow picker the app does not have yet (#178).
- **protocol/daemon:** the control methods (protocol 1.4) — `inputs.answer`, `runs.resume`,
  `runs.cancel` and `runs.start`. The daemon takes each run's single-writer lease before it
  appends and refuses a run another live process holds, with that holder's pid and host,
  rather than waiting on it. Four new error codes say which refusal it was:
  `INPUT_ANSWERED`, `INPUT_OPTION_UNKNOWN`, `RUN_NOT_WAITING`, `RUN_LEASED_ELSEWHERE`.
- **cli:** `orca serve` drives runs by default and `--read-only` opts out, leaving the
  control methods out of the dispatch table *and* out of `hello.methods` and dropping
  `runs.control` from `hello.capabilities`. The port carries no authentication: any local
  process can call them, and the lease guards against a second writer rather than against a
  caller — said plainly in `orca serve --help` and in ADR 0008.
- **cli/daemon:** `orca answer` and `inputs.answer` are one shared function, so the CLI and
  the wire cannot drift on what answering a gate does.
- **app:** the Attention surface, and the first writes the desktop app makes. Permission
  asks and gates are cards — the question, the run and work item it belongs to, how long it
  has waited, the artifacts the decision is about as chips that open the docked panel, and
  the options with their consequence clauses — answered in place with `1`–`9`, `Enter`,
  `⇧Enter` for a note and `J`/`K` between cards, so five gates clear in five keystrokes and
  the count goes five to zero without navigating. The destructive option is never bound to
  `1` and is never the selection a card opens with — a person may still choose it, and then
  `Enter` sends it, because the rule is that it is never hit by accident, not that it is
  unreachable. A gate whose artifacts did not load has its
  options disabled with that reason on the control, and so does every answer when the
  connection cannot write — `useWritability()`'s sentence, verbatim, on a read-only daemon
  as much as on a dead socket. Answering "always" writes a standing rule into the workspace
  sidecar and the card reports what was actually written: it says "ORCA will not ask again"
  only when a rule was added, and says ORCA *will* ask again when the daemon could derive
  none. Failed runs are listed below the waits, out of the count. The same two cards are
  exported for step detail to render inline in a run.
- **app:** a step parked on a gate or an agent's permission ask renders that ask **inline in
  the run**, as the same card the Attention list draws and with the same controls — the
  design's requirement that a card be answerable where a person finds it, rather than only
  on the surface that collects them. It reads the one waiting feed the title bar's count
  comes from, so answering in either place moves the other and neither holds a second
  opinion about the number.
- **app:** one waiting count, in three places. `inputs.list` sends the number so that no
  client recounts it, and the title bar's `◆ n waiting`, the sidebar's Attention row and the
  dock badge are all that number — permission asks and gates summed, hidden at zero. It is
  read once, in the chrome, so it is live on whichever surface is showing.
- **app:** OS notifications, per the tier table and opt-in per tier. A permission ask
  notifies immediately, a gate sixty seconds after it was asked, a failed run when it fails;
  the default is permission asks only, with an unfocused-escalation interval that lets gates
  through when the window has been ignored. They coalesce — a second ask updates the count on
  the notification already showing rather than stacking a second behind it — and clicking one
  goes through the same route table a pasted link does: a waiting ask lands on its card, a
  failed run on that run, and an alert whose ask has since been answered on the surface,
  which is all there is left to say about it. A permission ask may take the person's attention
  only inside a window that already has focus, and nothing in the app raises a window at
  anybody. The preference lives beside the theme and the densities in `preferences.json`.
- **app:** the five connection states, decided once. A state machine in the main process
  (`src/main/connection-state.ts`) folds the WebSocket's own state, the bundled daemon's
  exit and the `hello` handshake into `live`, `reconnecting`, `disconnected` or `mismatch`,
  and pushes it to every window over a new `connection` bridge namespace. Leaving `live` is
  silent for five seconds, so a blip that resolves in 400ms changes nothing on screen; after
  that the status bar changes and a 2px stale rule appears under the chrome. The connection
  indicator has moved from the title bar to the status bar and carries the event cursor. A
  daemon that comes back speaking a protocol the app cannot type-check blocks once, with
  both versions, and leaves a persistent bar behind. The app also derives "can write, or why
  not" from the state plus the daemon's `runs.control` capability — absent means writes are
  unavailable and says so calmly, which is every daemon today.
- **app:** file mode. **File ▸ Open a store…** points the running app at any workspace,
  read-only: the daemon this process started is stopped, one is started with `--read-only` on
  the chosen directory, the client and the push stream are rebuilt and the connection machine
  is reset — with every bridge call in flight waiting on the switch rather than reading from a
  daemon that is being killed. There is no second store path in the renderer (ADR 0008): the
  read-only daemon omits `runs.control`, so every write is already absent, and the banner names
  the store and offers **Connect to a daemon**. The app also has an application menu for the
  first time, which is what carries those two commands and the standard clipboard roles.
- **app:** `orca://` deep links. The scheme is registered, the app takes the single-instance
  lock — so a second launch focuses the window that is open rather than opening another onto
  the same store — and a URL arriving on a cold start, through macOS's `open-url` or through a
  second launch's command line is resolved by one route table with the palette's jump row and
  **Copy link**, which every object header now offers. A link that arrives while no daemon is
  answering lands on the object's surface with its id shown rather than being dropped, and a
  URL this version does not understand says so with the URL in it. Two corrections to the
  design's table, made in the same pull request: an artifact link carries `?run=`, because
  versions are monotonic per (run, name) and a bare name addresses nothing; and
  `orca://item/…` and `orca://workflow/…` land on their unbuilt surfaces honestly rather than
  being errors.
- **app:** an `orca://run/<id>/step/<node>[.<attempt>]` link selects the row it names, not
  just the surface it is on: the run in the tree, the step in the pane beside it, and the
  timeline moved to that step's first event. Without an attempt the link means the latest
  one, which is the row the tree shows. A notification click is the same journey — it builds
  the ask's canonical URL and goes through the one route table every other arrival uses.
- **app:** the Agents surface. Every configured agent as a health card, grouped by the host
  it is spawned on, with the handshake state as a glyph and a word, both of its timestamps,
  the round trip of the last successful handshake, and — on a card that is down — the error
  that explains it. An agent nothing has contacted reads `unknown` and says so ("not
  contacted since the daemon started"): health is tracked in the daemon's process and never
  persisted, so that is the honest answer rather than a missing one. The list is read once
  and every later change arrives as an `agent.changed` push; nothing polls and nothing
  re-reads. What is claimed right now travels with the same read and is shown beside the
  agents, as the work item and the run holding it.
- **app:** the app has one polite live region, and the output pane is a `log` region that
  never speaks. The announcer is mounted once by the chrome and fed from the notification
  stream every surface already listens on — step transitions and terminal states only, in the
  design's own words ("build step failed, 3 attempts"), with a step's node name remembered
  from the frame that introduced it and its id said when no frame ever named it. The output
  pane now carries `role="log"` and the name of the step it belongs to, with an explicit
  `aria-live="off"` beside it: the role is what puts a step's output in the region list a
  person navigates by, and the `off` is what keeps forty lines a second out of their ear
  (RULES.md rule 11).
- **app:** an interruption card is named by its tier first — "gate, Ship release 1?" — the
  same status-first ordering the run rows and the agent cards already take, which is what
  makes a greyscale screenshot and a screen reader say the same thing.
- **release:** desktop and daemon artifacts, built from the tagged commit and attached to
  the release. The desktop app is packaged per platform by electron-builder — AppImage and
  archive on Linux, dmg and zip on macOS, NSIS installer and zip on Windows — and the
  daemon is the CLI bundled to one ESM file, shipped both inside the app and beside it.
  **Both are unsigned**: macOS quarantines them and Windows SmartScreen warns about them,
  and `docs/RELEASING.md` names the secrets that fixing it needs.
- **app:** a packaged desktop app starts its own daemon. It picks `ORCA_DAEMON_URL` if set,
  then the bundled daemon on a free loopback port, then the default local `orca serve`, and
  stops what it started when it quits. The workspace it serves is `ORCA_WORKSPACE` or the
  user's home directory until the app can choose one.
- **app:** a shortcut may have no key. `Shortcut.key` is optional, a keyless command takes a
  slot of its own in the registry (so the duplicate-key throw that finds real collisions is
  untouched), `handle()` cannot dispatch to one, and the palette renders its row with no chip
  beside it. **Cancel the run this is waiting on** and **Resume the run this is waiting on**
  are the first two: real write actions, reachable from the palette and nowhere else.
- **app:** the command palette lists objects. Navigation carries the ten most recent runs and
  the configured agents with their handshake health; Search covers step and artifact names.
  Every row is a canonical `orca://` URL opened through the route table, which is what keeps
  one resolver rather than three, and nothing polls: each source reads once and a `run.changed`
  or `agent.changed` drops what it holds. Event text and artifact contents are not searched —
  the protocol has no text-search method, and scanning every log in the store per keystroke is
  not a search.
- **app:** the bundled faces are checked by machine on Linux, macOS and Windows. A second
  job in the app smoke workflow launches the dev-only `#type` surface on all three runners
  and diffs committed per-platform screenshots of its two theme columns, with the bundled
  faces on and off, so a glyph that quietly falls through to the operating system fails a
  pull request instead of going unnoticed on the machine that happens to have the typeface
  installed (#213). It also asserts, without needing a baseline, that no bundled
  `@font-face` ended at `error` and that flipping the fallback toggle actually changes what
  is drawn. `#type` stays out of production builds exactly as before: the spec starts a Vite
  dev server and points the main process at it through `ORCA_RENDERER_URL`, the seam
  `pnpm --filter @orca/app dev` already uses. `docs/DEVELOPMENT.md` ("Screenshot baselines")
  has how the baselines are created and the one honest way to update them.
- **core:** a permission policy can be written, not only read. Answering an agent's
  permission prompt with "always" derives a rule from that one request and appends it to
  `orca.permissions.json`, a sidecar beside `orca.config.yaml`, layered *after* the agent's
  configured `permissions:` rules so configuration always wins. Rules carry the time they
  were added and the tool call they were granted for, because a standing permission grant
  should be readable in a diff. Paths are workspace-relative, so a grant still applies in the
  next run's git worktree; a `path:` match on a rule is new and exact, where `pathPrefix:`
  stays the hand-written broad form. The derivation refuses to widen — never a parent
  directory, never anything outside the workspace, and an `execute` grant is scoped to its
  command rather than to the directory it ran in — and refuses to write a rule around a run
  id or a temp path that could never match again, reporting the refusal so the caller can
  honour the answer just once. See ADR 0009.
- **agents:** handshake health per agent (#222). `AgentRegistry` now carries an
  `AgentHealthTracker`: every agent session the interpreter opens records a successful
  handshake with its round trip, and every spawn or handshake that fails records the
  opposite, so the Agents surface has a state to read instead of inventing one. The states
  are `unknown`, `ok`, `degraded` and `down`. `degraded` means the handshake succeeded only
  after a retry — there is deliberately no latency threshold, because ORCA has no data yet
  for a defensible round-trip bound over ssh; the round trip is recorded either way so one
  can be added later. Nothing polls: health only ever reflects sessions a run asked for.
  Health is held in memory only, so a restarted daemon reports every agent as `unknown`
  until it is next contacted rather than claiming `ok`.
- **protocol/daemon:** `agents.list` and `agents.ping`, and the `agent.changed` push behind
  them. Both are answered by a `--read-only` daemon: neither touches a run, a lease or a log.
  `agents.list` reports every *configured* agent — `unknown` for one nothing has contacted,
  never a fabricated default — alongside the claims that say what is being worked right now.
- **agents:** two timestamps per agent instead of one. `lastHandshakeAt` is when ORCA last
  established a connection; `lastSeenAt` moves with the agent's output, so a pooled per-run
  session that handshook an hour ago and spoke a second ago can say both. `agent.changed`
  fires from a listener on the health tracker — a handshake succeeding or failing, never the
  per-batch `lastSeenAt` refresh.
- **cli:** `orca ping <agentId>` calls the daemon's `agents.ping` when one answers on the
  configured address, so the result lands where the Agents surface can see it. With no
  daemon it handshakes in-process as before and says, in those words, that it recorded
  nothing.
- **app:** `VirtualList` takes a `scope` — `list`, `run-tree` or `stream` — so one screen can
  hold three lists and `J` still means "next" in whichever one the focus is in. One list per
  *scope* rather than one per screen; two in one scope still throws, which remains how a
  collision is found. It also takes `follow` with an `onHold` that fires once when a scroll
  leaves the end, and exposes `reveal(index)` and `shiftBy(rows)` on a ref — `shiftBy` being
  what a list that pages *backwards* needs, since without it "load earlier" throws a person
  back by exactly the page they asked for.
- **protocol/daemon:** `OpenInputView` and the `input.opened` notification carry `agent` —
  `{ id, hostId, hostType? }`, the same three fields and the same names as `AgentView`, so a
  client folds one vocabulary. A permission ask holds an agent's turn open and the card has
  to say whose; until now that was an `agents.list` away, and the attention surface's design
  forbids a card that needs a further call. It is optional because a workflow gate is nobody's
  agent: absence means no agent is blocked, never a field that failed to load. `hostType` is
  absent when the host has left the config, rather than guessing the commoner transport.
  Protocol version 1.6.

### Changed

- **tests:** the suite caps itself at four workers, or the machine's own default where that
  is lower (`VITEST_MAX_WORKERS` overrides). Vitest's default is one worker per core less
  one, so the suite's memory footprint was a property of whichever machine it ran on and
  nothing bounded what two concurrent runs cost. Measured on an 8-core box: 7 workers is 45s
  at 3,249 MB peak, 4 is 50s at 2,217 MB — 11% slower for a third less memory, since the
  suite is startup- and I/O-bound well before it is CPU-bound. The cap can only reduce
  concurrency, never add to it, so a 2- or 4-core CI runner is unaffected.
- **protocol:** `OpenInputView.options` and `input.opened`'s `options` carry the whole
  `GateOption` — `{ id, label, consequence?, destructive? }` — instead of an array of ids.
  A client could answer a gate it had no way to render; it can now show the label, the
  consequence clause and the destructive flag the design requires before offering a choice.
  `id` is still the whole of the answer, and a log written before the model changed still
  reads as options that are their own ids and labels.
- **app:** the Electron smoke test audits every surface that has been built rather than
  whichever one the window opened on. axe runs over Attention, Runs and Agents in both
  themes, with the failing rule ids in the message so a red run says what broke without
  anyone opening the report, and Plan and Config are asserted to be the unbuilt `StateView`s
  they still are — a screen that says "not built yet" would pass an audit and mean nothing
  by it. Alongside it, the greyscale guarantee is now checked rather than eyeballed: every
  status on the attention list, the run tree and the status bar is read out of the DOM and
  compared against the design system's own presentation maps, so a status carried by colour
  alone fails the build, and a `filter: grayscale(1)` screenshot of each is attached beside
  the assertion for the times the guarantee turns out wrong (#167). The audit's fixture adds
  a parked gate, a failed run and a second host on top of the `orca demo` store — the demo
  itself is unchanged, because it runs the workflow to completion on purpose.
- **app:** every element in the renderer that takes a component class now also takes the
  `.orca-text-*` class that class expects (#211). `components.css` stopped setting a type size
  in wave zero, so until now the chrome, the command palette, the Runs surface and the `ui/`
  primitives were all inheriting the shell's 14px instead of the chip's, the crumb's or the
  row's intended size — visible, but not obviously wrong, and nothing failed. 46 elements
  across 16 files change class names only; no markup, behaviour, prop or accessible name
  moved. `#preview` now renders each primitive at the size the design system intends.
- **app:** a test sweeps the `type:` notes out of `components.css` and asserts, over the
  rendered chrome, palette, Runs surface and every `ui/` primitive, that nothing carrying a
  noted class is missing its type class, carrying the wrong one, or carrying two (#211). The
  expected side is read from the stylesheet with `querySelectorAll`, so adding a `type:` note
  to a new component class is enough to put every element that takes it under the test — this
  is the guard the later v0.4.0 surfaces inherit rather than re-deriving.
- **design:** `components.css` no longer sets a type size anywhere (#211). The scale in
  `tokens.json` reaches CSS only as the `.orca-text-*` classes, so a style has one definition
  rather than two: a component class carries the ground, the box, the weight and the track,
  and the element it sits on carries its type class, named by a `type:` note on the rule. The
  two rules that need a size without the rest of a style — the shell root and the empty-state
  glyph — reference the new `--text-<style>-size` and `--text-<style>-line-height` custom
  properties, which the token build now emits beside the classes. 117 literal `font-size` and
  `line-height` declarations and 23 literal box dimensions went; `pnpm run lint:css` checks
  `components.css` in full, colours and lengths both, rather than for colours only.
- **build:** release notes are written as fragments in `changelog.d/`, one file per entry
  named `<issue>-<slug>.<section>.md`, and `node tools/release.js prepare` renders them into
  the dated `CHANGELOG.md` section and deletes them (#216). Two pull requests in flight no
  longer edit the same region of the same file; `## Unreleased` holds a pointer instead of a
  list, and `node tools/release.js notes --unreleased` prints what is pending. `notes
  <version>` still reads the committed changelog, so the published release body is unchanged.
- **build:** CI fails a pull request that changes `packages/` and adds no fragment under
  `changelog.d/`, so a missing release note is caught while the change is fresh rather than
  at release time (#218). Label the pull request `no-changelog` when the change genuinely
  needs no note.
- **cli/daemon:** the note on an answered gate is recorded in the run's log. `orca answer`
  takes `--note <text>` and `inputs.answer`'s existing `note` reaches `human.answered`
  instead of the daemon's own logger, so a client may show it as something the run holds —
  which the field's documentation previously had to tell it not to do. The run still branches
  on the option id alone; the note is the record of why.
- **app:** `reconnecting` becomes `disconnected` at backoff saturation — three consecutive
  failures at the 5s cap, about twenty seconds of silence. Against a daemon that has gone for
  good the status bar no longer reads "reconnecting… 4m" indefinitely. The rule is a fact about
  the retry loop rather than a stopwatch, so it survives a change to the backoff, and the
  subscription keeps retrying: this changes what is rendered, not what is attempted.
- **design:** the eight classes v0.4.0 wave 1 had to write in the app because nothing in the
  component layer named them are now in `components.css`, beside the things they vary:
  `.orca-stale-rule` (the 2px bar a reconnecting screen wears), the `.orca-dialog` family,
  `.orca-list` / `__scroller` / `__rows` and the two-line row variant, `.orca-bare` (the reset
  a mark that is also a button needs), and `.orca-minimap__tick--current`.
  `.orca-pane__head--sticky` no longer carries the lift — that is `--lifted`, so "sticks" and
  "something is passing under it" are two statements rather than one. `renderer/src/list.css`
  and `renderer/src/chrome/connection.css` are gone; the app writes no CSS of its own again.
- **design:** five tokens the layer kept reaching past — `row-log` (a line of streamed output
  is a row, derived from `mono-log`'s line height rather than restating it), `hit-min`,
  `mark-sm`, `col-time` and `col-lineno`. Five `orca-allow-literal` notes went with them, 38
  to 33. The minimap gutter is no longer a 4×3px click target: the mark still draws at
  `mark-sm` and the button around it is `hit-min` tall.
- **design:** `semantics.json` gains `agentHealth` — `unknown`, `ok`, `degraded`, `down`, each
  with the word and the glyph an agent health card renders, never colour alone, exported as
  `AGENT_HEALTH_PRESENTATION`. `unknown` is first because it is the honest default: health is
  tracked in the daemon's process and never persisted, so a daemon that has just started knows
  nothing about an agent until it contacts one. All four glyphs were already bundled.
- **protocol:** `agent.changed` is now one of the notification methods rather than a push
  beside them. It joins `NOTIFICATION_METHODS` and the `DaemonNotification` union, so
  `parseNotification` validates it and a client routes it off the one stream by name;
  `parseAgentChanged` is gone. It still carries no `runId` and no `seq`, because agent health
  lives in the daemon's memory and has nothing to resume from — a client that folds the
  cursor now tests for a `seq` rather than assuming one, which is the bug this fixes: the
  previous guard compared `runId`s, and on a store-wide subscription that comparison was
  already true. A daemon still sends it only to subscriptions that did not scope themselves
  to a run, and now honours `methods` for it like any other notification.
- **protocol:** `AgentView` gains `hostType` (`local` or `ssh`), taken from the host spec the
  agent's `hostId` names. It is absent when that host has left the config, rather than
  guessing the commoner transport.
- **protocol:** version 1.5. Both changes are additions — a method joins a list clients read
  by name, an optional field joins a view — so a 1.4 client keeps working and goes on dropping
  `agent.changed` as a method it has never heard of.
- **design:** the 32 `orca-allow-literal` notes left in `components.css` are gone, and the
  count is now zero (#244). They were never 32 numbers. `size` gains `bar-*` for a band of
  chrome — `bar-status`, `bar-pane`, `bar-title`, `bar-object` — because a bar is a height you
  read, not a height you click; `badge-*` (`badge-sm`, `badge-md`) for a mark that carries a
  word, which is why a chip, a key cap and a schedule badge sit below `hit-min` on purpose and
  a control may never borrow one; `mark-md` beside `mark-sm`, with `mark-port`,
  `mark-skeleton` and `mark-swatch` for the marks whose size is dictated by what they sit on;
  and `col-label`, `col-label-narrow`, `col-node-kind` and `col-matrix-axis` beside `col-time`
  and `col-lineno`. `control-*` keeps meaning "pointer target" and grows two rungs that do not
  loosen it — `control-xs` (a segment inside a group, where the group is the target) and
  `control-sm-5` (the half rung, named the way `space-0-5` is). `spacing` gains the other two
  half rungs, `space-1-5` and `space-2-5`, for the inline padding of a chip and of a button —
  `10px` had been written out twice for the same button. `border` gains `stroke-double`,
  because `border-style: double` needs three widths to draw two lines.
- **design:** two of those literals were arithmetic someone had written out as a number, and
  are now the arithmetic: a config label's top inset is half of what the control beside it is
  taller by, and the log caret is one hairline proud of the mono-log glyph. Both follow the
  type scale now instead of being re-measured against it.
- **design:** the hatch over the risk matrix's severe band is `hatch-period` with a
  `stroke-hairline` stripe rather than #244's proposed first permanent exemption. Rule 4 makes
  that hatch the second channel on severity, so its geometry is a design decision the system
  should be able to name, and a token it is. `components.css` and `docs/DEVELOPMENT.md` both
  say what a new note would now have to argue: not "no token names this yet" but "no token
  could sensibly name this".
- **core:** a `gate` or `decision` node's `options` may now be records —
  `{ id, label, consequence?, destructive? }` — as well as bare words. A workflow can
  therefore say what choosing an option *does*, and mark the one that destroys something, so
  the attention surface's two safety properties (show the consequence, never bind the
  destructive option to a number key) are properties of real gates rather than of fixtures.
  A bare word still reads as an option that is its own id and its own label: every workflow
  on disk keeps working and there is no migration.
- **core/engine:** everything mechanical about an option is its **id**, and always was —
  `defaultOption`, `autoOption`, the `when: "choice == '<option>'"` on an outgoing edge, the
  value a decision source has to produce, and the answer recorded on `human.answered`. A
  label is for a person and may be reworded without touching the graph or invalidating an
  answer already in a log. `vars.options` and the `fieldValues` an agent-sourced decision is
  validated against carry the ids, so a consequence clause never reaches a prompt as though
  it were a choice.

### Fixed

- **design:** `prefers-contrast: more` is honoured. `docs/design/50-accessibility-and-keyboard.md`
  has asked for it since the design system was written — swap `border-hairline` for
  `border-control`, fold `ink-tertiary` into `ink-secondary`, introduce no new palette — and
  nothing in the tree did it; only the `prefers-reduced-motion` half of that paragraph was
  ever implemented. It is two custom properties rebound on the shell root under the media
  query, so both themes keep their own values and no rule has to know the preference exists.
- **design:** stream rules and run-tree guides are drawn with CSS hairline borders instead of
  box-drawing glyphs, so a continuous guide reads as continuous (#212). At `mono-log`'s
  12px/18px a `│` is shorter than its line box, which left a gap at every line boundary and
  made a guide read as dashed. The line height stays — it is what makes a screen of log worth
  scrolling — and `docs/design/30-long-running-content.md` now records why the structure is
  borders rather than glyphs. The `#type` proof surface still draws its frame with real
  U+2500–257F glyphs, because proving the bundled faces carry them is its job, and it now says
  on the page that the gap there is expected.
- **cli:** `orca --version`, the `orca serve` banner and `hello.orcaVersion` report the
  release version — the root `package.json`, the one the tag and this changelog carry —
  instead of `@orca/cli`'s own `0.1.0`, which no release has ever been. Observable output
  changes: a `v0.4.0` daemon now announces `orca daemon 0.4.0` where it announced
  `orca daemon 0.1.0`, and the desktop app's connection details show the same string.
  `orca --version` is also a flag the CLI now answers at all: it printed the usage text and
  exited 1.
- **app:** a run that ended cancelled no longer reads as a run that failed. The timeline's
  gutter derived its marker from `run.completed` by treating every outcome that was not
  `success` as a failure, but `RunOutcome` has three values — so a run somebody stopped on
  purpose drew the same red tick as one that broke, while the *same* run ending through
  `run.cancelled` drew it correctly. The two now agree, which matters because the gutter is
  what a long run is scanned with (#249).

## 0.3.0 - 2026-09-19

### Store format

New directory `.orca/leases/`, one JSON file per held lease. Nothing reads it except the
process that wrote it, and an ORCA that never sees it behaves as before, so an existing
store needs no migration; leftover files from a killed process lapse and are cleaned up on
the next attach.

Nothing else in this release touches the store. The daemon and the desktop app only read
it — the read methods and the notification stream both project from the event log without
writing to it — and the app's own preferences live in `preferences.json` under the Electron
user-data directory, deliberately not in the workspace. An existing `.orca` store works
unchanged with everything below.

### Added

- **store:** `LeaseStore` — a single-writer lease with a TTL and a heartbeat
  (`InMemoryLeaseStore`, `FileLeaseStore`, `keepLease`), reusing the lock file's
  holder-identity and take-over logic. `Stores.leases` is new.
- **engine:** driving a run now takes the lease `run:<runId>` and heartbeats while attached,
  so a second interpreter over one store is refused with `RUN_LEASED` instead of
  interleaving its steps into the same log (#101). A lease whose holder stopped heartbeating
  — or whose process is gone on this host — lapses and is taken over on the next attach.
  `Orchestrator.listLeases()` / `breakLease()` are the operator's way in.
- **cli:** `orca leases [list | break <runId> [--force] [--keep]]`.
- **daemon:** `orca serve` and the packages behind the desktop app — `protocol` (the wire
  contract: envelope, `hello` handshake, versioning, error codes), `daemon` (HTTP transport
  and the method table; only `hello` so far) and `app` (an Electron shell that completes
  the handshake through the protocol package and nothing else). ADR 0008 records the
  layering.
- **design:** the desktop app's design system — `packages/design` (token sources, the
  generator, generated CSS and TypeScript tokens for light and dark, the CSS component
  layer, WCAG AA contrast tests) and `docs/design/` (the brief, brand book, UI rules and
  surface specs). `pnpm run design:check` in CI keeps the generated files current.
- **app:** the renderer is React, bundled by Vite, with `pnpm --filter @orca/app dev` for a
  hot-reloading dev loop against a running daemon (#145). Main and preload stay on the
  workspace's `tsc -b`; `pnpm run build` produces `packages/app/dist/renderer` alongside
  them. The production CSP (`default-src 'self'`, no `unsafe-inline`) is what ships — the
  dev server's wider policy exists only in memory. The import boundary from ADR 0008 now
  covers the renderer as well as `packages/app/src`.
- **app:** the React primitives over `components.css`, in `packages/app/renderer/src/ui`
  (#147) — `StatusChip` and `StatusDot`, `ScheduleBadge`, `ConnectionIndicator`, `Button`,
  `Chip`, `Card`, `Well`, `ConfigField`, `ObjectHeader` with the counterpart menu per crumb
  type, `StateView`, and `Text` / `Duration` / `Time` over the generated type styles. No
  primitive carries a literal colour, size or glyph: the statuses come from
  `STATUS_PRESENTATION` and the durations render two units at most, ticking at 1Hz off one
  clock shared by the whole renderer.
- **app:** `#preview` in a dev build renders every primitive in both themes side by side,
  driven by the design system's own lists. It is the visual review surface for the rest of
  the desktop-app milestone and is dead code in a production build.
- **design:** `STATE_VIEW_PRESENTATION` and `CHROME_GLYPHS` are generated from a new
  `stateView` and `chrome` section in `semantics.json`, so the state views' glyphs and the
  breadcrumb separator are covered by the bundled-font check like every other glyph.
  `components.css` gains `orca-well`, `orca-menu` and the object header's trail and
  disclosure classes.
- **app:** theme and density (#146). `data-theme` on `<html>` with a persisted preference of
  system, light or dark, cycled by `⌘⇧L`; `data-density="compact"` per surface root,
  toggled on the focused surface by `⌘⇧D` and remembered per surface. Preferences live in
  `preferences.json` under the Electron user-data directory, never in the ORCA YAML. The
  window's native background is the theme's `surface-canvas`, so opening in dark no longer
  flashes white. `installAppearance` sets the attributes before React mounts and
  `AppearanceProvider` hands components its actions, never its state; the keyboard map
  every shortcut registers with (`KeyboardMap`) is the seed of the palette's registry (#149).
- **design:** the generated `prefers-color-scheme` block now sets `color-scheme` too, so
  native scrollbars and form controls follow the OS theme when no `data-theme` is set.
- **app:** the window chrome (#148) — title bar (drag region, platform-detected insets, the
  connection state, the ⌘K affordance), a sidebar over the five surfaces that collapses to
  icon-only below 960px, a primary pane with an object-header slot, a docked panel that
  becomes an overlay below 1100px, and a status bar. Routing between the five surfaces
  lands on Attention by default; the primary pane is the surface root density is remembered
  by, and ⌘1–⌘5 and ⌘\ register in the keyboard map like every other shortcut, so the
  palette (#149) will list them. New tokens: `sidebar-width-collapsed`, the title bar's
  platform insets, and a `breakpoint` family for the two layout thresholds, exported as
  `BREAKPOINTS` in plain numbers because a CSS media query cannot read a custom property.
- **app:** the command palette and the keyboard map registry (#149). `⌘K` opens a palette
  on `surface-raised` over a scrim, with three sections in the order the information
  architecture sets — actions on the current object, navigation, search — and every
  registered shortcut listed with its key beside it. It opens and drives entirely from the
  keyboard, focus returns to where it was on close, and the title bar's `⌘K` affordance is
  now a button, so nothing here is reachable by keyboard alone or by mouse alone. Typing a
  run id or an `orca://` URL offers a jump row; resolving it is #165, so until then the row
  is listed and disabled rather than silently doing nothing. Search sources arrive with the
  surfaces that hold the data — no source is registered yet and the palette says so rather
  than inventing results.
- **app:** the keyboard map now resolves a keypress's scope from focus. A component owns a
  scope by marking its subtree `data-kbd-scope` (`scopeProps`), and a press is offered to
  each scope from the focused element outwards before `global`, so two surfaces can bind
  `F` without colliding. Inside a text entry only modified keys and `Escape` dispatch.
  `Shortcut` gained `section` and `detail`, for where the palette files it and what it
  says underneath.
- **app:** `Esc` goes through a transient layer stack (`LayerStack`): it closes the layer
  that opened last — the palette above an overlaid panel — and a layer holding an unsent
  draft swallows the key instead of discarding it. Nothing takes a draft yet; the rule now
  has somewhere to live when gate cards do.
- **design:** a `z` token family (`z-panel-overlay`, `z-palette`) so a floating layer's
  stacking order is a token like every other value, and `palette-width`,
  `palette-max-height` and `palette-offset-top` for the palette itself.
- **daemon:** the five read methods over `Orchestrator` — `runs.list`, `runs.get`,
  `runs.events`, `inputs.list`, `claims.list` (#150). They answer display read models from
  `@orca/protocol` (`packages/protocol/README.md` is the reference), not `RunState`: a run
  carries a name (work item, else request, else workflow), the eight-value `DisplayStatus`,
  durations and the wait it is in; a run tree carries every attempt, its child runs and the
  fan-out branches that never ran; `runs.events` pages a log by sequence number in both
  directions. `orca serve` now bootstraps the workspace's store, reports `runs.read` and
  lists the methods it serves in `hello`.
- **protocol:** `DisplayStatus` and the one fold onto it (`displayStatusForRun`,
  `displayStatusForStep`) — the engine's run statuses, outcomes and step statuses become the
  eight words `packages/design/semantics.json` draws, in one place, tested against that file
  so the two lists cannot drift. A run that claims to be running with no live lease behind it
  is `stale`.
- **core:** `@orca/core/schemas`, a node-free subpath carrying the domain model and event
  schemas. `protocol` takes its runtime schemas from there rather than the package root, so
  bundling the protocol for the renderer no longer drags `node:crypto` and `node:fs` in with
  it. The root still re-exports every one of them; only a browser bundle needs the subpath.

- **daemon:** `WS /socket` beside the HTTP endpoint, carrying the six `notification`
  messages off `Orchestrator.subscribe()` — `run.changed`, `step.changed`, `agent.update`,
  `input.opened`, `input.answered`, `event.appended`, each with the sequence number (#151).
  The HTTP path is unchanged and a read-only client never opens a socket; `subscribe` over
  `/rpc` answers `NOT_SUPPORTED` rather than "unknown method", and `hello` advertises the
  methods either way. Reconnect costs latency and never data: the daemon attaches its
  listener before reading the log and drops what it already replayed, so resume from cursor
  `n` yields `n+1` onwards with no gap and no duplicate. Agent output is coalesced to one
  frame per step per 100ms, and a held batch is flushed before any other notification for
  the run, so output never lands after the `step.completed` that ended it. `run.changed`
  and `step.changed` never carry `stale` — a lapsed lease is the absence of events, which
  no stream can announce. The socket fans out this process's event store, so a run appended
  by a separate CLI process still appears only on the next read (#196).
- **app:** the Runs surface (#152) — the first screen with real data behind it, and the
  proof of the whole path live. Fixed-height rows from `--row-h` with a status chip, the run
  name in mono, the workflow and version, elapsed or total duration and the agent; `J`/`K`
  and the arrows select, in the `list` scope of the keyboard map. Status filtering is a
  `runs.list` parameter so the daemon filters the whole store; text filtering is local to
  what is held, because the protocol has no text parameter. Updates arrive on `run.changed`
  and nothing re-reads the list; a notification for an unknown run is resolved with one
  `runs.get` and inserted. A lost connection keeps the rows, marks them stale and stops the
  clock rather than accruing an elapsed time against a daemon that is not talking.
- **app:** one `Menu` primitive carrying the popover contract for every popover after it
  (#202) — roving focus, `Home`/`End`, typeahead, `Enter`, and focus returning to the
  trigger on close including on `Esc`. Placement flips rather than clips, decided by a pure
  function over rects so it is testable where there is no layout engine. `ObjectHeader`
  consumes it; its own open state, `Escape` handler and outside-click listener are gone, and
  `Esc` is now only the layer stack's.
- **design:** `#type` in a dev build (#194), the proof surface for the bundled faces — every
  type style with real sample text, the statuses and connection states with their glyphs,
  `mono-id` pairs and a `mono-log` block, in both themes, all derived from `tokens.json` and
  `semantics.json` rather than re-declared. Its toggle swaps the bundled faces for the OS
  stack, which is the only way to see the silent failure #144 could not rule out: a glyph
  that falls through still renders, just in another typeface.
- **tests:** the renderer test kit (#154) — a helper that mounts a component in both themes
  against the real `tokens.css` and asserts on the token it resolves to, and a fake preload
  bridge whose read methods page and filter the way the daemon's does, from fixtures dumped
  from a real `ReadModel` run. Plus an Electron smoke test (Playwright's Electron driver
  against the built app and a demo daemon: the bridge loaded, the handshake reached the
  daemon, both themes, axe clean) in its own workflow, since `ci.yml` installs without the
  Electron binary. The renderer joins the coverage report.
- **tooling:** `pnpm run lint` now enforces rule 1 of `docs/design/RULES.md` (#153) — a CSS
  check rejecting hex colours, colour functions and names, `px`/`rem`/`ms`/`s` quantities
  and bare `z-index` values, and an ESLint rule rejecting colour and length literals in
  inline `style` objects. `0`, percentages and the relative units are allowed. The escape
  hatch is to add the token and rebuild, and both messages say so. `components.css` is
  checked for colours and stacking order only for now; the ~190 literal type sizes and box
  heights it still carries need a type-scale vocabulary `tokens.json` does not have yet.

### Changed

- **protocol:** version 1.2 — `subscribe` / `unsubscribe` and the notification schemas.
  Additive, like 1.1 before it.
- **protocol:** version 1.1 — `HelloResult.methods` lists the methods a daemon answers, so a
  newer client can degrade per screen rather than per daemon. Additive: a 1.0 client is
  unaffected.
- **app:** the preload is built as CommonJS to `dist/preload/index.cjs` (#198). `packages/app`
  is `"type": "module"`, so it was emitted as ESM while the window was created with
  `sandbox: true` — and Electron refuses an ESM preload in a sandboxed window, reporting it
  to the renderer's console rather than failing the launch. `window.orca` was therefore
  `undefined` and every screen would have landed on a renderer with no bridge. The sandbox
  is kept and the module format gives way; the source is now `src/preload/index.cts` with
  its own tsconfig project.
- **engine:** `Orchestrator.cancel()` on a run this process is *not* driving now takes the
  run's lease before closing it, so cancelling a run another interpreter holds fails with
  `RUN_LEASED` rather than racing `run.cancelled` into a log that keeps growing.

### Fixed

- **engine:** `Orchestrator.pendingInputs()` no longer fails for a whole run tree when one
  child's log is missing from the store; that child is skipped, as `runTree` already did.

## 0.2.0 - 2026-09-19

### Store format

No change since the groundwork commit, but two additions an existing store predates:
the plan journal (`plan-journal.jsonl`), and work-item claims. Event sequence numbers are
now assigned on disk under a lock file rather than from an in-process counter, so two
processes writing one store no longer collide (#97).

### Added

- **plan:** a planning layer over the engine — cross-request dependencies, a risk matrix,
  decision matrices and an explainable scheduler that orders work by dependency, risk and
  priority (#85).
- **plan:** `custom:plan-dispatch` drives work items through the same fan-out `parallel`
  uses, so `failFast` cancels in-flight items and `onWaiting: wait` logs one event per
  reason under a default timeout (#96).
- **cli:** `orca claims` lists who holds which work item and `orca claims release <id>`
  frees an item whose owning run died (#88).
- **engine:** human waits survive the process in `pause` mode; `orca answer <requestId>
  <option>` resumes a parked run (#35).
- **agents:** a wedged agent that ignores `session/cancel` is killed rather than hung on
  (#50), with SIGKILL escalation after SIGTERM actually taking effect (#41).
- **build:** ESLint, Prettier and coverage reporting, with thresholds enforced in CI and
  a per-package coverage table on the run summary (#43).

### Changed

- **engine:** one fan-out implementation behind `parallel`, loops and plan dispatch, and
  work-item status projected from the event log rather than tracked twice (#70, #74).
- **engine:** a work item is claimed before it is launched, so two dispatchers cannot run
  the same item twice (#72); artifact intake is serialised per plan (#73).
- **store:** the JSONL event store and plan journal share one on-disk sequencing and
  append primitive, guarded by a lock file (#97).
- **build:** migrated from npm to pnpm, which lets several checkouts on one machine share
  a content-addressed store instead of a full `node_modules` each (#48).
- **cli:** `orca --help` exits 0, and `orca demo` cleans up its temporary workspace unless
  `--keep` is passed (#93).
- **perf:** `orca runs` reads a summary projection instead of replaying every event (#61);
  artifact-presence checks are batched and paced (#54).

### Fixed

- **plan:** `custom:decision-matrix` no longer re-decides a decision that artifact intake
  already settled (#79); risk-matrix thresholds follow the configured scale and reject
  out-of-range ratings (#81).
- **plan:** object-form dependency refs honour `on`, and every intake path rejects what the
  dependency grammar rejects (#77).
- **plan:** scheduler explanations, the critical path and cycle messages agree with each
  other (#80); cycle detection ignores `soft` edges (#71).
- **plan-resume:** dispatch reads `vars.itemWorkflow`, so `program.itemWorkflow` actually
  steers `orca plan dispatch` (#92).
- **engine:** `cancel()` unblocks a run parked on human input (#34); resume re-attaches
  container steps to their child runs (#40); retries and run termination no longer
  hard-code node types (#69); loop iterations see earlier siblings' artifacts (#68).
- **core:** artifact ids are merged on `step.completed` instead of overwritten (#37).
- **acp-facade:** human input is routed per run rather than to one global target (#57).
