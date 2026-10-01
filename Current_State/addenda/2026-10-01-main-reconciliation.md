# Reconciliation with main — 2026-10-01

This addendum updates the interpretation of the historical review; it does not update
its baseline, dates, evidence, comparisons, corrections or original validation results.
Read [C01–C04](corrections.md) with the frozen files. The living
[capability ledger and issue roadmap](../../docs/ROADMAP.md) describes current behavior.

## Revisions and import

| Role | Exact revision |
| --- | --- |
| Implementation reviewed on 2026-09-29 | `09f32690ffca5d9c79f6d8702481f6efe30a4cf3` |
| Imported `casey/Review-Prompt` tip | `93d6999a97635b26c0ad492363959e8d20b1db76` |
| Current `origin/main` inspected | `a73ee04f5dc146d19caa265c658cea98abfd152c` |
| Historical-import merge | `b629731ebd4f832c4cf11ce1a9d15685c841b11b` |

The fetched review tip was unchanged. Main advanced beyond the previously reported
`eb81f34` to include [PR #358](https://github.com/cschadewitz/Project_Orca/pull/358),
merged 2026-10-01; its contributor/issue guidance is retained. The review branch was
one commit ahead and thirteen behind inspected main. A real two-parent merge into
`docs/import-current-state-review` completed with **zero conflicts**, importing all
200 files byte-for-byte. The original branch was neither rewritten nor force-pushed.
This addendum and living-documentation edits form a separate follow-up commit.

## Evidence and scope

Classification means **still applicable**, **partly addressed**, **resolved**,
**superseded**, or **needs further verification**. “Resolved” for a documentation
finding means its living prose is corrected by this reconciliation, not that a runtime
failure was repaired. “Implemented” is a source conclusion unless a test result below
explicitly says otherwise. Issue state/labels/dependencies were read from GitHub on
2026-10-01; all #329–#357 were open. No issue metadata or milestones were changed.

The baseline implementation remains the source anchor for unchanged paths:
[reviewed tree](https://github.com/cschadewitz/Project_Orca/tree/09f32690ffca5d9c79f6d8702481f6efe30a4cf3).
All current-source links below were inspected in the
[exact main tree](https://github.com/cschadewitz/Project_Orca/tree/a73ee04f5dc146d19caa265c658cea98abfd152c).
The implementation delta since the baseline is principally
[075d2d0 / #315](https://github.com/cschadewitz/Project_Orca/commit/075d2d0):
custom validation and dotted fields. Later commits include the
[v0.6.0 release](https://github.com/cschadewitz/Project_Orca/commit/1465ccf), Windows
packaging isolation (#317), dependency/CI updates and contributor guidance.
These do not establish completion of the new capability backlog.

Selection and Plan modes were already present in
[75a4910 / #312](https://github.com/cschadewitz/Project_Orca/commit/75a4910).
Per-ask sidecar loading was already present in the
[v0.5.0 implementation](https://github.com/cschadewitz/Project_Orca/commit/39351bd).
Protocol 1.8 and update admission were already present in
[09f3269 / #311](https://github.com/cschadewitz/Project_Orca/commit/09f3269).
Those are corrections to stale summaries, not features introduced by this PR.

## Recommendation dispositions

Each row covers the full recommendation in the [original R01–R18 register](../roadmap/recommendations.md).
Related backlog links do not imply that an issue owns every acceptance criterion of a
historical recommendation. Where no exact owner exists, that gap is stated rather than
creating a duplicate or expanding another issue silently.

| ID | Disposition | Current evidence, remaining work and issue relationship |
| --- | --- | --- |
| R01 | Resolved for the requested documentation reconciliation | [Roadmap ledger](../../docs/ROADMAP.md), [protocol reference](../../packages/protocol/README.md) and [index](../../docs/README.md) now distinguish release/current/planned behavior, maintenance, Plan modes, selection and historical evidence. This is a reviewed ledger, not an automated drift detector. |
| R02 | Partly addressed | Ownership/activation/trust prose is narrowed below and in the living guides. [PlanService](../../packages/engine/src/plan/service.ts), [definitionFor](../../packages/engine/src/orchestrator.ts) and [policy fallback](../../packages/agents/src/permissions.ts) still have the boundaries observed at the baseline. Stronger guarantees await R04/R07/R08/R18; [#332](https://github.com/cschadewitz/Project_Orca/issues/332) covers configuration provenance and [#328](https://github.com/cschadewitz/Project_Orca/issues/328) caller authorization. |
| R03 | Partly addressed | Build/module, ID, contrast command and feed vocabulary are corrected in living guides. [bindOptions](../../packages/app/renderer/src/attention/card-model.ts) still numbers the first nine safe-then-destructive choices, including digit 1 for an all-destructive set. Design intent/H02 remains unresolved. A persistent documentation checker and PR-template field were not added; no dedicated owner was found. |
| R04 | Still applicable | [withPlan](../../packages/engine/src/plan/service.ts) is an instance-local queue; [document-store](../../packages/store/src/document-store.ts) locks each collection, while journal writes are separate. [#338](https://github.com/cschadewitz/Project_Orca/issues/338)/[#339](https://github.com/cschadewitz/Project_Orca/issues/339) are related future store contracts/recovery, not evidence of current semantic transactions. No exact standalone owner for the existing file-store operation gap was found. |
| R05 | Still applicable | [Plan-store listeners](../../packages/store/src/plan-store.ts), [event-store listeners](../../packages/store/src/event-store.ts), [subscriptions](../../packages/daemon/src/subscriptions.ts) and [client resume](../../packages/app/src/client/subscription.ts) retain process-local observation and distinct cursor domains. [#340](https://github.com/cschadewitz/Project_Orca/issues/340) is related operations/history work; a complete external-writer/gap contract is not shipped. |
| R06 | Still applicable | [Local provider](../../packages/engine/src/workspace/provider.ts) shares a checkout; [git-worktree provider](../../packages/engine/src/workspace/git-worktree.ts) offers isolation. Run/item leases do not establish checkout ownership. [#343](https://github.com/cschadewitz/Project_Orca/issues/343) is related future placement/fencing, not an exact local-checkout fix. V03 remains untested. |
| R07 | Still applicable | [loadEffectivePermissionPolicy](../../packages/agents/src/permissions.ts) skips unreadable overlays; [default policy](../../packages/core/src/model/agent.ts) can then allow a request previously restricted by an overlay. Per-ask rereading is implemented, conservative failure behavior is not. H01 needs verification and a policy decision; [#328](https://github.com/cschadewitz/Project_Orca/issues/328) secures daemon callers, not this ACP policy fallback. No dedicated owner found. |
| R08 | Partly addressed | [Workflow store](../../packages/store/src/workflow-store.ts) and [definitionFor](../../packages/engine/src/orchestrator.ts) preserve old versions, but matching live versions win. C01 remains valid; templates/config/plugins are not one immutable recipe. [#332](https://github.com/cschadewitz/Project_Orca/issues/332) plans effective provenance; [#180](https://github.com/cschadewitz/Project_Orca/issues/180) plans draft/publish semantics. Neither is shipped. |
| R09 | Needs further verification | [Program settlement](../../packages/engine/src/program/service.ts) and [daemon control](../../packages/daemon/src/control.ts) still have distinct entry paths. H03 is not a reproduced stale-Request defect. [#329](https://github.com/cschadewitz/Project_Orca/issues/329)/[#357](https://github.com/cschadewitz/Project_Orca/issues/357) are related submission/recovery work, not proof of entrypoint parity. |
| R10 | Still applicable | [Method assembly](../../packages/daemon/src/methods.ts), [bridge](../../packages/app/src/bridge.ts) and [preload](../../packages/app/src/preload/index.cts) retain parallel explicit tables. The reference is corrected but no descriptor generator was implemented. [#327](https://github.com/cschadewitz/Project_Orca/issues/327) adds another future client; no dedicated consolidation owner found. |
| R11 | Still applicable | [Plan feed](../../packages/app/renderer/src/plan/use-plan.ts), [Config feed](../../packages/app/renderer/src/config/use-config.ts) and [run feed](../../packages/app/renderer/src/runs/use-runs.ts) use distinct patch/invalidation/reconnect rules. Draft retention exists; a common complete convergence contract does not. [#340](https://github.com/cschadewitz/Project_Orca/issues/340) is related, not an exact existing-hook repair. |
| R12 | Still applicable | [Artifact index fold](../../packages/store/src/artifact-store.ts) and [plan snapshots](../../packages/engine/src/plan/service.ts) still require whole-history/collection work. [#338](https://github.com/cschadewitz/Project_Orca/issues/338), [#339](https://github.com/cschadewitz/Project_Orca/issues/339), [#341](https://github.com/cschadewitz/Project_Orca/issues/341) plan contracts, SQLite and measurement. No scale threshold or safe retention policy was established by this review. |
| R13 | Still applicable | [Orchestrator](../../packages/engine/src/orchestrator.ts), [PlanService](../../packages/engine/src/plan/service.ts), [CLI](../../packages/cli/src/commands/index.ts) and [Plan surface](../../packages/app/renderer/src/plan/plan-surface.tsx) remain concentrated coordinators. [#329](https://github.com/cschadewitz/Project_Orca/issues/329) is a related service boundary; broad extraction is not separately owned and should follow ownership decisions. |
| R14 | Partly addressed | #315 adds optional [executor validation](../../packages/engine/src/executors/types.ts), [core hook](../../packages/core/src/workflow/validate.ts), plugin-before-validation bootstrap, JEV validation and [dotted field lookup](../../packages/engine/src/executors/artifact-field.ts) (exact keys win). The opted-in validation gap is resolved. [#314](https://github.com/cschadewitz/Project_Orca/issues/314) separately owns builtin plan/program schemas. [Plugin API](../../packages/engine/src/plugin.ts) still lacks the proposed capability/version metadata; [risk prompt](../../templates/program/assess-risks.md) still promises Maintain effects. Template contracts, generic ACP options and production T3 interoperability are not closed by #315. [#297](https://github.com/cschadewitz/Project_Orca/issues/297)/[#337](https://github.com/cschadewitz/Project_Orca/issues/337) are related integration work. |
| R15 | Needs further verification | [Update coordination](../../packages/app/src/main/updates.ts), [packaging](../../packages/app/electron-builder.yml) and [deployment](../../tools/deploy/orca-release.py) remain implemented mechanisms, not installed-platform evidence. #317 isolates Windows packaging architectures; it does not prove signing, activation, rollback or every supported channel. No dedicated assurance owner found; V06 remains open. |
| R16 | Needs further verification | [H01–H03/V01–V08](../roadmap/future-verification.md) retain their scope. Documentation/checksum checks and ordinary CI cannot substitute for crash, independent-writer, live-adapter, scale or installed-update experiments. No new runtime probe was commissioned by this documentation import. |
| R17 | Still applicable | [Logger](../../packages/core/src/util/logger.ts), coded errors and separate [plan journal](../../packages/store/src/plan-store.ts) exist; no common operation/revision correlation boundary was added. [#331](https://github.com/cschadewitz/Project_Orca/issues/331), [#340](https://github.com/cschadewitz/Project_Orca/issues/340), [#345](https://github.com/cschadewitz/Project_Orca/issues/345) are related future admission/operations/usage work, not a shipped diagnostic contract. |
| R18 | Still applicable | [Server dispatch/bind](../../packages/daemon/src/server.ts) defaults to loopback but has no general caller authentication; [raw config](../../packages/daemon/src/config-model.ts) is unredacted. [Maintenance](../../packages/daemon/src/maintenance.ts) coordinates admission only. [#328](https://github.com/cschadewitz/Project_Orca/issues/328) owns general HTTP/WebSocket authentication/authorization and remains open. |

## Documentation finding dispositions

These refer to the unchanged [D01–D17 register](../comparison/differences.md).

| ID | Disposition | Reconciliation |
| --- | --- | --- |
| D01 | Resolved | README/protocol now say 1.8, document maintenance and optional process identity, retain 1.7 introduction history and identify the additive v0.6.0 fields. [Version constant](../../packages/protocol/src/version.ts) and #311 are the source. |
| D02 | Resolved | Selection, all five Plan modes and preference-gated notification tiers are recorded as implemented. [Mode registry](../../packages/app/renderer/src/plan/plan-surface.tsx), [ACP facade](../../packages/integrations/src/acp-facade/orca-acp-agent.ts) and [notifications](../../packages/app/src/main/alerts.ts) support that classification. |
| D03 | Resolved as prose; stronger provenance still open | Protocol/data-model now describe conditional version lookup. The v0.5.0 editor account is labelled historical/superseded. C01 remains intact; [definitionFor](../../packages/engine/src/orchestrator.ts) has not changed that contract. |
| D04 | Resolved as stale debt | #102/#197/#123/#104 mechanisms moved into the implemented ledger, backed by artifact log locking, lease fencing, released-item repair and PlanService's automatic decision guard. Race/crash coverage is still R16. |
| D05 | Partly addressed | ADR 0009's universal conservative-fallback claim is corrected. Runtime fallback and its source comments remain unchanged; R07/H01 is still open. |
| D06 | Resolved as guidance | AGENTS/design guidance distinguishes run patches, object resolution, scoped invalidation reads and reconnect refresh; no periodic polling is prescribed. Full convergence remains R05/R11. |
| D07 | Partly addressed | Planning/protocol now limit queues to one service instance and distinguish file locks, projection repair and separate journal writes. Cross-process semantic atomicity/recovery remains R04/V01. |
| D08 | Resolved | Main config at bootstrap, sidecars per ask and app-owned preferences have distinct lifetimes. #332 activation and #237 live callback/session continuity remain future, neither is satisfied by #271. |
| D09 | Resolved | Architecture/ADR 0006 qualify live evaluation with sticky satisfied/waived states, matching [evaluateDependency](../../packages/core/src/plan/schedule.ts). No scheduler behavior changes. |
| D10 | Resolved | Binding design rule now invokes the existing Vitest contrast suite. |
| D11 | Resolved | Architecture names the concrete ACP default and injected factory seam in [Orchestrator](../../packages/engine/src/orchestrator.ts). |
| D12 | Resolved | Development describes main ESM, preload CJS, renderer Vite, existing packaging and Python deployment tooling. |
| D13 | Still applicable | The executable [risk prompt](../../templates/program/assess-risks.md) is preserved; the living roadmap explicitly disclaims automatic reopening/Request creation. Changing a shipped agent prompt is deferred from this documentation-only task. |
| D14 | Resolved | Data-model guidance distinguishes temporal ULIDs and deterministic [keyed IDs](../../packages/core/src/ids.ts), requiring opaque client handling. |
| D15 | Partly addressed | Workflow authoring now reports the actual number-key ordering. Stronger design intent and all-destructive reachability/interaction remain H02; no UI behavior was changed. |
| D16 | Partly addressed | Protocol trust wording no longer equates network access with OS file access. General enforcement remains #328; no hostile-access experiment was run. |
| D17 | Resolved | Index links Updating, protocol and the historical review; fragile ADR count removed. |

## Ownership and activation boundaries

| Operation / owner | Serialization and durable record | Recovery / limitation |
| --- | --- | --- |
| Run interpreter / run lease | Heartbeat lease plus ownership-fenced event appends | Resume from log after lapse; this is run ownership, not caller authorization or shared-checkout exclusion. |
| Work-item dispatch / claim store | Atomic claim per item; durable claim and child events | Explicit release and released-item repair; a claim is not a run lease or workspace lock. |
| Document/log stores | File locks serialize collection RMW or log append; atomic document replacement | Protects individual persistence operations, not a transaction over multiple files. Lock namespace/liveness remains #103. |
| PlanService | In-memory per-plan queue; documents and journal are separate writes | Dispatch replay repairs projections on resume; independent service instances and crash cut points need V01. |
| Daemon subscriptions / app feeds | Instance-local listeners, per-run replay cursor, separate store-wide invalidations | External writes can require a read; a quiet UI is not proof the store is unchanged. V04 covers gaps. |
| Config bootstrap / agent session | Main YAML loaded at startup; sidecars loaded per permission ask | Saved main config is not active config (#332). Sidecar reread does not restore a dead callback or keep a parked turn alive (#237); malformed overlays are skipped. |
| Workflow lookup / template registry | Run records version, store keeps definitions; matching live version wins | Older stored versions can be served; legacy fallback and live templates limit immutable provenance (#332/R08). |
| Daemon access / supervisor | Default loopback, configurable bind; maintenance token gates admission | No general principal/authorization boundary yet (#328). Raw config can contain secrets. |

## Validation and remaining uncertainty

The frozen 186-file checksum manifest is the preservation authority. All imported files
other than the permitted README entry-point annotation remain byte-identical to the review
tip; the new addendum is outside the frozen manifest. Original JSON validation reports
remain dated historical results, not rewritten reports of this integration.

Local preservation checks passed: all 186 hashes match and only the permitted README
annotation differs among the 200 imported files. The original validator passed against
the original implementation tree (3,803 Markdown links, 55 architecture views, 55 SVGs).
Changed-document local targets resolve, and the recorded hard-dependency graph is acyclic
across 44 reachable issues. Formatting, lint, typecheck, generated-token and build checks
passed. The draft PR records the final test/demo and CI outcomes for its head. The original
validator's exact source-line assertions target the old implementation; run it against
that checkout to validate the original evidence, not against moved current-source lines.
No build/check result certifies the runtime hypotheses above. Live SSH/ACP/JEV providers,
installed updates, signing, process-interleaving probes and scale measurements remain
unverified by this reconciliation.
