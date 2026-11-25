# 25 October 2026 integration checkpoint

Audited remote main and local source:
[`c693e0456a7d28dc1600afab1c9f9c863f2f93b6`](https://github.com/cschadewitz/Project_Orca/commit/c693e0456a7d28dc1600afab1c9f9c863f2f93b6).
This bounded reconciliation updates the living [README](../../README.md#status),
[index](../README.md), [capability ledger](../ROADMAP.md) and current Mac C15 handoff.
The [7 October review](2026-10-07-living-docs.md), frozen `Current_State/` and failed
historical receipts retain their original pins and conclusions.

## Implemented source and issue state

| Current finding | Verified evidence | Acceptance boundary |
| --- | --- | --- |
| Structured Config, mounted guided Request/direct launch and template/pack authoring are implemented; #333/#334/#355 are closed | Merged [#607](https://github.com/cschadewitz/Project_Orca/pull/607), [Windows acceptance](../implementation/m21-windows-acceptance.md), [first run](../implementation/m21-windows-first-run.md) | #605/#606 heads were integrated through #607; those PRs are not independently merged. Source-built Windows receipts do not prove signed arm64, real-agent/manual accessibility or physical first run. |
| Six app surfaces include Workflows: owned persistent drafts, visual editing, validation and reviewed publish | Merged [#610](https://github.com/cschadewitz/Project_Orca/pull/610), [as-built design](../design/70-workflow-editing.md), [daemon methods](../../packages/daemon/src/workflow-draft-methods.ts), [draft service](../../packages/daemon/src/workflow-drafts.ts) | #180/#181/#182 remain **open**. Their older missing-implementation wording conflicts with source and needs separate issue/acceptance reconciliation; this audit closes none. Dry run #183 remains future work. |
| Setup, saved-config binding, same-boot ownership recovery and explicit previous-boot settlement are implemented | [Recovery](../implementation/first-run-same-boot-recovery.md), merged [#640 readiness reconciliation](https://github.com/cschadewitz/Project_Orca/pull/640) | Surviving/foreign writers and legacy uncertainty remain refused. Ownership settlement does not complete work or establish updater quiescence. |
| Delivery validation, native provider composition and coherent update/recovery are implemented | [Delivery adapters](../preparation/native-mac-delivery/production-adapters.md), [held app](../implementation/app-held-nonmac-verification.md), [native providers](../implementation/mac-native-provider-composition.md), merged #607 | Production activation remains held in [app main](../../packages/app/src/main/index.ts). Catalog/invitation, freshness/revocation, OS/version/publisher/native policy and independently accepted installed-manifest inputs remain owner choices/evidence. Bundle identity decisions are settled. |
| Diagnostics recovery, closed producers and local Save/export are implemented | Merged #470/#607; [initializer](../../packages/app/src/main/diagnostics/initialize.ts), [C15 run 5](../preparation/crash-recovery/windows-c15-readiness-run5.md), merged [#663](https://github.com/cschadewitz/Project_Orca/pull/663) | Production capture remains disabled. Run 5 passes hosted synthetic Windows x64 failure/stall memory checks at its pinned harness/product, not current-main execution, renderer-combined, signed/installed Mac or physical acceptance. Managed measurements: 15,319,656 / 19,596,119 bytes; controlled binary: 2,490,368 bytes. Earlier failures remain historical. |
| Generic actual-Cal #393 and agreed authentication/retry #328/#331 are closed | Fresh issue states, #607 reconciliation, [MCP acceptance](../mcp-operator-production-acceptance.md) | #327/#392 remain open handoff owners. #594 still requires exact-command and transferred live permission-callback lifetime evidence; generic durable-gate/restart results do not clear it. |
| Source ACP permission kinds are preserved in non-live forwarding | Merged [#674](https://github.com/cschadewitz/Project_Orca/pull/674), 184 focused passes reported at its head | This repairs forwarding semantics, not exact-command authority or native persistence. Issue #662 remains open at this audit. |

Exact-command #594 remains **unsupported and mandatory before Mac beta**. Merged
[#641](https://github.com/cschadewitz/Project_Orca/pull/641),
[#676](https://github.com/cschadewitz/Project_Orca/pull/676) and
[#678](https://github.com/cschadewitz/Project_Orca/pull/678) provide an audit, draft
versioned evidence contract and private offline dispatch prototype. They do not
supply a maintained released native/bridge pair, installed correspondence, native
completeness/environment semantics or separately scoped actual-Cal proof. Cal owns
coordination; maintained upstream implementation/release and public outreach remain
pending, with additional product/private-reviewer choices retained by Casey.

M22 pre-Mac preparation and M25 live acceptance remain distinct. The
[readiness ledger](../preparation/native-mac-beta-readiness/readiness.md) and
[shared candidate receipt](../preparation/native-mac-beta-readiness/acceptance-runbook.md#shared-candidate-bound-physical-mac-receipt)
retain signed private delivery/installed bundled execution #602, exact signed
N/N+1 and coherent restore #603, native diagnostics #604 and unassisted #390 as
unpassed. C15's narrow pass does not resolve renderer-combined memory/Layout,
native consent/isolation, continuous allocation or physical interruption. #597
defers only numeric 4 ms; the viewer is removed scope. #598/#600/#601 keep their
separate deferrals. JEV remains excluded from supported beta setup.

## Integration checks and exclusions

[Full Node 24 CI 40234250911](https://github.com/cschadewitz/Project_Orca/actions/runs/40234250911)
passed on audited main. Inspected checkout and job logs confirm frozen install,
typechecks, design freshness, format/lint, build, both mandatory retry cases,
coverage and compiled smoke. The full Vitest report is **507 files / 7,904 tests
passed**, with **5 files / 36 tests skipped and 1 todo**; those are not passes.

[App workflow 40234318429](https://github.com/cschadewitz/Project_Orca/actions/runs/40234318429)
also passed: Linux Electron smoke (**28 tests**), Linux/macOS/Windows type proof,
and the selected macOS/Windows encrypted-intent restart and revision-workflow
projects. Linux smoke checkout was verified at audited main. Hosted source-built
checks do not establish signed installed Apple Silicon delivery, Keychain/TCC
upgrade continuity or an unassisted physical journey. No new workflow was dispatched.

Recent merged fixes include [#646 Attention focus](https://github.com/cschadewitz/Project_Orca/pull/646)
and [#686 pointer wires](https://github.com/cschadewitz/Project_Orca/pull/686).
#646/#674/#686 had no fragment or `no-changelog` label at the audit; this patch adds
three small Unreleased fragments. `CHANGELOG.md`, all previous fragments and root
**0.6.0** remain unchanged intentionally; no release is prepared.

[#689](https://github.com/cschadewitz/Project_Orca/pull/689) and
[#690](https://github.com/cschadewitz/Project_Orca/pull/690) are **open drafts**, not
merged fixes at this checkpoint. This is a source/docs audit, not certification of
the whole workboard or live site. Site/workboard reconciliation has separate
ownership. No deployment, release, signing, activation, access change or outreach
is performed by this patch.
