# Documentation comparison inventory

The independent checkpoint preceded all optional documentation reads. [Manifest](../BASELINE-MANIFEST.sha256) · [Corrections](../addenda/corrections.md) · [Differences](differences.md).

This inventory enumerates every tracked Markdown/text document found by the repository inventory, including hidden contribution templates and executable prompt bodies. “Full” means the body was read for architecture/maintenance comparison, not that every sentence is independently verified. Test-success claims in old release notes remain historical declarations. Documentation under `docs/` is explicitly described as tracking main by [RELEASING](../../docs/RELEASING.md#L237).

| Document | Lines | Role | Review depth | Comparison / disposition |
| --- | --- | --- | --- | --- |
| [.github/pull_request_template.md](../../.github/pull_request_template.md) | 18 | Contribution template | Full | Documentation/check requirements declared |
| [AGENTS.md](../../AGENTS.md) | 254 | Agent working instructions | Mandatory AGENTS exposure before baseline; CLAUDE delegation pointer after | D06; exposure recorded in baseline scope |
| [CHANGELOG.md](../../CHANGELOG.md) | 1505 | Release history | Selective: current 0.5.2 section, headings and targeted historical claims | D01, D04; historical test claims not adopted |
| [CLAUDE.md](../../CLAUDE.md) | 1 | Agent working instructions | Mandatory AGENTS exposure before baseline; CLAUDE delegation pointer after | D06; exposure recorded in baseline scope |
| [README.md](../../README.md) | 147 | Current guide / reference | Full | See difference-to-document index below |
| [changelog.d/117-plan-key-bound.fixed.md](../../changelog.d/117-plan-key-bound.fixed.md) | 4 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/117-plan-key-bound.store.md](../../changelog.d/117-plan-key-bound.store.md) | 5 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/139-local-workspace-branch.fixed.md](../../changelog.d/139-local-workspace-branch.fixed.md) | 7 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/139-local-workspace-branch.store.md](../../changelog.d/139-local-workspace-branch.store.md) | 4 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/171-dependency-graph.added.md](../../changelog.d/171-dependency-graph.added.md) | 15 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/172-risk-matrix.added.md](../../changelog.d/172-risk-matrix.added.md) | 10 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/173-decision-matrix.added.md](../../changelog.d/173-decision-matrix.added.md) | 14 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/179-pinned-workflow-version.added.md](../../changelog.d/179-pinned-workflow-version.added.md) | 9 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/179-pinned-workflow-version.store.md](../../changelog.d/179-pinned-workflow-version.store.md) | 8 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/185-session-config-options.added.md](../../changelog.d/185-session-config-options.added.md) | 8 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/186-run-overrides.added.md](../../changelog.d/186-run-overrides.added.md) | 10 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/186-run-overrides.store.md](../../changelog.d/186-run-overrides.store.md) | 6 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/187-apply-model.added.md](../../changelog.d/187-apply-model.added.md) | 9 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/187-apply-model.store.md](../../changelog.d/187-apply-model.store.md) | 3 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/188-acp-config-options.added.md](../../changelog.d/188-acp-config-options.added.md) | 8 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/188-acp-template-packs.added.md](../../changelog.d/188-acp-template-packs.added.md) | 5 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/189-acp-model-lists.added.md](../../changelog.d/189-acp-model-lists.added.md) | 10 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/190-cli-selection-flags.added.md](../../changelog.d/190-cli-selection-flags.added.md) | 9 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/191-template-packs.added.md](../../changelog.d/191-template-packs.added.md) | 8 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/192-acp-available-commands.added.md](../../changelog.d/192-acp-available-commands.added.md) | 4 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/296-jev-eval-plugin.added.md](../../changelog.d/296-jev-eval-plugin.added.md) | 8 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/306-deployment.added.md](../../changelog.d/306-deployment.added.md) | 2 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/306-desktop-updates.added.md](../../changelog.d/306-desktop-updates.added.md) | 1 | Pending release declaration | Full | Corroborating declarations only; D01–D04 |
| [changelog.d/README.md](../../changelog.d/README.md) | 85 | Current guide / reference | Full | See difference-to-document index below |
| [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) | 407 | Current guide / reference | Full | See difference-to-document index below |
| [docs/DATA-MODEL.md](../../docs/DATA-MODEL.md) | 199 | Current guide / reference | Full | See difference-to-document index below |
| [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) | 627 | Current guide / reference | Full | See difference-to-document index below |
| [docs/EXTENSIBILITY.md](../../docs/EXTENSIBILITY.md) | 64 | Current guide / reference | Full | See difference-to-document index below |
| [docs/INTEGRATIONS.md](../../docs/INTEGRATIONS.md) | 378 | Current guide / reference | Full | See difference-to-document index below |
| [docs/PLANNING.md](../../docs/PLANNING.md) | 461 | Current guide / reference | Full | See difference-to-document index below |
| [docs/README.md](../../docs/README.md) | 16 | Current guide / reference | Full | See difference-to-document index below |
| [docs/REAL-AGENT-TEST.md](../../docs/REAL-AGENT-TEST.md) | 415 | Current guide / reference | Full | See difference-to-document index below |
| [docs/RELEASING.md](../../docs/RELEASING.md) | 301 | Current guide / reference | Full | See difference-to-document index below |
| [docs/ROADMAP.md](../../docs/ROADMAP.md) | 195 | Current guide / reference | Full | See difference-to-document index below |
| [docs/UPDATING.md](../../docs/UPDATING.md) | 299 | Current guide / reference | Full | See difference-to-document index below |
| [docs/WORKFLOWS.md](../../docs/WORKFLOWS.md) | 337 | Current guide / reference | Full | See difference-to-document index below |
| [docs/adr/0001-event-sourced-runs.md](../../docs/adr/0001-event-sourced-runs.md) | 18 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0002-artifacts-as-handoff.md](../../docs/adr/0002-artifacts-as-handoff.md) | 19 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0003-single-token-interpreter.md](../../docs/adr/0003-single-token-interpreter.md) | 22 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0004-acp-boundary-and-ssh.md](../../docs/adr/0004-acp-boundary-and-ssh.md) | 20 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0005-standalone-engine-with-facades.md](../../docs/adr/0005-standalone-engine-with-facades.md) | 21 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0006-plan-as-persistent-dependency-graph.md](../../docs/adr/0006-plan-as-persistent-dependency-graph.md) | 41 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0007-risks-and-decisions-as-plan-entities.md](../../docs/adr/0007-risks-and-decisions-as-plan-entities.md) | 36 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0008-daemon-protocol-and-desktop-app-in-one-workspace.md](../../docs/adr/0008-daemon-protocol-and-desktop-app-in-one-workspace.md) | 92 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/adr/0009-permission-grants-in-a-workspace-sidecar.md](../../docs/adr/0009-permission-grants-in-a-workspace-sidecar.md) | 142 | Architecture decision record | Full | D05, D09; rationale distinguished from current implementation |
| [docs/design/10-information-architecture.md](../../docs/design/10-information-architecture.md) | 186 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/20-attention-and-gates.md](../../docs/design/20-attention-and-gates.md) | 78 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/30-long-running-content.md](../../docs/design/30-long-running-content.md) | 104 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/40-connection-states.md](../../docs/design/40-connection-states.md) | 98 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/50-accessibility-and-keyboard.md](../../docs/design/50-accessibility-and-keyboard.md) | 174 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/60-implementation.md](../../docs/design/60-implementation.md) | 670 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/70-workflow-editing.md](../../docs/design/70-workflow-editing.md) | 161 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/80-dependency-graph-options.md](../../docs/design/80-dependency-graph-options.md) | 163 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/README.md](../../docs/design/README.md) | 222 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/RULES.md](../../docs/design/RULES.md) | 45 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/design/claude-design-prompt.md](../../docs/design/claude-design-prompt.md) | 156 | Design rules / implementation notes / proposals | Full | D02, D03, D06, D10; proposals preserved as future intent |
| [docs/session-logs/2026-09-19-kepler-session-sess_01M2VHXARDM7Z6V5RTVVBE136M/README.md](../../docs/session-logs/2026-09-19-kepler-session-sess_01M2VHXARDM7Z6V5RTVVBE136M/README.md) | 44 | Historical session context | Full README; archived runtime transcripts excluded | Historical evidence only |
| [docs/session-logs/README.md](../../docs/session-logs/README.md) | 28 | Historical session context | Full README; archived runtime transcripts excluded | Historical evidence only |
| [docs/v0.5.2-desktop-checklist.md](../../docs/v0.5.2-desktop-checklist.md) | 55 | Versioned implementation / release checklist | Full | Cross-checked historical fixes; no execution claim adopted |
| [docs/v0.5.2-entrypoints-checklist.md](../../docs/v0.5.2-entrypoints-checklist.md) | 32 | Versioned implementation / release checklist | Full | Cross-checked historical fixes; no execution claim adopted |
| [docs/v0.5.2-implementation.md](../../docs/v0.5.2-implementation.md) | 93 | Versioned implementation / release checklist | Full | Cross-checked historical fixes; no execution claim adopted |
| [docs/v0.5.2-ownership-compatibility.md](../../docs/v0.5.2-ownership-compatibility.md) | 80 | Versioned implementation / release checklist | Full | Cross-checked historical fixes; no execution claim adopted |
| [docs/v0.5.2-planning-checklist.md](../../docs/v0.5.2-planning-checklist.md) | 41 | Versioned implementation / release checklist | Full | Cross-checked historical fixes; no execution claim adopted |
| [packages/core/src/expr/README.md](../../packages/core/src/expr/README.md) | 27 | Current guide / reference | Full | See difference-to-document index below |
| [packages/design/fonts/LICENSE-IBM-Plex.txt](../../packages/design/fonts/LICENSE-IBM-Plex.txt) | 93 | Font licence | Excluded: legal terms, not an architecture claim | Asset presence catalogued |
| [packages/design/fonts/LICENSE-Noto.txt](../../packages/design/fonts/LICENSE-Noto.txt) | 93 | Font licence | Excluded: legal terms, not an architecture claim | Asset presence catalogued |
| [packages/design/fonts/README.md](../../packages/design/fonts/README.md) | 51 | Current guide / reference | Full | See difference-to-document index below |
| [packages/protocol/README.md](../../packages/protocol/README.md) | 800 | Current guide / reference | Full | See difference-to-document index below |
| [templates/partials/upstream-context.md](../../templates/partials/upstream-context.md) | 16 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/partials/work-item-context.md](../../templates/partials/work-item-context.md) | 26 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/program/assess-risks.md](../../templates/program/assess-risks.md) | 53 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/program/decide.md](../../templates/program/decide.md) | 66 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/program/decompose.md](../../templates/program/decompose.md) | 60 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/program/summary.md](../../templates/program/summary.md) | 42 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/sdlc/build.md](../../templates/sdlc/build.md) | 48 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/sdlc/deploy.md](../../templates/sdlc/deploy.md) | 40 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/sdlc/design.md](../../templates/sdlc/design.md) | 33 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/sdlc/plan.md](../../templates/sdlc/plan.md) | 22 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/sdlc/review.md](../../templates/sdlc/review.md) | 35 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/sdlc/test.md](../../templates/sdlc/test.md) | 32 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |
| [templates/strict/sdlc/review.md](../../templates/strict/sdlc/review.md) | 42 | Executable prompt asset | Full body after checkpoint; frontmatter only before it | D13 for assess-risks; other prompts agree with scoped asset inventory |

