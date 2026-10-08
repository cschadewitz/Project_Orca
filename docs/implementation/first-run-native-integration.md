# First-run native composition — 8 October

The integration preserves exact #563 `732d85d92a5270bcebe10132b0ba27aac90c3862`
and #564 `6d16ddd3ab5d0abd5bbe938256b2d2eaeee96c4f` as ancestors over main
`db579fb7ac9cfce2e4e6901713088a80602311da`. The merge preserves every constituent
commit, including #559's isolated lint fix `351cef486dafbb0a19aa08cc19f3265fe57e9aae`.
Original branches and the handoffs in [native lifecycle](native-lifecycle-integration.md)
and [first-run setup](../../packages/app/src/main/first-run/README.md) remain available.

## Implemented composition

Main installs `FirstRunBridge` and its four workspace-transition IPC routes before
handshake. Native dialogs supply paths; the renderer supplies only a main review handle.
Caller ownership, exact main frame/document generation and captured connection epoch
are rechecked through dialogs, provisioning and final activation. Prepare cannot replace
the selection receipt after an observed caller change. A successful connection advances
the epoch synchronously, so its transition reply is not rejected against the old epoch.

Connect holds the existing cross-window editor/protected-launch draft review. Setup is
not registered as its own unsent text draft. Setup activity blocks Windows update actions,
Mac draft/admission acquisition and target switching. The existing owned-stop/restart
admission fence also refuses the new first-run candidate path after a stop attempt.
Diagnostics initialization, consent/document/epoch checks and enum-only startup observation
are preserved. Neither capture nor production Mac updater routing is enabled.

Workspace reserves one exact bundled candidate for `--config <selected>/orca.config.yaml`.
Its known child PID and exact selected `auth/local-client.token` path are mandatory.
Bundled clients require authentication and exclude environment credentials. FirstRunSetup
captures authentication for hello and credential-backed discovery, verifies PID/store,
protocol, writable/read/subscription capabilities and matching workspace/instance, then
rechecks filesystem receipt and caller. Final identity validation precedes synchronous
preference publication and activation. Failure disposes only the new owned candidate;
the old client/stream/target and preference remain intact. A parked child of the same
verified selection is reused; unknown same-store ownership and competing parked targets
are blocked. Repeated Connect reuses the active verified writable child. Cancellation,
closed Workspace and late spawn/results cannot activate it or seek another endpoint.
First-run startup disables automatic child retries. Ordinary stop timeout is not exit
proof: unconfirmed startup/cleanup retains the process-local reservation and blocks
another candidate or updater. Positive direct-child terminal fields permit cleanup
release. The inherited startup API does not return an owner on failure, so uncertainty
conservatively blocks further first-run connection in that session. Durable ownership
across app restart remains an explicit native integration blocker; this is not a
recovery policy or proof that a timed-out child has stopped.

Cold startup verifies `status()` before considering the receipt. Explicit environment
or saved endpoint precedence remains. An intact selected workspace uses the strict
first-run connection; no target/verified receipt means an inert client, no child and no
default-port subscription. The implicit home path is removed. The explicit
`ORCA_WORKSPACE` development path retains its existing behavior; selected first-run
failures never use that development fallback. Native setup remains mounted in Config
while disconnected. The existing read-only store action stays separate.

## Filesystem assumptions and blockers

Selections require an existing prepared, owned writable Git checkout and a separate
empty owned writable app folder with canonical identity and attached branch/base.
They never create a disposable Git project, change its checkout or adopt/repair altered
config/assets. The receipt intentionally certifies the fixed setup; later real-agent
configuration edits still need an independently reviewed persistence/rebind design.

Reopened `.orca` and `auth` trees now undergo bounded identity/owner checks before spawn
and after handshake. Symlinks, multiply linked files, special files and different-device
or owner entries refuse, including redirects below those roots. The total inspection
budget is 8192 entries; exhaustion or uncertainty refuses. Nothing chmods, normalizes,
deletes or quietly adopts a refused tree. This is a bounded observation, not immutable
filesystem or handle-relative protection against concurrent mutation by the same OS
principal. Native ownership/permission and filesystem behavior remain physical gates.
Windows has no reliable current-user ownership observation here and remains blocked.

The default sample remains strictly JEV-free and agent-free start/set/end launch smoke.
It is not the separately required #420 coding fix, proof of real-agent configuration
persistence or #390 acceptance. No provider is configured or started by setup.

Casey's drain-then-update decision was supplied as compatibility context. This slice
preserves the existing closed-admission fence; it adds no installation, force-stop,
discard, rollback or restoration policy. Production updater activation remains disabled.

## Portable evidence and inherited CI fixes

Node 24.19.0, installed dependency binaries, unchanged manifest/lockfile. No install,
broad suite/coverage, workflow dispatch, native addon build, provider or live host work.

- Focused Vitest: **403 passed, 1 conditional Windows-only ownership assertion skipped**
  in 25 files with `--maxWorkers=2`, 52.31 seconds. Selection covers first-run service,
  Workspace and real CLI child, main IPC and sandboxed preload; native lifecycle and
  daemon process; Mac admission/guards/restart/rehearsal/windows/coordinator/application;
  Windows updates; diagnostics storage/startup; guided launch adapter/routes/configuration,
  restore/shared bindings; and production CLI sample parser/digest/interpreter.
- New real-child evidence prepares temporary Git/app directories, runs compiled production
  CLI source, authenticates hello/discovery, verifies exact config/store/owned PID and
  confirms repeated/reopened selection reuses the same child. The fixture entry supplies
  a synthetic version marker; it is not a packaged image. Subscriptions are a seam in this
  case; actual owner-token RPC, process startup and cleanup execute. Main IPC and actual
  preload are separately exercised with Electron at their boundary.
- `./node_modules/.bin/eslint .` and the repository CSS token checker pass. Root and renderer
  no-emit TypeScript, `tsc -b tsconfig.build.json`, Vite production build, changed-code
  Prettier and `git diff --check` pass. Vite retains its ordinary large-chunk advisory.
- Production daemon bundle builds with `node packages/app/scripts/build-daemon.js`;
  `node tools/probe-bundled-daemon.js` confirms authenticated protocol 2.0 and version 0.6.0.
- #559/#564 lint fix is integrated unchanged: fetch body must be a string before JSON.parse.
  #563's reported Node 22 CI failure in `native-storage-syscalls.c` is also corrected:
  the hold-pipe read retries EINTR and asserts EOF rather than ignoring its result.
  Existing SIGKILL/lock-release assertions remain. The focused fixture explicitly compiles
  with `-std=c11 -O2 -D_FORTIFY_SOURCE=3 -Wall -Wextra -Werror` and executes successfully.
  The additional compiler check takes under one second locally; no broad CI rerun is made.
- Final self-review added unknown-child cleanup retention and parked-store exclusion.
  Affected regressions then passed **95 tests in 7 files**, with the same one Windows-only
  skip, in 6.41 seconds. One new uncertainty case is included. A prior smaller regression
  selection also passed after directory-root validation. No broad suite was repeated.

Mac/Windows hosts were unavailable. Finder PATH/Git/tool/architecture and picker behavior,
native Keychain/DPAPI and secure-storage restart, packaged/signed/downloaded candidate,
native addon placement/durability/privacy and physical acceptance remain unproven.
Real-agent #420 evidence, configuration persistence/rebind, #416 diagnostics acceptance,
complete protected-state/matching-binary recovery and durable replacement-admission
identity remain separate gates. Root owns exact-head CI, independent review and merges.
