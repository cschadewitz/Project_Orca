# Dedicated first-run slice

Base: draft #559 `61ffe6ddebf1e5e0946e8cf237d9d1218bfa6664` over supplied
main `db579fb7ac9cfce2e4e6901713088a80602311da`. Contracts consumed:
#386/#390, closed #420/#427 and accepted #440/#542 plus #559's guided-launch README.
Root confirmed the fixed agent-free sample as a launch smoke check; it does not
replace #420 coding-fix or #390 real-agent evidence.

## Owned behavior

`FirstRunSetup` stages two native directory selections: an existing prepared Git
project checkout and a separate empty app workspace. Selection writes nothing.
A main-owned review handle names the exact canonical paths, meaningful filesystem
identities, current user ownership, attached branch and base. The explicit Prepare
step rechecks identity/branch/base, empty workspace and caller epoch before writing
new files exclusively. It never initializes Git, changes the project checkout,
overwrites selected files, normalizes `.orca` into a writable root or falls back to
home. Cancel/back retains the previous selection. Wrong identity, nonempty roots,
overlapping roots, denied access or missing Git refuse with a safe recovery message.

Only the empty app workspace receives `orca.config.yaml` and `first-run/` assets.
Fresh configuration explicitly binds the local project root, separate `.orca` store,
empty agents/roles/plugins/templates, the one workflow and pausing human input.
No JEV/TypeSafe registration, provider credentials or standing grants are added.
A separate main-profile selection receipt holds paths/identities/file hashes, no
credentials or inputs. This app-owned receipt is atomically replaced only after an
explicit new reviewed selection. Selected files always use exclusive creation.
Incomplete preparation preserves its files and requires a fresh empty workspace.

Reopening checks both root identities, that the project is still its repository's
top level, and exact prepared files before connection. The receipt's branch/base record
what was reviewed at selection; commits, pulls and branch switches in the project are
ordinary work and do not invalidate the workspace or strand its store. Guided launch
captures fresh checkout evidence for each launch. A different repository at the saved
path is a different directory identity and refuses. An in-place re-initialized `.git` in
the same directory is not detected; that is the same-principal boundary below.
Modifying the prepared config/assets invalidates this setup receipt;
there is no silent repair or adoption. This narrow bootstrap deliberately does not
certify persistence of later real-agent configuration changes; a reviewed migration
or explicit rebind remains integration work. Windows ownership is unavailable here:
without a reliable current-owner observation the implementation fails closed. Linux
portable checks do not establish macOS or Windows native proof. Directory evidence
is a bounded observation, not an immutable filesystem snapshot or protection against
concurrent mutation by the same OS principal.

`FirstRunSection` mounts in the existing Config body and survives daemon-unavailable
configuration states. It shows native selection, reviewed creation and separate
connection actions. Existing diagnostics retain their key and lifecycle. The launch
route's smoke-check selector populates the exact direct task; it never submits or
acknowledges permissions automatically. Existing protected intents remain separate.

## Native lifecycle composition

Original #564 left main/preload/Workspace unchanged under root's ownership split.
The combined integration now registers `OrcaBridge.firstRun?: FirstRunBridge` from
`src/first-run-contract.ts` in main and preload, stages exact owned Workspace candidates,
and removes implicit home startup. The optional bridge is now a declared contract.
See [combined integration](../../../../../docs/archive/implementation/first-run-native-integration.md)
for current evidence and filesystem limits; source/portable composition is not native
end-user acceptance.

Compose `FirstRunSetup` with:

- `home`: Electron's home path used only as a forbidden-root comparison;
  `receiptPath`: app-owned userData `first-run/selection.json`.
- `choose(kind)`: main-native directory dialogs. Project asks for an owned prepared
  Git project; workspace asks for a separate empty writable folder. Return `undefined`
  on cancellation. Never accept a renderer-supplied path.
- `prepareConnection(path)`: a disposable **new bundled** candidate for that exact
  workspace, with `--config <path>/orca.config.yaml`, known owned child PID in
  `expectedProcessId`, and a token-file client (`env: {}`, authentication required).
  Reserve it against updater/connection changes, return `check`/`dispose`, preserve
  the old target until synchronous `activate(hello)`, and never probe default ports
  on failure. Dispose only that owned candidate. Avoid a competing child for an
  already active or parked same workspace. Existing updater holds/cleanup remain
  the native owner's authority.
- `current(path)`: true only for the same already verified bundled writable workspace
  and current identity. It prevents repeated Connect from restarting that child.

The service captures authentication, reads hello then credential-backed
`operator.discover`, requires matching workspace/instance, owned PID, exact store
path, compatible protocol and read/control/subscribe capability, rechecks receipt
and caller epoch, then activates. This is connection setup, never run admission.
The candidate contract alone is not native process proof; the adapter must satisfy it.

