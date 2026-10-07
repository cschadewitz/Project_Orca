# Documentation census — 7 October 2026

Main pin: `dcccd2bb849ae26c7fe0fb202431f11a6ab909c1`.
This inventory uses tracked Markdown outside `Current_State/`: **209 files**,
including executable prompt templates and release records. It is a documentation
classification and link-check coverage record, not a claim that all 209 files had
a line-by-line source review. The 186 frozen historical checksum entries are
validated separately; historical diagrams/JSON/patches are not re-generated.
See the [review evidence map](2026-10-07-living-docs.md) for source/test/issue
comparisons and separately owned proposals. The two new review pages are additions
to this baseline census and are also included in final link/text validation.

Treatment distinguishes living prose corrected here, targeted source/evidence
comparison, and corpus-level classification/link checks. “Retained” does not
certify implementation or accept an old candidate. Dated preparation can describe
an earlier source truth; current navigation/annotations point forward without
rewriting that history. #438/#439/#440/#496 merged during this audit; their 15 Markdown files now join
this main census. Their immutable reviewed heads and owner paths remain unchanged.

## Treatment counts

| Treatment | Files |
| --- | --- |
| Dated preparation/research/measurement; classified, link scan | 83 |
| Executable prompt; census/link scan only, untouched | 13 |
| Historical/checkpoint record; classified, link scan | 12 |
| Living prose reconciled / current-reading annotation | 16 |
| Release record/fragment; retained, link scan | 27 |
| Settled decision/design record; classified, link scan | 17 |
| Supporting developer/package reference; census/link scan | 9 |
| Targeted source/evidence comparison; retained or owner-routed | 32 |

## Exact baseline paths

