# Living documentation reconciliation — 7 October 2026

## Pin and review history

Inspected main: **`dcccd2bb849ae26c7fe0fb202431f11a6ab909c1`**, fetched from origin
in the saved cloud workspace. Its latest commit is merged
[#496](https://github.com/cschadewitz/Project_Orca/pull/496), committed at
2026-10-07 23:14:20 UTC. Initial source inspection used `fff65ed1ff59e06b012369ec6e2ca3c8f07426fc`
(merged #514); final refresh added the parent-merged #438/#439/#440/#496 packets
and their supporting preparation tooling without runtime/manifest/lock/workflow changes. This review pins source; it does not identify the running
agent-01 binary or certify a new CI/native result. The cloud shell and Git reads
worked. Direct `gh` API reads returned `Forbidden`; the authorized GitHub connector
supplied PR/issue evidence instead. No environment switch or host job was needed.

The last broad reconciliation found is
[#359](https://github.com/cschadewitz/Project_Orca/pull/359), merged on
**2026-10-01 11:11:32 UTC** as `1824dfb3d9ffa19440c0c1f7bc1b657fb8273d83`.
It imported the 29 September historical review and reconciled living README,
roadmap, planning, protocol, navigation and contributor guidance against `a73ee04`.
It classified 17 documentation findings and 18 recommendations and retained the
186-file frozen baseline. Its 200 imported files and validator's 3,803 links are
historical-review artifacts/validation, not proof that every living repository doc
was read. Current main has 240 commits after that merge, including substantial
runtime/clients/operator changes.

Later scoped reconciliations include runtime integration #400 and operator/security
#465. The 7 October pass over #438/#439/#440/#496 covered **15 owned Markdown docs
and 96 reported links**. Their exact reviewed heads are below; they merged during this audit and remain
preparation evidence, not an equivalent broad living-repository pass or runtime acceptance. The recent PR inventory and
main's documentation history revealed no newer equivalent broad owner/deliverable.
That finding is bounded by the inspected inventory, not a claim about private work.

## Independent review corrections — 7 October 2026

The [independent review of the original draft](https://github.com/cschadewitz/Project_Orca/pull/532#issuecomment-6048925223)
requested six bounded corrections at `1645174c2d9f26f0ab47ff90ae9ba17ec77a2127`.
The source citations below pin that reviewed head; their files are byte-identical
on fetched main `6abcdbaa72f26972adfc1ce6f9ef03e0232b47a9`. Main's intervening
daemon close-settlement change does not change these contracts. This addendum
does not replace the original `dcccd2b` audit/census or certify newer runtime evidence.

| Finding | Corrected current reference | Exact implementation evidence at reviewed head |
| --- | --- | --- |
| Sandbox prerequisite | Development now requires a sandbox-preserving Linux environment or a reported prerequisite blocker. | [App smoke prerequisite check, lines 105–115](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/.github/workflows/app-smoke.yml#L105-L115) |
| Granular authorization | Protocol control/agent sections, Architecture and Planning distinguish discovery from operation grants; claim release has its own permission. | [Operation matrix, lines 114–150](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/daemon/src/auth/operations.ts#L114-L150); [linked-document guard, lines 389–401](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/daemon/src/auth/guard.ts#L389-L401) |
| Request admission and association reads | Protocol documents the implemented conditional service separately from direct launch and validates existing associations. | [Conditional registration, lines 871–899](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/daemon/src/methods.ts#L871-L899); [serve model, lines 839–850](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/cli/src/commands/index.ts#L839-L850); [serve context, lines 933–936](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/cli/src/commands/index.ts#L933-L936); [association validation, lines 361–367](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/engine/src/orchestrator.ts#L361-L367); [provisioning reads, lines 427–428](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/engine/src/orchestrator.ts#L427-L428); [Request operation guard, lines 164–168](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/daemon/src/auth/guard.ts#L164-L168) |
| Live answers and cursor exception | Protocol requires the exact live target, rejects live no-resume, and joins Architecture in documenting eleven notifications. Cursor/replay guidance excludes ephemeral invalidation and plan sequence numbers. | [Answer schema, lines 46–48](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/protocol/src/control.ts#L46-L48); [live delivery guard, lines 358–375](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/daemon/src/control.ts#L358-L375); [notification inventory, lines 66–78](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/protocol/src/subscriptions.ts#L66-L78); [ephemeral target, lines 209–222](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/protocol/src/subscriptions.ts#L209-L222) |
| Config activation echo | Protocol limits duplicate saved-document suppression and requires authoritative generation/status comparison for activation even at equal hashes. | [Activation event, lines 138–146](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/packages/daemon/src/config-model.ts#L138-L146) |
| CI classification | Both Development explanations classify `.js/.mjs/.cjs/.jsx` files under docs and prompt templates as code. | [Classifier, lines 34–52](https://github.com/cschadewitz/Project_Orca/blob/1645174c2d9f26f0ab47ff90ae9ba17ec77a2127/.github/workflows/ci.yml#L34-L52) |

A consistency sweep covered the 18 owned pages for these current-reference claims,
including adjacent input-card, discovery and cursor explanations. Roadmap wording
for #355 now preserves its existing scope and recorded dependencies without imposing
new milestone sequencing. The cleared audit/deployment/native boundaries and owner
proposals below are retained. This correction changes six already-owned Markdown
pages; no runtime, manifests, workflows, frozen baseline or separately owned path changes.

## Coverage and reading method

The [complete Markdown census](2026-10-07-doc-inventory.md) lists tracked main files,
their documentation class and the review treatment. The broad check covers relative
files/fragments throughout that census. Source comparison concentrates on living
entry points and the changed mechanisms, with dated feature, reference-acceptance,
workflow, package, release and preparation evidence read alongside them. This is
not a new line-by-line certification of every historical narrative, prompt, fixture
or frozen source-line assertion. Absence of a prose edit is not runtime acceptance.

| Area | Source/test/release evidence inspected | Reconciliation / boundary |
| --- | --- | --- |
| Navigation and capability status | [Root manifest](../../package.json), [protocol version](../../packages/protocol/src/version.ts), [changelog](../../CHANGELOG.md), pending fragments; #359/#400/#465/#514 | README/index/roadmap now distinguish 0.6.0, protocol 2.0 and current source from deployed/native readiness. |
| Engine, artifacts and workflow identity | [Orchestrator](../../packages/engine/src/orchestrator.ts), [workflow pin tests](../../packages/engine/test/workflow-pinning.test.ts), [typed inputs](../workflow-inputs.md), [protected storage](../protected-execution-storage.md) | Recorded definitions take precedence, same-version collisions refuse new launches; artifacts are collected durably, not automatically Git-committed. Legacy and protected-generation missing-data guards differ. |
| Planning and persistence | [PlanService](../../packages/engine/src/plan/service.ts), [scheduler](../../packages/core/src/plan/schedule.ts), [five Plan modes](../../packages/app/renderer/src/plan/plan-surface.tsx), [persistence baseline](../performance/persistence-baseline/README.md), #487/#524 | Unchanged artifact signals skip reconciliation. Bounded measurements are available; whole-plan wake cost, instance-local queues and non-atomic document/journal changes remain limits. |
| Authentication, clients and config | [Operation inventory](../../packages/daemon/src/auth/operations.ts), [config model](../../packages/daemon/src/config-model.ts), [generation contract](../configuration-generations.md), [connections](../daemon-connection.md), [HTTP tests](../../packages/daemon/test/security-http.test.ts), [WS tests](../../packages/daemon/test/security-socket.test.ts) | Removed “no general authentication” and “all config requires restart.” Raw editor bytes require config.read; apply is separate from save, reloadability bounded, authority current. |
| Admission, permission and revision lifetimes | [Submission](../request-submission.md), [retry](../admission-retry.md), [live input](../live-input-continuity.md), [revision](../revision-input.md), [continuation control](../../packages/daemon/src/continuation-admission.ts), #466/#468/#500/#524 | Implemented foundations are not still blanket planned work. Acceptance, attachment, durable/live answer and confirmed delivery are distinct. Residual #331/#393 matrices remain. |
| ACP, inbound/outbound MCP and delegation | [ACP facade](../../packages/integrations/src/acp-facade/orca-acp-agent.ts), [MCP operator](../mcp-operator.md), [production matrix](../mcp-operator-production-acceptance.md), [ACP preparation](../preparation/acp-command-conformance/README.md), #327/#393/#502 | Actual discovery and historical configured-worker results are real within their scopes. They do not establish autonomous one-shot approval delivery, all actual-Cal paths or generic downstream capability verification. |
| Workspace/configuration/launch experience | [Root isolation](../root-worktree-isolation.md), [first-job experience](../preparation/cal-first-job-experience/README.md), [sample](../../examples/beta-first-job/README.md), [prepared roots](../preparation/trusted-prepared-roots/README.md), #440 | Linux-only owned roots, offline copier/sample and accepted experience specs are foundations. Structured collection forms/guided launch/native checkout/Finder bindings remain owner work. #486 is optional/inactive. |
| Daemon/app updates and packaging | [Update driver](../../packages/app/src/main/update-driver.ts), [maintenance](../../packages/daemon/src/maintenance.ts), [builder config](../../packages/app/electron-builder.yml), [Desktop workflow](../../.github/workflows/desktop.yml), [updating](../UPDATING.md), [releasing](../RELEASING.md), #439/#385–#390 | Windows NSIS/managed Debian mechanisms exist; main has no Mac driver, signing is disabled. Candidate/native old-to-new Keychain, safe idle/recovery and physical acceptance remain gates. Owner-path proposals below avoid overlapping edits. |
| CI and check effects | [CI](../../.github/workflows/ci.yml), [App smoke](../../.github/workflows/app-smoke.yml), [release workflow](../../.github/workflows/release-publish.yml), [shadow selection](../ci-shadow-selection.md), #525/#520/#517/#513 | Standard hosted Ubuntu CI route is current; serial Node22/24/full-check authority retained. Manual/reusable native/package workflows have different runners/gates. No fresh CI verdict inferred. |
| Resources and maintenance | [Resource contract](../host-resources.md), [access proposal](../host-resource-access-policy.md), [maintenance preparation](../maintenance-mcp.md), #495/#503/#504 | Source/fixtures/seams are merged; normal deployed CLI does not mount collector/summary/grant. No CPU/RAM/load safety conclusion follows from run counts or synthetic preview. |
| Design and historical evidence | [Design rules](../design/RULES.md), [editor historical addendum](../design/70-workflow-editing.md#as-built-v050--historical), [settled Plan choice](../design/80-dependency-graph-options.md#as-built-v050), [historical real-agent record](../REAL-AGENT-TEST.md), [frozen review](../../Current_State/README.md) | Settled product/design choices and historical recipes retained. Added current forward reading without altering archived snapshots, commands, source pins or checksums. |

## Deployment and actual-client evidence

The [#496 cutover evidence](https://github.com/cschadewitz/Project_Orca/pull/496#issuecomment-5986160454)
records historical daemon source `49efcc7236ac127c952bb1f7a50fc6ef72f7df84` and
MCP transport source `3702da5b38dc449280c2837366615de741e9c45c`, enabled/running
units, `Linger=yes`, one configured-worker smoke and authenticated post-SSH read.
The old no-install/foreground-only descriptions are superseded for that scope.
This does not certify present health, a standalone transient probe, reboot/network
recovery or the whole operator matrix. The credential in that historical packet
expired on 5 October; it is not proof of a current authentication failure.

[#393's 7 October handoff](https://github.com/cschadewitz/Project_Orca/issues/393#issuecomment-6048532488)
reports fresh read-only delegated connector discovery at **22:55:01.102 UTC**:
ORCA 0.6.0/protocol 2.0, principal `cal-codex-work`, owned runs/workflow
`cal-codex-work`, six grants (`runs.read`, `artifacts.read`, `workflows.read`,
`runs.start`, `runs.control`, `inputs.answer`). That delegated observation is
separate from parent actual-Cal acceptance and does not identify the deployed SHA.
Discovery omits Request/plan/config/host-resource operations for that scope.
Those cases remain blocked rather than borrowing owner credentials. Fresh discovery,
not a hard-coded historical boot, is the target identity source.

No fresh identity-bound CPU interval, available/effective-limit RAM and load
measurement was available in that handoff. Normal CLI does not mount the telemetry
source; maintenance remains inactive. The user's CPU/RAM/load prerequisite therefore
continues to block new homelab work. This audit used saved cloud only.

[#502's final disposition](https://github.com/cschadewitz/Project_Orca/issues/502#issuecomment-6030018135)
completes its bounded inactive-v4 preparation and records separately authorized later
work. The original ORCA coding attempt remains terminal **failed**. The owner-agent
correction/publication and scoped review are useful deliverables, not proof that the
one-shot approval route delivered autonomously. #505/#506 and recovery/tracker owners
retain that broader reliable-delegation work.

## Source, review, CI and native evidence

- **Source inspected:** current main at the exact pin above and relevant test
  definitions establish what is implemented and refused. Tests were not rerun to
  manufacture a new runtime verdict for prose changes.
- **Review evidence:** #438/#439/#440/#496's latest scoped reviews and validation
  concern their exact preparation heads. Those packets are now merged; their
  review does not certify implementation/native acceptance.
- **CI evidence:** #520 reports terminal green source CI553 on its recorded candidate,
  while consumer-local ZIP materialization/comparison remains blocked and live
  default-branch consumer acceptance remains separate. This audit read the evidence;
  it did not independently materialize ZIPs, poll, dispatch or rerun CI.
- **Dependency evidence:** #514 is in pinned main. #517 retains the reported A11
  backing-WebSocket timeout at `ca3974305c053b45703fd57b8587bab9ecab06d7` despite
  isolated passes; cause is not established. #513 at
  `fc718aefe88d64c6e9ffeeaa668fcc961ebd3342` retains actual Electron/native/packaging
  checks. A source/CLI pass does not certify native runtime behavior.
- **Native evidence:** existing dated App smoke checkpoints prove only their tested
  source builds/scenarios. Fixture-only identity/signing stubs and a Node bundle probe
  do not certify the downloaded signed arm64 candidate, Gatekeeper/TCC, old-to-new
  Keychain access or physical beta journey. #385–#390 remain distinct owners.

## Owned paths and routed proposals

This slice owns living README/navigation/architecture/development/roadmap,
contributor/integration/extension/planning prose and protocol README corrections,
plus top-of-page current-reading annotations on generation/submission/connection/
live-input/revision feature records. It changes Markdown only. The inventory below
identifies the exact paths; no runtime, manifest, lockfile, workflow, generated
contract, collaborator/access setting or release change accompanies it.

The following are proposed prose additions for parent routing to existing owners,
not competing edits or implementation assignments. Preserve dated tables/commands.

| Owner / exact path | Proposed bounded patch | Evidence / remaining gate |
| --- | --- | --- |
| #327/#393 owner: `docs/runtime-operator-integration.md`, `docs/mcp-operator.md`, `docs/mcp-operator-production-acceptance.md` | Add a dated forward note to the existing 4 October evidence map: “7 October delegated discovery succeeded for six-grant owned cal-codex-work scope; deployed source SHA remains unverified. Request/plan/config/resource cases are unavailable in that scope. Historical credential expiry is not a current access verdict.” Link the new #393 handoff and keep parent actual-Cal acceptance separate. | #393 comment 6048532488; keep reference-client versus actual-client/disruption/gate/confirmation evidence distinct. |
| #387 updater owner: `docs/UPDATING.md` | Clarify the opening version wording: “Maintenance was introduced in protocol 1.8; current main is protocol 2.0/operator-journals-v4. Windows and managed Debian mechanisms exist; macOS driver is unavailable on this pin.” Forward-link #439's current approved-update contract rather than reinterpret Windows controls as Mac support. | Actual driver returns unavailable off packaged Windows; #439 retains approved specific-update consent and native N-to-N+1/recovery gates. |
| Native owner: `docs/RELEASING.md` (artifacts runner paragraph) | Replace the inaccurate current `ubuntu-latest` packaging runner description with the actual `desktop.yml` Linux `[self-hosted, linux, x64, homelab]`, `macos-latest`, `windows-latest` matrix. Distinguish it from CI's `ubuntu-24.04` route and state the fresh homelab CPU/RAM/load prerequisite before dispatch. | Main #525 changed CI routing only; no new packaging/native workflow run is authorized by prose. |
| Native owner: `docs/preparation/native-mac-delivery/current-state.md`, `docs/preparation/native-mac-testing/implementation-handoff.md` | Add a dated forward link from the pinned 2 October audit to current identity/probe/fixture foundations and #385–#390 gaps. Preserve original old-identity/source tables as the earlier audit; do not rewrite them to pretend native acceptance occurred. | #456/#445/#457/#442/#467 merged; main still has signing/notarization disabled and no Mac updater. |
| Configuration owner: `docs/preparation/cal-first-job-experience/capability-map.md` | Add a dated forward link to #440's reconciled inventory/remaining metadata and guided-launch bindings. Keep C01–C12 exact-baseline rows historical, including older direct override/shared-root observations. | #440 at 4aa142e8 already reconciles #415/#434/#462/#505 foundations; it is not an accepted runtime/interface freeze. |

The reconciled preparation paths are untouched. The following reviewed heads are
now contained in main, with their original historical source/evidence boundaries:

| PR | Exact head | Owned directory / delta |
| --- | --- | --- |
| [#438](https://github.com/cschadewitz/Project_Orca/pull/438) | `03e17917a5a3eeac0134c6b3c8a8b3bdf37ef27e` | `docs/preparation/manual-diagnostics-implementation/`, four docs |
| [#439](https://github.com/cschadewitz/Project_Orca/pull/439) | `39d4cf75b9e46dd267ccf0ae044f29f220fe667d` | `docs/preparation/beta-update-support/`, four docs |
| [#440](https://github.com/cschadewitz/Project_Orca/pull/440) | `4aa142e870c9cedcd4d26108d975c0f7c7f4619a` | `docs/preparation/configuration-launch-implementation/`, five docs |
| [#496](https://github.com/cschadewitz/Project_Orca/pull/496) | `c7826b637c01d64aafac4ac168135c611111ecdc` | `docs/preparation/private-mcp-access/agent01-owner-staging/{README.md,hardening-probe.md}`, two-doc reconciliation; historical tooling unchanged |

## Validation record

Original draft scoped checks passed on **211 Markdown files** (209 baseline plus two review
pages): **983 relative targets / 27 Markdown fragments**, zero unresolved targets.
All 18 changed/new pages passed UTF-8/LF/final newline/whitespace/fence checks.
The 19 documented script definitions and 10 CLI command/flag handlers were inspected
without invoking runtime commands. Historical real-agent fenced command blocks are
byte-identical. Validation checks relative file/Markdown fragments outside code fences,
UTF-8/LF/final newline/trailing whitespace/fences, script/CLI flag definitions,
source/protocol/epoch consistency, changed-path scope and all **186** frozen
`Current_State/BASELINE-MANIFEST.sha256` entries. Markdown is deliberately excluded
by `.prettierignore`; scoped Prettier alone is not prose validation. Git whitespace
and scope checks accompany the independent text/link checks.

After the independent-review corrections, the same corpus passes **1,005 relative
targets / 27 Markdown fragments**, with zero unresolved targets or text-format
errors on all 18 changed pages. All **15 immutable source ranges in 11 files** above
resolve within their pinned blobs, and those source files match fetched main byte
for byte. All **186/186** frozen hashes and historical real-agent fenced blocks still
match. The correction delta is six Markdown pages within the original 18 owned paths;
whitespace and scoped Prettier checks pass (Markdown remains ignored by Prettier).
The owned-page consistency sweep finds none of the six reviewed stale reference
claims. These are documentation/source checks, not runtime tests or new CI evidence.

External PR/issue facts above were read through the authorized connector; repository
paths and immutable preparation heads were checked against local Git objects.
This is not an external-site availability crawl. No destructive/live/provider/host
command was executed, no runtime/broad suite repeated, and no CI/release/distribution
step performed. Parent owns independent exact-head review, CI disposition and merge;
this task stops at the draft-docs handoff.