Forward `status`, `choose`, `prepare(id)` and `connect` via
`orca:workspace.firstRun.{status,choose,prepare,connect}`. These routes intentionally
use the existing workspace-transition IPC fencing rather than post-dispatch fencing
against the old epoch. Pass a captured-epoch assertion into the three mutating methods;
keep IPC/update guards authoritative. Before Connect, guard **other** unsent editor
and protected launch work through existing connection-draft review. Setup itself is
not a renderer text draft; use `firstRun.isBusy` to prohibit updater changes during
native dialog/provision/connection work, rather than having setup block its own
connection guard.

At cold startup, verify `status()` before considering a saved selection. Without an
explicit supported environment/saved remote target or verified selected workspace,
start no bundled child and perform no default endpoint probe. Remove the current
`app.getPath("home")` default. A verified selected workspace may reconnect through
`firstRun.connect`; retain explicit remote/environment precedence and do not silently
replace it. Native setup must remain usable before daemon handshake. Failed startup
keeps setup plus the existing consented diagnostics path reachable.

## Exact harmless sample and remaining acceptance

<!-- rename-keep-start: the sample keeps its id through the rename so existing workspaces still match -->

Workflow: `orca-beta-local-check`, version `1`, normalized production revision
`sha256:31027c78fb1ea553caf218b8366e7ea08d6a141efce5cb53b32e781fd7390567`.

<!-- rename-keep-end -->

`src/first-run-sample.ts` is the immutable packaged source for workflow and exact
`task.json`, `instruction.md`, `result.json` assets. The workflow metadata binds
all three asset SHA-256 identities and the accepted #420 shipping/test/README/reference
patch digests. It is start → set synthetic result marker → end, with one fixed typed
task and rejected unknown inputs. It has no executable/agent/plugin node.

The production launch adapter reserves this ID for that version/revision, exact
owned local asset bytes and direct task. Request mode, changed task, same-ID wrong
revision or altered asset bytes refuse. Catalog checks can omit an unavailable
sample without affecting unrelated workflows. Preflight and submit recheck asset
bytes, and the normal protected command/generation/checkout/idempotency guards stay
in force. The result asset is a **specification**, not a per-attempt artifact; inspect
the actual run/steps for terminal completion and synthetic marker. It produces no
diff/test artifact or coding result. The separately bound `beta-first-job-v1` task
still needs disposable fixture preparation, exact baseline/reference fix/test evidence,
explicit tool/sign-in/transmission/cost/permission/time-limit authorization and a real
agent workflow. Setup cannot configure or launch that provider implicitly.

Portable tests exercise actual directories/Git and production parser/digest/interpreter,
with synthetic candidate/HTTP/renderer seams. Missing ownership, denial, tampering,
cancellation, root replacement, stale epoch, incompatible/wrong daemon and replay
refusals are covered. Native integration, Finder PATH/tool/architecture and cancellation,
OS ownership/permissions, secure storage/restart, packaged sample, physical Mac/Windows,
real-agent coding fix and #416 manual diagnostics acceptance remain open. Root owns
exact-head CI, integration, merge and final #386/#390 acceptance.

## Narrow #559 compatibility correction

Original exact-base check:
`./node_modules/.bin/eslint packages/app/test/guided-launch-adapter.test.ts`
failed at 75:39 with `@typescript-eslint/no-base-to-string` on
`JSON.parse(String(init?.body))`. The standalone commit
`351cef486dafbb0a19aa08cc19f3265fe57e9aae` checks
`typeof init?.body === "string"` before `JSON.parse(init.body)`.
Unsupported body types still fail; all original assertions are preserved.
The same focused command passes after the change. Direct binaries were used because
this environment's pnpm runner attempted a dependency-state reinstall into an
unavailable home data path. No manifest/lockfile/dependency change was made.

## Original #564 local validation record

Final focused selection: `vitest run` for app `first-run`, `guided-launch-adapter`,
CLI `first-run-sample`, and renderer `first-run`, `guided-launch-route`,
`configuration-studio-route`, `guided-launch-restore-safety`,
`guided-launch-shared-bindings`: 65 passed, one conditional skip of the Windows-only
missing-current-owner assertion on this POSIX host. Positive native acceptance is
not skipped or claimed by this source suite.

Focused ESLint and Prettier checks pass over changed TypeScript/TSX; root and renderer
TypeScript no-emit checks pass; Vite production renderer build passes (existing
large-chunk advisory only); scoped CSS token check and `git diff --check` pass.
These checks use installed dependency binaries, with no package install, lockfile or
manifest edits. The original worktree stays on `work` at the supplied main SHA.

The #570 successor adds main-only launch capabilities, kernel lifetime admission,
explicit same-boot reconciliation and quiescent saved-config binding. Shared entrypoint
composition and legacy limits are documented in
[the handoff](../../../../../docs/archive/implementation/first-run-same-boot-recovery.md).
An attempt left by an earlier boot is settled only when a person confirms **Mark previous
session ended** (`recovery.ts` `endPreviousBootSession`), described in that handoff.

## Current #386 agent evidence

[Local-agent preflight and recovery](../../../../../docs/archive/implementation/386-agent-preflight.md)
documents the current observation-only projection, explicit support/version/ACP/sign-in
gaps, cancellation and separately authorized real-agent handoff. Config binding does not
clear #594's unsupported exact-command hold or supply native/physical acceptance.