| Path | Treatment |
| --- | --- |
| [.github/ISSUE_TEMPLATE/feature.md](../../.github/ISSUE_TEMPLATE/feature.md) | Supporting developer/package reference; census/link scan |
| [.github/pull_request_template.md](../../.github/pull_request_template.md) | Supporting developer/package reference; census/link scan |
| [AGENTS.md](../../AGENTS.md) | Supporting developer/package reference; census/link scan |
| [CHANGELOG.md](../../CHANGELOG.md) | Release record/fragment; retained, link scan |
| [CLAUDE.md](../../CLAUDE.md) | Supporting developer/package reference; census/link scan |
| [CONTRIBUTING.md](../../CONTRIBUTING.md) | Living prose reconciled / current-reading annotation |
| [README.md](../../README.md) | Living prose reconciled / current-reading annotation |
| [changelog.d/0-approved-bundle-id.changed.md](../../changelog.d/0-approved-bundle-id.changed.md) | Release record/fragment; retained, link scan |
| [changelog.d/105-artifact-signal-reconciliation.fixed.md](../../changelog.d/105-artifact-signal-reconciliation.fixed.md) | Release record/fragment; retained, link scan |
| [changelog.d/237-live-permission-continuity.added.md](../../changelog.d/237-live-permission-continuity.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/314-328-330-runtime-integration.added.md](../../changelog.d/314-328-330-runtime-integration.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/314-builtin-node-validation.fixed.md](../../changelog.d/314-builtin-node-validation.fixed.md) | Release record/fragment; retained, link scan |
| [changelog.d/327-mcp-operator.added.md](../../changelog.d/327-mcp-operator.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/327-operator-continuation.added.md](../../changelog.d/327-operator-continuation.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/328-daemon-auth.added.md](../../changelog.d/328-daemon-auth.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/328-daemon-auth.changed.md](../../changelog.d/328-daemon-auth.changed.md) | Release record/fragment; retained, link scan |
| [changelog.d/329-332-318-237-runtime-integration.added.md](../../changelog.d/329-332-318-237-runtime-integration.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/329-request-submission.added.md](../../changelog.d/329-request-submission.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/331-admission-retry.added.md](../../changelog.d/331-admission-retry.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/332-config-generations.added.md](../../changelog.d/332-config-generations.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/332-config-generations.store.md](../../changelog.d/332-config-generations.store.md) | Release record/fragment; retained, link scan |
| [changelog.d/356-revision-input.added.md](../../changelog.d/356-revision-input.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/443-continuation-settlement.fixed.md](../../changelog.d/443-continuation-settlement.fixed.md) | Release record/fragment; retained, link scan |
| [changelog.d/444-owned-session-startup.fixed.md](../../changelog.d/444-owned-session-startup.fixed.md) | Release record/fragment; retained, link scan |
| [changelog.d/460-root-worktrees.added.md](../../changelog.d/460-root-worktrees.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/483-maintenance-contract.added.md](../../changelog.d/483-maintenance-contract.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/490-host-resources.added.md](../../changelog.d/490-host-resources.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/491-host-resource-access.added.md](../../changelog.d/491-host-resource-access.added.md) | Release record/fragment; retained, link scan |
| [changelog.d/499-continuation-contention.fixed.md](../../changelog.d/499-continuation-contention.fixed.md) | Release record/fragment; retained, link scan |
| [changelog.d/523-retry-catalog-contention.fixed.md](../../changelog.d/523-retry-catalog-contention.fixed.md) | Release record/fragment; retained, link scan |
| [changelog.d/README.md](../../changelog.d/README.md) | Release record/fragment; retained, link scan |
| [changelog.d/operator-integration.store.md](../../changelog.d/operator-integration.store.md) | Release record/fragment; retained, link scan |
| [changelog.d/operator-windows-sync.fixed.md](../../changelog.d/operator-windows-sync.fixed.md) | Release record/fragment; retained, link scan |
| [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) | Living prose reconciled / current-reading annotation |
| [docs/DATA-MODEL.md](../../docs/DATA-MODEL.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) | Living prose reconciled / current-reading annotation |
| [docs/EXTENSIBILITY.md](../../docs/EXTENSIBILITY.md) | Living prose reconciled / current-reading annotation |
| [docs/INTEGRATIONS.md](../../docs/INTEGRATIONS.md) | Living prose reconciled / current-reading annotation |
| [docs/PLANNING.md](../../docs/PLANNING.md) | Living prose reconciled / current-reading annotation |
| [docs/README.md](../../docs/README.md) | Living prose reconciled / current-reading annotation |
| [docs/REAL-AGENT-TEST.md](../../docs/REAL-AGENT-TEST.md) | Living prose reconciled / current-reading annotation |
| [docs/RELEASING.md](../../docs/RELEASING.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/ROADMAP.md](../../docs/ROADMAP.md) | Living prose reconciled / current-reading annotation |
| [docs/UPDATING.md](../../docs/UPDATING.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/WORKFLOWS.md](../../docs/WORKFLOWS.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/admission-retry.md](../../docs/admission-retry.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/adr/0001-event-sourced-runs.md](../../docs/adr/0001-event-sourced-runs.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0002-artifacts-as-handoff.md](../../docs/adr/0002-artifacts-as-handoff.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0003-single-token-interpreter.md](../../docs/adr/0003-single-token-interpreter.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0004-acp-boundary-and-ssh.md](../../docs/adr/0004-acp-boundary-and-ssh.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0005-standalone-engine-with-facades.md](../../docs/adr/0005-standalone-engine-with-facades.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0006-plan-as-persistent-dependency-graph.md](../../docs/adr/0006-plan-as-persistent-dependency-graph.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0007-risks-and-decisions-as-plan-entities.md](../../docs/adr/0007-risks-and-decisions-as-plan-entities.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0008-daemon-protocol-and-desktop-app-in-one-workspace.md](../../docs/adr/0008-daemon-protocol-and-desktop-app-in-one-workspace.md) | Settled decision/design record; classified, link scan |
| [docs/adr/0009-permission-grants-in-a-workspace-sidecar.md](../../docs/adr/0009-permission-grants-in-a-workspace-sidecar.md) | Settled decision/design record; classified, link scan |
| [docs/builtin-node-validation.md](../../docs/builtin-node-validation.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/ci-shadow-selection.md](../../docs/ci-shadow-selection.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/configuration-generations.md](../../docs/configuration-generations.md) | Living prose reconciled / current-reading annotation |
| [docs/daemon-connection.md](../../docs/daemon-connection.md) | Living prose reconciled / current-reading annotation |
| [docs/daemon-security.md](../../docs/daemon-security.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/design/10-information-architecture.md](../../docs/design/10-information-architecture.md) | Settled decision/design record; classified, link scan |
| [docs/design/20-attention-and-gates.md](../../docs/design/20-attention-and-gates.md) | Settled decision/design record; classified, link scan |
| [docs/design/30-long-running-content.md](../../docs/design/30-long-running-content.md) | Settled decision/design record; classified, link scan |
| [docs/design/40-connection-states.md](../../docs/design/40-connection-states.md) | Settled decision/design record; classified, link scan |
| [docs/design/50-accessibility-and-keyboard.md](../../docs/design/50-accessibility-and-keyboard.md) | Settled decision/design record; classified, link scan |
| [docs/design/60-implementation.md](../../docs/design/60-implementation.md) | Settled decision/design record; classified, link scan |
| [docs/design/70-workflow-editing.md](../../docs/design/70-workflow-editing.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/design/80-dependency-graph-options.md](../../docs/design/80-dependency-graph-options.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/design/README.md](../../docs/design/README.md) | Settled decision/design record; classified, link scan |
| [docs/design/RULES.md](../../docs/design/RULES.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/design/claude-design-prompt.md](../../docs/design/claude-design-prompt.md) | Settled decision/design record; classified, link scan |
| [docs/host-resource-access-policy.md](../../docs/host-resource-access-policy.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/host-resources.md](../../docs/host-resources.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/live-input-continuity.md](../../docs/live-input-continuity.md) | Living prose reconciled / current-reading annotation |
| [docs/maintenance-mcp.md](../../docs/maintenance-mcp.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/mcp-operator-production-acceptance.md](../../docs/mcp-operator-production-acceptance.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/mcp-operator-production-contract.md](../../docs/mcp-operator-production-contract.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/mcp-operator.md](../../docs/mcp-operator.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/performance/admission-retry-worker/README.md](../../docs/performance/admission-retry-worker/README.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/performance/admission-retry-worker/evidence/README.md](../../docs/performance/admission-retry-worker/evidence/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/performance/mcp-credential-admin/README.md](../../docs/performance/mcp-credential-admin/README.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/performance/mcp-credential-admin/evidence/README.md](../../docs/performance/mcp-credential-admin/evidence/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/performance/persistence-baseline/README.md](../../docs/performance/persistence-baseline/README.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/performance/persistence-baseline/baseline.md](../../docs/performance/persistence-baseline/baseline.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/performance/persistence-baseline/evidence-template.md](../../docs/performance/persistence-baseline/evidence-template.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/performance/persistence-baseline/evidence/README.md](../../docs/performance/persistence-baseline/evidence/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/acp-command-conformance/README.md](../../docs/preparation/acp-command-conformance/README.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/preparation/acp-command-conformance/evidence-format.md](../../docs/preparation/acp-command-conformance/evidence-format.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/acp-command-conformance/live-test-handoff.md](../../docs/preparation/acp-command-conformance/live-test-handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/acp-command-conformance/source-map.md](../../docs/preparation/acp-command-conformance/source-map.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/acp-command-conformance/test-matrix.md](../../docs/preparation/acp-command-conformance/test-matrix.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/acp-command-conformance/validation.md](../../docs/preparation/acp-command-conformance/validation.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/apple-watch-approvals/README.md](../../docs/preparation/apple-watch-approvals/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-feedback/README.md](../../docs/preparation/beta-feedback/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-feedback/first-success-checklist.md](../../docs/preparation/beta-feedback/first-success-checklist.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-feedback/report-template.md](../../docs/preparation/beta-feedback/report-template.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-feedback/synthetic-examples.md](../../docs/preparation/beta-feedback/synthetic-examples.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-feedback/tester-guide.md](../../docs/preparation/beta-feedback/tester-guide.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-feedback/triage-checklist.md](../../docs/preparation/beta-feedback/triage-checklist.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-first-job/acceptance.md](../../docs/preparation/beta-first-job/acceptance.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-first-job/validation.md](../../docs/preparation/beta-first-job/validation.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-update-support/README.md](../../docs/preparation/beta-update-support/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-update-support/acceptance-handoff.md](../../docs/preparation/beta-update-support/acceptance-handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-update-support/recovery-support.md](../../docs/preparation/beta-update-support/recovery-support.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/beta-update-support/update-contract.md](../../docs/preparation/beta-update-support/update-contract.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/cal-first-job-experience/README.md](../../docs/preparation/cal-first-job-experience/README.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/preparation/cal-first-job-experience/acceptance-scenarios.md](../../docs/preparation/cal-first-job-experience/acceptance-scenarios.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/cal-first-job-experience/capability-map.md](../../docs/preparation/cal-first-job-experience/capability-map.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/preparation/cal-first-job-experience/implementation-handoff.md](../../docs/preparation/cal-first-job-experience/implementation-handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/cal-first-job-experience/interaction-spec.md](../../docs/preparation/cal-first-job-experience/interaction-spec.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/cal-first-job-experience/wireframes-and-transcripts.md](../../docs/preparation/cal-first-job-experience/wireframes-and-transcripts.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/configuration-launch-implementation/README.md](../../docs/preparation/configuration-launch-implementation/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/configuration-launch-implementation/configuration.md](../../docs/preparation/configuration-launch-implementation/configuration.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/configuration-launch-implementation/handoff-and-tests.md](../../docs/preparation/configuration-launch-implementation/handoff-and-tests.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/configuration-launch-implementation/interfaces.md](../../docs/preparation/configuration-launch-implementation/interfaces.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/configuration-launch-implementation/launch.md](../../docs/preparation/configuration-launch-implementation/launch.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/ios-companion/README.md](../../docs/preparation/ios-companion/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/ios-companion/architecture.md](../../docs/preparation/ios-companion/architecture.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/ios-companion/delivery.md](../../docs/preparation/ios-companion/delivery.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-contract/README.md](../../docs/preparation/manual-diagnostics-contract/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-contract/acceptance-and-handoff.md](../../docs/preparation/manual-diagnostics-contract/acceptance-and-handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-contract/contract.md](../../docs/preparation/manual-diagnostics-contract/contract.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-contract/failure-mapping.md](../../docs/preparation/manual-diagnostics-contract/failure-mapping.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-contract/fixtures/README.md](../../docs/preparation/manual-diagnostics-contract/fixtures/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-contract/preview-and-consent.md](../../docs/preparation/manual-diagnostics-contract/preview-and-consent.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-contract/privacy-and-storage.md](../../docs/preparation/manual-diagnostics-contract/privacy-and-storage.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-implementation/README.md](../../docs/preparation/manual-diagnostics-implementation/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-implementation/budgets-and-lifecycle.md](../../docs/preparation/manual-diagnostics-implementation/budgets-and-lifecycle.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-implementation/ownership-and-acceptance.md](../../docs/preparation/manual-diagnostics-implementation/ownership-and-acceptance.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/manual-diagnostics-implementation/producer-inventory.md](../../docs/preparation/manual-diagnostics-implementation/producer-inventory.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-delivery/artifact-contract.md](../../docs/preparation/native-mac-delivery/artifact-contract.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-delivery/current-state.md](../../docs/preparation/native-mac-delivery/current-state.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/preparation/native-mac-delivery/delivery-design.md](../../docs/preparation/native-mac-delivery/delivery-design.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-delivery/implementation-handoff.md](../../docs/preparation/native-mac-delivery/implementation-handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-delivery/prerequisites.md](../../docs/preparation/native-mac-delivery/prerequisites.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-delivery/signing-foundation.md](../../docs/preparation/native-mac-delivery/signing-foundation.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-testing/evidence-template.md](../../docs/preparation/native-mac-testing/evidence-template.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-testing/fixture-contracts.md](../../docs/preparation/native-mac-testing/fixture-contracts.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-testing/harness-design.md](../../docs/preparation/native-mac-testing/harness-design.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-testing/implementation-handoff.md](../../docs/preparation/native-mac-testing/implementation-handoff.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/preparation/native-mac-testing/manual-checklist.md](../../docs/preparation/native-mac-testing/manual-checklist.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/native-mac-testing/test-matrix.md](../../docs/preparation/native-mac-testing/test-matrix.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/owned-root-candidate-49efcc7/activation-preflight.md](../../docs/preparation/owned-root-candidate-49efcc7/activation-preflight.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/owned-root-candidate-49efcc7/correction-2026-10-04.md](../../docs/preparation/owned-root-candidate-49efcc7/correction-2026-10-04.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/owned-root-candidate-49efcc7/first-smoke.md](../../docs/preparation/owned-root-candidate-49efcc7/first-smoke.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/acceptance-plan.md](../../docs/preparation/private-mcp-access/acceptance-plan.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/agent01-owner-staging/README.md](../../docs/preparation/private-mcp-access/agent01-owner-staging/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/agent01-owner-staging/hardening-probe.md](../../docs/preparation/private-mcp-access/agent01-owner-staging/hardening-probe.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/agent01-supervision.md](../../docs/preparation/private-mcp-access/agent01-supervision.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/connection-design.md](../../docs/preparation/private-mcp-access/connection-design.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/decision.md](../../docs/preparation/private-mcp-access/decision.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/handoff.md](../../docs/preparation/private-mcp-access/handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/operator-checklist.md](../../docs/preparation/private-mcp-access/operator-checklist.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/private-mcp-access/service-supervision.md](../../docs/preparation/private-mcp-access/service-supervision.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/swiftui-readonly-pilot/README.md](../../docs/preparation/swiftui-readonly-pilot/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/swiftui-readonly-pilot/contract.md](../../docs/preparation/swiftui-readonly-pilot/contract.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/swiftui-readonly-pilot/devices.md](../../docs/preparation/swiftui-readonly-pilot/devices.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/swiftui-readonly-pilot/fixtures/README.md](../../docs/preparation/swiftui-readonly-pilot/fixtures/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/swiftui-readonly-pilot/handoff.md](../../docs/preparation/swiftui-readonly-pilot/handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/swiftui-readonly-pilot/screens.md](../../docs/preparation/swiftui-readonly-pilot/screens.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/trusted-prepared-roots/README.md](../../docs/preparation/trusted-prepared-roots/README.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/preparation/trusted-prepared-roots/acceptance.md](../../docs/preparation/trusted-prepared-roots/acceptance.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/trusted-prepared-roots/contract.md](../../docs/preparation/trusted-prepared-roots/contract.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/preparation/trusted-prepared-roots/controller-handoff.md](../../docs/preparation/trusted-prepared-roots/controller-handoff.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/protected-execution-storage.md](../../docs/protected-execution-storage.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/protected-replay-error-contract.md](../../docs/protected-replay-error-contract.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/request-submission.md](../../docs/request-submission.md) | Living prose reconciled / current-reading annotation |
| [docs/research/tool-call-safety/README.md](../../docs/research/tool-call-safety/README.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/research/tool-call-safety/architecture.md](../../docs/research/tool-call-safety/architecture.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/research/tool-call-safety/assurance.md](../../docs/research/tool-call-safety/assurance.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/research/tool-call-safety/current-state.md](../../docs/research/tool-call-safety/current-state.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/research/tool-call-safety/policy.md](../../docs/research/tool-call-safety/policy.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/research/tool-call-safety/roadmap.md](../../docs/research/tool-call-safety/roadmap.md) | Dated preparation/research/measurement; classified, link scan |
| [docs/revision-input.md](../../docs/revision-input.md) | Living prose reconciled / current-reading annotation |
| [docs/root-worktree-isolation.md](../../docs/root-worktree-isolation.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/runtime-foundation-integration.md](../../docs/runtime-foundation-integration.md) | Historical/checkpoint record; classified, link scan |
| [docs/runtime-foundation-parallel-contract.md](../../docs/runtime-foundation-parallel-contract.md) | Historical/checkpoint record; classified, link scan |
| [docs/runtime-next-integration.md](../../docs/runtime-next-integration.md) | Historical/checkpoint record; classified, link scan |
| [docs/runtime-next-parallel-contract.md](../../docs/runtime-next-parallel-contract.md) | Historical/checkpoint record; classified, link scan |
| [docs/runtime-operator-integration.md](../../docs/runtime-operator-integration.md) | Targeted source/evidence comparison; retained or owner-routed |
| [docs/runtime-operator-parallel-contract.md](../../docs/runtime-operator-parallel-contract.md) | Historical/checkpoint record; classified, link scan |
| [docs/session-logs/2026-09-19-kepler-session-sess_01M2VHXARDM7Z6V5RTVVBE136M/README.md](../../docs/session-logs/2026-09-19-kepler-session-sess_01M2VHXARDM7Z6V5RTVVBE136M/README.md) | Historical/checkpoint record; classified, link scan |
| [docs/session-logs/README.md](../../docs/session-logs/README.md) | Historical/checkpoint record; classified, link scan |
| [docs/v0.5.2-desktop-checklist.md](../../docs/v0.5.2-desktop-checklist.md) | Historical/checkpoint record; classified, link scan |
| [docs/v0.5.2-entrypoints-checklist.md](../../docs/v0.5.2-entrypoints-checklist.md) | Historical/checkpoint record; classified, link scan |
| [docs/v0.5.2-implementation.md](../../docs/v0.5.2-implementation.md) | Historical/checkpoint record; classified, link scan |
| [docs/v0.5.2-ownership-compatibility.md](../../docs/v0.5.2-ownership-compatibility.md) | Historical/checkpoint record; classified, link scan |
| [docs/v0.5.2-planning-checklist.md](../../docs/v0.5.2-planning-checklist.md) | Historical/checkpoint record; classified, link scan |
| [docs/workflow-inputs.md](../../docs/workflow-inputs.md) | Targeted source/evidence comparison; retained or owner-routed |
| [examples/beta-first-job/README.md](../../examples/beta-first-job/README.md) | Targeted source/evidence comparison; retained or owner-routed |
| [examples/beta-first-job/template/README.md](../../examples/beta-first-job/template/README.md) | Supporting developer/package reference; census/link scan |
| [packages/core/src/expr/README.md](../../packages/core/src/expr/README.md) | Supporting developer/package reference; census/link scan |
| [packages/design/fonts/README.md](../../packages/design/fonts/README.md) | Supporting developer/package reference; census/link scan |
| [packages/maintenance-mcp/README.md](../../packages/maintenance-mcp/README.md) | Supporting developer/package reference; census/link scan |
| [packages/protocol/README.md](../../packages/protocol/README.md) | Living prose reconciled / current-reading annotation |
| [templates/partials/upstream-context.md](../../templates/partials/upstream-context.md) | Executable prompt; census/link scan only, untouched |
| [templates/partials/work-item-context.md](../../templates/partials/work-item-context.md) | Executable prompt; census/link scan only, untouched |
| [templates/program/assess-risks.md](../../templates/program/assess-risks.md) | Executable prompt; census/link scan only, untouched |
| [templates/program/decide.md](../../templates/program/decide.md) | Executable prompt; census/link scan only, untouched |
| [templates/program/decompose.md](../../templates/program/decompose.md) | Executable prompt; census/link scan only, untouched |
| [templates/program/summary.md](../../templates/program/summary.md) | Executable prompt; census/link scan only, untouched |
| [templates/sdlc/build.md](../../templates/sdlc/build.md) | Executable prompt; census/link scan only, untouched |
| [templates/sdlc/deploy.md](../../templates/sdlc/deploy.md) | Executable prompt; census/link scan only, untouched |
| [templates/sdlc/design.md](../../templates/sdlc/design.md) | Executable prompt; census/link scan only, untouched |
| [templates/sdlc/plan.md](../../templates/sdlc/plan.md) | Executable prompt; census/link scan only, untouched |
| [templates/sdlc/review.md](../../templates/sdlc/review.md) | Executable prompt; census/link scan only, untouched |
| [templates/sdlc/test.md](../../templates/sdlc/test.md) | Executable prompt; census/link scan only, untouched |
| [templates/strict/sdlc/review.md](../../templates/strict/sdlc/review.md) | Executable prompt; census/link scan only, untouched |
| [tools/deploy/tests/native-mac/README.md](../../tools/deploy/tests/native-mac/README.md) | Supporting developer/package reference; census/link scan |