**86 text files inventoried.** The inventory is a comparison log, not a replacement source-of-truth hierarchy. Existing files are unchanged.

## Difference-to-document index

| Document family | Findings or preserved agreement |
| --- | --- |
| README / ROADMAP / PLANNING current status | D01, D02, D04, D07, D09; clearly future capacity/Maintain work retained |
| ARCHITECTURE / DATA-MODEL | D03, D09, D11, D14; current workflow resolution narrative in ARCHITECTURE is useful corrective context |
| Protocol reference | D01, D03, D07, D08, D16; core wire shapes, invalidation notifications and text-only artifact bodies agree |
| ADRs | D05, D09; event projection, artifact handoff, child runs, ACP/SSH, facades and app boundary remain useful rationale |
| Design set / AGENTS | D02, D03, D06, D10; extensive existing primitive/accessibility/scroll/pane specifications agree with inspected structure |
| DEVELOPMENT / font / expression guides | D12; font/token generation and expression extension mechanics otherwise agree at the inspected boundaries |
| WORKFLOWS / operational templates | D13, D15; graph routing, named artifacts, branch workflows and template contract otherwise align |
| INTEGRATIONS / EXTENSIBILITY / REAL-AGENT-TEST | T3 transport explicitly unfinished; injected session factories distinct from PluginApi; generic upstream config choices recorded rather than applied is acknowledged. External interoperability instructions unverified |
| UPDATING / RELEASING / changelog policy / PR template | D01 navigation omission; detailed update ownership and release compatibility policies agree as source/configuration claims; credentials, installed deployment, signing and service outcomes unverified |
| Historical checklists, session context, release fragments | Preserve date/version scope; useful record of intended fixes, never proof of this checkout's test or runtime health |

## Exclusions and inaccessible evidence

- The two archived session JSONL transcripts under `docs/session-logs/` were not replayed or used to establish present behavior; their README descriptions were read. They describe historical runs, not execution of the reviewed commit.
- Older sections of `CHANGELOG.md` were searched selectively, not audited line by line. All headings and the current 0.5.2 section were inspected. Release declarations are not substituted for current source.
- Font licences are inventoried but not legally assessed. Font binaries, icons and screenshots are recorded as assets; no visual rendering/font compliance outcome is established.
- The externally rendered Claude design artifact was not attached or accessible. Linked external issues, ACP/T3/JEV websites and release servers were not fetched. Repository-local schemas, adapters and configuration are the evidence.
- No installed deployment tree, credential store, remote host, production data, GitHub settings or CI execution was inspected. No required repository-local architecture guide was inaccessible.

## Scope decisions

The workflow editor, draft/publish flow, hot reload, capacity/milestone allocation, Maintain loop, durable provider-session restore, and T3 transport are retained as future intentions wherever explicitly labelled that way. A diagram or prompt describing such a target is not automatically a contradiction. D03 distinguishes an obsolete **as-built** note inside a proposal from the proposed editor itself. The design prompt is a historical brief, not an instruction executed by this review.
