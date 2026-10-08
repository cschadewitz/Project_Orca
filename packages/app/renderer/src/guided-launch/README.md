# Guided launch integration boundary

This isolated #334 slice starts from main `65606fbce827cba914a67b999b1a47c0aab2797a`
and the reviewed #440 packet `4aa142e870c9cedcd4d26108d975c0f7c7f4619a`.
Final delivery incorporates main `10834758e49a5e84b9ac06e3bca85f87be923dac`
and the protected-restore corrections at `b12a8642e5a1f2284b09a341ed6048c54f125be8`.
The dependency refresh incorporates main `93aa9d1352bb25a24e9fb84940674c3e5dcd78f9`,
which includes the merged shared launch declarations from #542.
It is not registered in the shell and does not add RPCs, persistence, provider discovery,
workspace provisioning or publication behavior.

`GuidedLaunchController` consumes `LaunchPorts`; `GuidedLaunch` composes shared UI primitives.
Canonical `EditorTarget`, command and preflight types come from #542 declaration commit
`703c422aef6df7b0af008ec53349cab3e711f2f5`. The remaining UI projection, draft and optional
two-phase retention interfaces are explicit local seams. `shared-bindings.ts` maps canonical
checkout evidence, coherent reads, atomic submission and all response/recovery kinds without
adding wire properties. The dedicated fixtures are synthetic, not the accepted sample or a
native checkout binding. The shared declaration is now available from main; it was brought
in by the main merge and has not been independently copied or modified by this worker.

The canonical adapter preserves the exact checkout observation from preflight and supplies
it unchanged to main's independently verified submission. It removes client-owned retry/scope
fields from the command. Main still owns secure retention before sending and key allocation.
Atomic submission can lose the acknowledgement before returning its retained handle. In that
case the controller freezes the exact original review and permits only exact-review retry on
the same connection; it never infers correlation from workflow/target-only `retained()` rows.
Target/epoch movement blocks that retry and visibly requires main-owned inspection.

Narrow shared gaps remain explicit: a verified exact intent reference after acknowledgement
loss across connection movement; protected draft/command restore beyond retained metadata;
Request override validation/provenance beyond the vars-only preflight; and an unambiguous
abandonment-success outcome before clearing the local intent. The canonical declaration alone
does not prove these persistence or recovery semantics. Missing adapters keep the relevant
operations blocked rather than claiming unsupported behavior.

The integrator must supply these concrete bindings before enabling the surface:

- Current verified endpoint/workspace/instance/principal/epoch, authorization reasons,
  active generation and authorized workflow/selection projections. Refresh via existing
  notifications/connection ownership, not polling. Call `contextChanged` on relevant
  invalidations; that conservatively invalidates review and fences late responses.
- Coherent operator preflight plus a reviewed root ownership/base freshness adapter. Its
  `rootId`/`rootRevision` values are explicit app-local evidence bindings, not new wire
  properties or inferred paths. Root selection changes no runtime config by itself.
  Unsupported target/root/workflow combinations must remain blocked.
- The reviewed app sample workflow ID/version/digest, task/instruction/result bindings.
  Existing Linux `cal-codex-work` v3 is not implicitly certified for this beta.
- Protected guided command/draft retention. Optional `retain` must persist the exact frozen target,
  root, guards and command before returning an opaque handle. The palette journal currently
  stores only workflow correlation and is insufficient. No renderer key or second retry
  ledger is introduced. The canonical `launch` path instead delegates retention plus submission
  to `GuidedLaunchPorts.submit`. Missing adapters visibly block submission/restart claims.
- `submit` must use the captured connection and retained original command/key, checking
  current authority/target again. Initial direct responses are flat `RunsAdmitResult` with
  operation identity; initial Request responses are flat `RequestsSubmitResult` without an
  operation identity. Recovery returns the unflattened resolved/in-progress envelope.
  Only an accepted receipt navigates; prepared, failure and in-progress remain unresolved.
  Canonical typed refusals can be mapped to `LaunchPortFailure`; its local classification
  never invents daemon error codes or echoes raw transport messages. Unknown response loss
  stays ambiguous and retains the original intent.
- `restore` must verify the protected exact command, handle and original scope under the
  current target/authority. Explicit same-scope reconnect review permits recovering the
  retained handle even after generation/workflow changes; it never rebuilds a command.
  Pending intents cannot transfer to another endpoint/workspace/principal. Explicit
  abandonment starts new work and does not cancel an existing run.
- Layer ownership for Close/Back/Escape and focus restoration, shared announcement delivery,
  settings navigation, route/palette registration and refresh. The surface adds no live
  region, global shortcut handler, connection probe or subscription.

Typed input parsing retains false, zero, empty strings, null and nested JSON separately
from omission. Invalid typed text remains in the current control and blocks preview; it is
not a serializable protected draft. Defaults and schema constraints are resolved by the
daemon. Sensitive and undeclared inputs are withheld from preview. Request selectors use
only injected authorized choices; direct commands support no overrides. No completion
percentage, ETA, cost or automatic publication is claimed.

Protected reads publish a busy latch through controller state so controls cannot drift
from the draft while a restore is pending. Empty reads retain the current draft and review;
target changes fence late results. Input controls update their local text only after the
controller accepts the edit. A current unresolved launch must be recovered before restoring
another launch.

Preview disclosure is captured with the exact review and sensitivity remains monotonic
through this controller session, including nested sensitive fields. Restored draft and
command values are conservatively withheld because the current protected-store seam does
not verify their original sensitivity metadata. New schema flags cannot downgrade that
protection. These local safeguards do not establish protected persistence or extend the
shared wire contract.

Dedicated source/DOM tests cover these local boundaries. They do not establish actual-daemon,
OS keychain/process restart, cross-client, Electron, packaged or physical acceptance.
