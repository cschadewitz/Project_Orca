# Source ownership map

Every census file is mapped below. Architecture review traces major responsibilities; inclusion here means **mapped**, not that each line was individually audited. Evidence links in specifications identify the semantically traced sources. Generated files, tests and configuration retain distinct census categories.

| File | Category | Ownership view | Lines |
| --- | --- | --- | --- |
| [.codex/environments/environment.toml](../../.codex/environments/environment.toml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 6 |
| [.editorconfig](../../.editorconfig) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 8 |
| [.git-blame-ignore-revs](../../.git-blame-ignore-revs) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 8 |
| [.gitattributes](../../.gitattributes) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 8 |
| [.github/dependabot.yml](../../.github/dependabot.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 47 |
| [.github/release.yml](../../.github/release.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 21 |
| [.github/workflows/app-smoke.yml](../../.github/workflows/app-smoke.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 245 |
| [.github/workflows/changelog.yml](../../.github/workflows/changelog.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 79 |
| [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 142 |
| [.github/workflows/codeql.yml](../../.github/workflows/codeql.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 41 |
| [.github/workflows/desktop.yml](../../.github/workflows/desktop.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 254 |
| [.github/workflows/release-prepare.yml](../../.github/workflows/release-prepare.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 152 |
| [.github/workflows/release-publish.yml](../../.github/workflows/release-publish.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 208 |
| [.github/workflows/selfhosted_runner_smoketest.yml](../../.github/workflows/selfhosted_runner_smoketest.yml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 19 |
| [.gitignore](../../.gitignore) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 9 |
| [.prettierignore](../../.prettierignore) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 19 |
| [.prettierrc.json](../../.prettierrc.json) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 7 |
| [LICENSE](../../LICENSE) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 21 |
| [eslint.config.js](../../eslint.config.js) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 3 |
| [examples/jev/orca.config.yaml](../../examples/jev/orca.config.yaml) | configuration/tool/asset | [workflow-assets](../architecture/workflow-assets.md) | 45 |
| [examples/jev/workflows/ai-sdlc-jev-shadow.yaml](../../examples/jev/workflows/ai-sdlc-jev-shadow.yaml) | configuration/tool/asset | [workflow-assets](../architecture/workflow-assets.md) | 238 |
| [examples/orca.config.yaml](../../examples/orca.config.yaml) | configuration/tool/asset | [workflow-assets](../architecture/workflow-assets.md) | 87 |
| [examples/plugin-example.ts](../../examples/plugin-example.ts) | implementation/type | [workflow-assets](../architecture/workflow-assets.md) | 22 |
| [mise.toml](../../mise.toml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 3 |
| [package.json](../../package.json) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 45 |
| [packages/agents/package.json](../../packages/agents/package.json) | configuration/tool/asset | [agents](../architecture/agents.md) | 21 |
| [packages/agents/src/acp-session.ts](../../packages/agents/src/acp-session.ts) | implementation/type | [agents](../architecture/agents.md) | 392 |
| [packages/agents/src/config-options.ts](../../packages/agents/src/config-options.ts) | implementation/type | [agents](../architecture/agents.md) | 59 |
| [packages/agents/src/host.ts](../../packages/agents/src/host.ts) | implementation/type | [agents](../architecture/agents.md) | 217 |
| [packages/agents/src/hosts/local-host.ts](../../packages/agents/src/hosts/local-host.ts) | implementation/type | [agents](../architecture/agents.md) | 72 |
| [packages/agents/src/hosts/registry.ts](../../packages/agents/src/hosts/registry.ts) | implementation/type | [agents](../architecture/agents.md) | 345 |
| [packages/agents/src/hosts/ssh-host.ts](../../packages/agents/src/hosts/ssh-host.ts) | implementation/type | [agents](../architecture/agents.md) | 142 |
| [packages/agents/src/index.ts](../../packages/agents/src/index.ts) | implementation/type | [agents](../architecture/agents.md) | 9 |
| [packages/agents/src/permissions.ts](../../packages/agents/src/permissions.ts) | implementation/type | [agents](../architecture/agents.md) | 473 |
| [packages/agents/src/session.ts](../../packages/agents/src/session.ts) | implementation/type | [agents](../architecture/agents.md) | 107 |
| [packages/agents/test/acp-session.test.ts](../../packages/agents/test/acp-session.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 295 |
| [packages/agents/test/agent-health.test.ts](../../packages/agents/test/agent-health.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 174 |
| [packages/agents/test/handshake.test.ts](../../packages/agents/test/handshake.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 53 |
| [packages/agents/test/hosts.test.ts](../../packages/agents/test/hosts.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 122 |
| [packages/agents/test/permission-sidecar-session.test.ts](../../packages/agents/test/permission-sidecar-session.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 179 |
| [packages/agents/test/permissions.test.ts](../../packages/agents/test/permissions.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 767 |
| [packages/agents/test/session.test.ts](../../packages/agents/test/session.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 67 |
| [packages/agents/test/ssh-failures.test.ts](../../packages/agents/test/ssh-failures.test.ts) | test source/fixture | [agents](../architecture/agents.md) | 50 |
| [packages/agents/tsconfig.json](../../packages/agents/tsconfig.json) | configuration/tool/asset | [agents](../architecture/agents.md) | 6 |
| [packages/app/electron-builder.yml](../../packages/app/electron-builder.yml) | configuration/tool/asset | [app](../architecture/app.md) | 117 |
| [packages/app/package.json](../../packages/app/package.json) | configuration/tool/asset | [app](../architecture/app.md) | 36 |
| [packages/app/renderer/index.html](../../packages/app/renderer/index.html) | configuration/tool/asset | [app](../architecture/app.md) | 26 |
| [packages/app/renderer/src/App.tsx](../../packages/app/renderer/src/App.tsx) | implementation/type | [app](../architecture/app.md) | 475 |
| [packages/app/renderer/src/a11y/announce-context.tsx](../../packages/app/renderer/src/a11y/announce-context.tsx) | implementation/type | [app](../architecture/app.md) | 31 |
| [packages/app/renderer/src/a11y/announce.ts](../../packages/app/renderer/src/a11y/announce.ts) | implementation/type | [app](../architecture/app.md) | 41 |
| [packages/app/renderer/src/a11y/announcements.ts](../../packages/app/renderer/src/a11y/announcements.ts) | implementation/type | [app](../architecture/app.md) | 134 |
| [packages/app/renderer/src/a11y/announcer.tsx](../../packages/app/renderer/src/a11y/announcer.tsx) | implementation/type | [app](../architecture/app.md) | 85 |
| [packages/app/renderer/src/agents/agent-card.tsx](../../packages/app/renderer/src/agents/agent-card.tsx) | implementation/type | [app](../architecture/app.md) | 148 |
| [packages/app/renderer/src/agents/agent-groups.ts](../../packages/app/renderer/src/agents/agent-groups.ts) | implementation/type | [app](../architecture/app.md) | 119 |
| [packages/app/renderer/src/agents/agents-surface.tsx](../../packages/app/renderer/src/agents/agents-surface.tsx) | implementation/type | [app](../architecture/app.md) | 448 |
| [packages/app/renderer/src/agents/agents.css](../../packages/app/renderer/src/agents/agents.css) | implementation/type | [app](../architecture/app.md) | 226 |
| [packages/app/renderer/src/agents/use-agents.ts](../../packages/app/renderer/src/agents/use-agents.ts) | implementation/type | [app](../architecture/app.md) | 161 |
| [packages/app/renderer/src/app.css](../../packages/app/renderer/src/app.css) | implementation/type | [app](../architecture/app.md) | 20 |
| [packages/app/renderer/src/appearance-context.tsx](../../packages/app/renderer/src/appearance-context.tsx) | implementation/type | [app](../architecture/app.md) | 33 |
| [packages/app/renderer/src/appearance.ts](../../packages/app/renderer/src/appearance.ts) | implementation/type | [app](../architecture/app.md) | 188 |
| [packages/app/renderer/src/artifacts/artifact-panel.tsx](../../packages/app/renderer/src/artifacts/artifact-panel.tsx) | implementation/type | [app](../architecture/app.md) | 297 |
| [packages/app/renderer/src/artifacts/artifacts.css](../../packages/app/renderer/src/artifacts/artifacts.css) | implementation/type | [app](../architecture/app.md) | 33 |
| [packages/app/renderer/src/artifacts/diff.ts](../../packages/app/renderer/src/artifacts/diff.ts) | implementation/type | [app](../architecture/app.md) | 192 |
| [packages/app/renderer/src/artifacts/index.ts](../../packages/app/renderer/src/artifacts/index.ts) | implementation/type | [app](../architecture/app.md) | 29 |
| [packages/app/renderer/src/artifacts/panel-context.tsx](../../packages/app/renderer/src/artifacts/panel-context.tsx) | implementation/type | [app](../architecture/app.md) | 116 |
| [packages/app/renderer/src/artifacts/use-artifacts.ts](../../packages/app/renderer/src/artifacts/use-artifacts.ts) | implementation/type | [app](../architecture/app.md) | 119 |
| [packages/app/renderer/src/attention/answer-card.tsx](../../packages/app/renderer/src/attention/answer-card.tsx) | implementation/type | [app](../architecture/app.md) | 311 |
| [packages/app/renderer/src/attention/attention-surface.tsx](../../packages/app/renderer/src/attention/attention-surface.tsx) | implementation/type | [app](../architecture/app.md) | 481 |
| [packages/app/renderer/src/attention/attention.css](../../packages/app/renderer/src/attention/attention.css) | implementation/type | [app](../architecture/app.md) | 108 |
| [packages/app/renderer/src/attention/card-model.ts](../../packages/app/renderer/src/attention/card-model.ts) | implementation/type | [app](../architecture/app.md) | 134 |
| [packages/app/renderer/src/attention/gate-card.tsx](../../packages/app/renderer/src/attention/gate-card.tsx) | implementation/type | [app](../architecture/app.md) | 100 |
| [packages/app/renderer/src/attention/index.ts](../../packages/app/renderer/src/attention/index.ts) | implementation/type | [app](../architecture/app.md) | 29 |
| [packages/app/renderer/src/attention/inline-asks.tsx](../../packages/app/renderer/src/attention/inline-asks.tsx) | implementation/type | [app](../architecture/app.md) | 82 |
| [packages/app/renderer/src/attention/items.ts](../../packages/app/renderer/src/attention/items.ts) | implementation/type | [app](../architecture/app.md) | 72 |
| [packages/app/renderer/src/attention/permission-card.tsx](../../packages/app/renderer/src/attention/permission-card.tsx) | implementation/type | [app](../architecture/app.md) | 72 |
| [packages/app/renderer/src/attention/use-alert-activation.ts](../../packages/app/renderer/src/attention/use-alert-activation.ts) | implementation/type | [app](../architecture/app.md) | 22 |
| [packages/app/renderer/src/attention/use-attention.ts](../../packages/app/renderer/src/attention/use-attention.ts) | implementation/type | [app](../architecture/app.md) | 249 |
| [packages/app/renderer/src/attention/use-card-keys.ts](../../packages/app/renderer/src/attention/use-card-keys.ts) | implementation/type | [app](../architecture/app.md) | 103 |
| [packages/app/renderer/src/attention/use-controls.ts](../../packages/app/renderer/src/attention/use-controls.ts) | implementation/type | [app](../architecture/app.md) | 130 |
| [packages/app/renderer/src/chrome/connection-banner.tsx](../../packages/app/renderer/src/chrome/connection-banner.tsx) | implementation/type | [app](../architecture/app.md) | 143 |
| [packages/app/renderer/src/chrome/docked-panel.tsx](../../packages/app/renderer/src/chrome/docked-panel.tsx) | implementation/type | [app](../architecture/app.md) | 72 |
| [packages/app/renderer/src/chrome/pane-splitter.tsx](../../packages/app/renderer/src/chrome/pane-splitter.tsx) | implementation/type | [app](../architecture/app.md) | 260 |
| [packages/app/renderer/src/chrome/primary-pane.tsx](../../packages/app/renderer/src/chrome/primary-pane.tsx) | implementation/type | [app](../architecture/app.md) | 33 |
| [packages/app/renderer/src/chrome/sidebar.tsx](../../packages/app/renderer/src/chrome/sidebar.tsx) | implementation/type | [app](../architecture/app.md) | 43 |
| [packages/app/renderer/src/chrome/status-bar.tsx](../../packages/app/renderer/src/chrome/status-bar.tsx) | implementation/type | [app](../architecture/app.md) | 52 |
| [packages/app/renderer/src/chrome/surfaces.ts](../../packages/app/renderer/src/chrome/surfaces.ts) | implementation/type | [app](../architecture/app.md) | 33 |
| [packages/app/renderer/src/chrome/title-bar.tsx](../../packages/app/renderer/src/chrome/title-bar.tsx) | implementation/type | [app](../architecture/app.md) | 61 |
| [packages/app/renderer/src/chrome/update-control.tsx](../../packages/app/renderer/src/chrome/update-control.tsx) | implementation/type | [app](../architecture/app.md) | 59 |
| [packages/app/renderer/src/chrome/use-breakpoints.ts](../../packages/app/renderer/src/chrome/use-breakpoints.ts) | implementation/type | [app](../architecture/app.md) | 16 |
| [packages/app/renderer/src/chrome/use-chrome-shortcuts.ts](../../packages/app/renderer/src/chrome/use-chrome-shortcuts.ts) | implementation/type | [app](../architecture/app.md) | 42 |
| [packages/app/renderer/src/chrome/use-connection.ts](../../packages/app/renderer/src/chrome/use-connection.ts) | implementation/type | [app](../architecture/app.md) | 84 |
| [packages/app/renderer/src/chrome/use-media-query.ts](../../packages/app/renderer/src/chrome/use-media-query.ts) | implementation/type | [app](../architecture/app.md) | 16 |
| [packages/app/renderer/src/chrome/use-workspace.ts](../../packages/app/renderer/src/chrome/use-workspace.ts) | implementation/type | [app](../architecture/app.md) | 27 |
| [packages/app/renderer/src/config/config-context.tsx](../../packages/app/renderer/src/config/config-context.tsx) | implementation/type | [app](../architecture/app.md) | 42 |
| [packages/app/renderer/src/config/config-form.tsx](../../packages/app/renderer/src/config/config-form.tsx) | implementation/type | [app](../architecture/app.md) | 181 |
| [packages/app/renderer/src/config/config-model.ts](../../packages/app/renderer/src/config/config-model.ts) | implementation/type | [app](../architecture/app.md) | 536 |
| [packages/app/renderer/src/config/config-surface.tsx](../../packages/app/renderer/src/config/config-surface.tsx) | implementation/type | [app](../architecture/app.md) | 312 |
| [packages/app/renderer/src/config/config.css](../../packages/app/renderer/src/config/config.css) | implementation/type | [app](../architecture/app.md) | 202 |
| [packages/app/renderer/src/config/draft-bar.tsx](../../packages/app/renderer/src/config/draft-bar.tsx) | implementation/type | [app](../architecture/app.md) | 105 |
| [packages/app/renderer/src/config/permissions-view.tsx](../../packages/app/renderer/src/config/permissions-view.tsx) | implementation/type | [app](../architecture/app.md) | 125 |
| [packages/app/renderer/src/config/policy-editor.tsx](../../packages/app/renderer/src/config/policy-editor.tsx) | implementation/type | [app](../architecture/app.md) | 538 |
| [packages/app/renderer/src/config/policy-model.ts](../../packages/app/renderer/src/config/policy-model.ts) | implementation/type | [app](../architecture/app.md) | 261 |
| [packages/app/renderer/src/config/policy.css](../../packages/app/renderer/src/config/policy.css) | implementation/type | [app](../architecture/app.md) | 80 |
| [packages/app/renderer/src/config/preferences-section.tsx](../../packages/app/renderer/src/config/preferences-section.tsx) | implementation/type | [app](../architecture/app.md) | 175 |
| [packages/app/renderer/src/config/raw-view.tsx](../../packages/app/renderer/src/config/raw-view.tsx) | implementation/type | [app](../architecture/app.md) | 102 |
| [packages/app/renderer/src/config/use-config.ts](../../packages/app/renderer/src/config/use-config.ts) | implementation/type | [app](../architecture/app.md) | 262 |
| [packages/app/renderer/src/connection.ts](../../packages/app/renderer/src/connection.ts) | implementation/type | [app](../architecture/app.md) | 156 |
| [packages/app/renderer/src/density.ts](../../packages/app/renderer/src/density.ts) | implementation/type | [app](../architecture/app.md) | 48 |
| [packages/app/renderer/src/keyboard-context.tsx](../../packages/app/renderer/src/keyboard-context.tsx) | implementation/type | [app](../architecture/app.md) | 30 |
| [packages/app/renderer/src/keyboard-map.ts](../../packages/app/renderer/src/keyboard-map.ts) | implementation/type | [app](../architecture/app.md) | 344 |
| [packages/app/renderer/src/layers-context.tsx](../../packages/app/renderer/src/layers-context.tsx) | implementation/type | [app](../architecture/app.md) | 72 |
| [packages/app/renderer/src/layers.ts](../../packages/app/renderer/src/layers.ts) | implementation/type | [app](../architecture/app.md) | 63 |
| [packages/app/renderer/src/list/index.ts](../../packages/app/renderer/src/list/index.ts) | implementation/type | [app](../architecture/app.md) | 32 |
| [packages/app/renderer/src/list/list-scope.ts](../../packages/app/renderer/src/list/list-scope.ts) | implementation/type | [app](../architecture/app.md) | 21 |
| [packages/app/renderer/src/list/list-window.ts](../../packages/app/renderer/src/list/list-window.ts) | implementation/type | [app](../architecture/app.md) | 230 |
| [packages/app/renderer/src/list/row-height.ts](../../packages/app/renderer/src/list/row-height.ts) | implementation/type | [app](../architecture/app.md) | 42 |
| [packages/app/renderer/src/list/use-list-keys.ts](../../packages/app/renderer/src/list/use-list-keys.ts) | implementation/type | [app](../architecture/app.md) | 59 |
| [packages/app/renderer/src/list/use-list-viewport.ts](../../packages/app/renderer/src/list/use-list-viewport.ts) | implementation/type | [app](../architecture/app.md) | 211 |
| [packages/app/renderer/src/list/virtual-list.tsx](../../packages/app/renderer/src/list/virtual-list.tsx) | implementation/type | [app](../architecture/app.md) | 343 |
| [packages/app/renderer/src/main.tsx](../../packages/app/renderer/src/main.tsx) | implementation/type | [app](../architecture/app.md) | 60 |
| [packages/app/renderer/src/notifications-context.tsx](../../packages/app/renderer/src/notifications-context.tsx) | implementation/type | [app](../architecture/app.md) | 29 |
| [packages/app/renderer/src/notifications.ts](../../packages/app/renderer/src/notifications.ts) | implementation/type | [app](../architecture/app.md) | 114 |
| [packages/app/renderer/src/palette/command-palette.tsx](../../packages/app/renderer/src/palette/command-palette.tsx) | implementation/type | [app](../architecture/app.md) | 418 |
| [packages/app/renderer/src/palette/entries.ts](../../packages/app/renderer/src/palette/entries.ts) | implementation/type | [app](../architecture/app.md) | 160 |
| [packages/app/renderer/src/palette/jump.ts](../../packages/app/renderer/src/palette/jump.ts) | implementation/type | [app](../architecture/app.md) | 39 |
| [packages/app/renderer/src/palette/object-sources.tsx](../../packages/app/renderer/src/palette/object-sources.tsx) | implementation/type | [app](../architecture/app.md) | 196 |
| [packages/app/renderer/src/palette/sources.tsx](../../packages/app/renderer/src/palette/sources.tsx) | implementation/type | [app](../architecture/app.md) | 100 |
| [packages/app/renderer/src/palette/start-run.tsx](../../packages/app/renderer/src/palette/start-run.tsx) | implementation/type | [app](../architecture/app.md) | 81 |
| [packages/app/renderer/src/palette/use-command-palette.ts](../../packages/app/renderer/src/palette/use-command-palette.ts) | implementation/type | [app](../architecture/app.md) | 61 |
| [packages/app/renderer/src/palette/use-source-entries.ts](../../packages/app/renderer/src/palette/use-source-entries.ts) | implementation/type | [app](../architecture/app.md) | 53 |
| [packages/app/renderer/src/palette/use-write-actions.ts](../../packages/app/renderer/src/palette/use-write-actions.ts) | implementation/type | [app](../architecture/app.md) | 75 |
| [packages/app/renderer/src/panes.ts](../../packages/app/renderer/src/panes.ts) | implementation/type | [app](../architecture/app.md) | 309 |
| [packages/app/renderer/src/plan/decision-mode.tsx](../../packages/app/renderer/src/plan/decision-mode.tsx) | implementation/type | [app](../architecture/app.md) | 382 |
| [packages/app/renderer/src/plan/decision-model.ts](../../packages/app/renderer/src/plan/decision-model.ts) | implementation/type | [app](../architecture/app.md) | 58 |
| [packages/app/renderer/src/plan/dependency-graph.tsx](../../packages/app/renderer/src/plan/dependency-graph.tsx) | implementation/type | [app](../architecture/app.md) | 249 |
| [packages/app/renderer/src/plan/deps-mode.tsx](../../packages/app/renderer/src/plan/deps-mode.tsx) | implementation/type | [app](../architecture/app.md) | 163 |
| [packages/app/renderer/src/plan/graph-model.ts](../../packages/app/renderer/src/plan/graph-model.ts) | implementation/type | [app](../architecture/app.md) | 181 |
| [packages/app/renderer/src/plan/index.ts](../../packages/app/renderer/src/plan/index.ts) | implementation/type | [app](../architecture/app.md) | 11 |
| [packages/app/renderer/src/plan/inspector.tsx](../../packages/app/renderer/src/plan/inspector.tsx) | implementation/type | [app](../architecture/app.md) | 150 |
| [packages/app/renderer/src/plan/journal.tsx](../../packages/app/renderer/src/plan/journal.tsx) | implementation/type | [app](../architecture/app.md) | 140 |
| [packages/app/renderer/src/plan/plan-model.ts](../../packages/app/renderer/src/plan/plan-model.ts) | implementation/type | [app](../architecture/app.md) | 251 |
| [packages/app/renderer/src/plan/plan-sidebar.tsx](../../packages/app/renderer/src/plan/plan-sidebar.tsx) | implementation/type | [app](../architecture/app.md) | 124 |
| [packages/app/renderer/src/plan/plan-surface.tsx](../../packages/app/renderer/src/plan/plan-surface.tsx) | implementation/type | [app](../architecture/app.md) | 708 |
| [packages/app/renderer/src/plan/plan.css](../../packages/app/renderer/src/plan/plan.css) | implementation/type | [app](../architecture/app.md) | 359 |
| [packages/app/renderer/src/plan/relationship-inspector.tsx](../../packages/app/renderer/src/plan/relationship-inspector.tsx) | implementation/type | [app](../architecture/app.md) | 153 |
| [packages/app/renderer/src/plan/risk-detail.tsx](../../packages/app/renderer/src/plan/risk-detail.tsx) | implementation/type | [app](../architecture/app.md) | 114 |
| [packages/app/renderer/src/plan/risk-mode.tsx](../../packages/app/renderer/src/plan/risk-mode.tsx) | implementation/type | [app](../architecture/app.md) | 158 |
| [packages/app/renderer/src/plan/risk-model.ts](../../packages/app/renderer/src/plan/risk-model.ts) | implementation/type | [app](../architecture/app.md) | 61 |
| [packages/app/renderer/src/plan/schedule-table.tsx](../../packages/app/renderer/src/plan/schedule-table.tsx) | implementation/type | [app](../architecture/app.md) | 287 |
| [packages/app/renderer/src/plan/use-decision-writes.ts](../../packages/app/renderer/src/plan/use-decision-writes.ts) | implementation/type | [app](../architecture/app.md) | 98 |
| [packages/app/renderer/src/plan/use-decisions.ts](../../packages/app/renderer/src/plan/use-decisions.ts) | implementation/type | [app](../architecture/app.md) | 38 |
| [packages/app/renderer/src/plan/use-dependencies.ts](../../packages/app/renderer/src/plan/use-dependencies.ts) | implementation/type | [app](../architecture/app.md) | 61 |
| [packages/app/renderer/src/plan/use-plan-writes.ts](../../packages/app/renderer/src/plan/use-plan-writes.ts) | implementation/type | [app](../architecture/app.md) | 291 |
| [packages/app/renderer/src/plan/use-plan.ts](../../packages/app/renderer/src/plan/use-plan.ts) | implementation/type | [app](../architecture/app.md) | 406 |
| [packages/app/renderer/src/plan/use-risks.ts](../../packages/app/renderer/src/plan/use-risks.ts) | implementation/type | [app](../architecture/app.md) | 81 |
| [packages/app/renderer/src/preview/preview.css](../../packages/app/renderer/src/preview/preview.css) | implementation/type | [app](../architecture/app.md) | 59 |
| [packages/app/renderer/src/preview/preview.tsx](../../packages/app/renderer/src/preview/preview.tsx) | implementation/type | [app](../architecture/app.md) | 292 |
| [packages/app/renderer/src/preview/type-proof.css](../../packages/app/renderer/src/preview/type-proof.css) | implementation/type | [app](../architecture/app.md) | 135 |
| [packages/app/renderer/src/preview/type-proof.tsx](../../packages/app/renderer/src/preview/type-proof.tsx) | implementation/type | [app](../architecture/app.md) | 331 |
| [packages/app/renderer/src/preview/type-sources.ts](../../packages/app/renderer/src/preview/type-sources.ts) | implementation/type | [app](../architecture/app.md) | 112 |
| [packages/app/renderer/src/route-table.ts](../../packages/app/renderer/src/route-table.ts) | implementation/type | [app](../architecture/app.md) | 304 |
| [packages/app/renderer/src/routes.tsx](../../packages/app/renderer/src/routes.tsx) | implementation/type | [app](../architecture/app.md) | 43 |
| [packages/app/renderer/src/runs/run-rows.ts](../../packages/app/renderer/src/runs/run-rows.ts) | implementation/type | [app](../architecture/app.md) | 87 |
| [packages/app/renderer/src/runs/runs-surface.tsx](../../packages/app/renderer/src/runs/runs-surface.tsx) | implementation/type | [app](../architecture/app.md) | 456 |
| [packages/app/renderer/src/runs/runs.css](../../packages/app/renderer/src/runs/runs.css) | implementation/type | [app](../architecture/app.md) | 210 |
| [packages/app/renderer/src/runs/timeline/timeline-entries.ts](../../packages/app/renderer/src/runs/timeline/timeline-entries.ts) | implementation/type | [app](../architecture/app.md) | 343 |
| [packages/app/renderer/src/runs/timeline/timeline.tsx](../../packages/app/renderer/src/runs/timeline/timeline.tsx) | implementation/type | [app](../architecture/app.md) | 350 |
| [packages/app/renderer/src/runs/timeline/use-run-events.ts](../../packages/app/renderer/src/runs/timeline/use-run-events.ts) | implementation/type | [app](../architecture/app.md) | 209 |
| [packages/app/renderer/src/runs/tree/run-tree.tsx](../../packages/app/renderer/src/runs/tree/run-tree.tsx) | implementation/type | [app](../architecture/app.md) | 336 |
| [packages/app/renderer/src/runs/tree/tree-rows.ts](../../packages/app/renderer/src/runs/tree/tree-rows.ts) | implementation/type | [app](../architecture/app.md) | 471 |
| [packages/app/renderer/src/runs/tree/use-run-tree.ts](../../packages/app/renderer/src/runs/tree/use-run-tree.ts) | implementation/type | [app](../architecture/app.md) | 202 |
| [packages/app/renderer/src/runs/tree/use-tree-keys.ts](../../packages/app/renderer/src/runs/tree/use-tree-keys.ts) | implementation/type | [app](../architecture/app.md) | 81 |
| [packages/app/renderer/src/runs/use-run-selection.ts](../../packages/app/renderer/src/runs/use-run-selection.ts) | implementation/type | [app](../architecture/app.md) | 166 |
| [packages/app/renderer/src/runs/use-runs.ts](../../packages/app/renderer/src/runs/use-runs.ts) | implementation/type | [app](../architecture/app.md) | 118 |
| [packages/app/renderer/src/step/index.ts](../../packages/app/renderer/src/step/index.ts) | implementation/type | [app](../architecture/app.md) | 34 |
| [packages/app/renderer/src/step/line-buffer.ts](../../packages/app/renderer/src/step/line-buffer.ts) | implementation/type | [app](../architecture/app.md) | 427 |
| [packages/app/renderer/src/step/output-pane.tsx](../../packages/app/renderer/src/step/output-pane.tsx) | implementation/type | [app](../architecture/app.md) | 387 |
| [packages/app/renderer/src/step/step-detail.tsx](../../packages/app/renderer/src/step/step-detail.tsx) | implementation/type | [app](../architecture/app.md) | 315 |
| [packages/app/renderer/src/step/step-facts.ts](../../packages/app/renderer/src/step/step-facts.ts) | implementation/type | [app](../architecture/app.md) | 60 |
| [packages/app/renderer/src/step/step.css](../../packages/app/renderer/src/step/step.css) | implementation/type | [app](../architecture/app.md) | 121 |
| [packages/app/renderer/src/step/tool-call-row.tsx](../../packages/app/renderer/src/step/tool-call-row.tsx) | implementation/type | [app](../architecture/app.md) | 86 |
| [packages/app/renderer/src/step/tool-calls.ts](../../packages/app/renderer/src/step/tool-calls.ts) | implementation/type | [app](../architecture/app.md) | 194 |
| [packages/app/renderer/src/step/use-step-log.ts](../../packages/app/renderer/src/step/use-step-log.ts) | implementation/type | [app](../architecture/app.md) | 272 |
| [packages/app/renderer/src/theme.ts](../../packages/app/renderer/src/theme.ts) | implementation/type | [app](../architecture/app.md) | 25 |
| [packages/app/renderer/src/ui/button.tsx](../../packages/app/renderer/src/ui/button.tsx) | implementation/type | [app](../architecture/app.md) | 66 |
| [packages/app/renderer/src/ui/card.tsx](../../packages/app/renderer/src/ui/card.tsx) | implementation/type | [app](../architecture/app.md) | 38 |
| [packages/app/renderer/src/ui/chip.tsx](../../packages/app/renderer/src/ui/chip.tsx) | implementation/type | [app](../architecture/app.md) | 29 |
| [packages/app/renderer/src/ui/config-field.tsx](../../packages/app/renderer/src/ui/config-field.tsx) | implementation/type | [app](../architecture/app.md) | 120 |
| [packages/app/renderer/src/ui/connection-indicator.tsx](../../packages/app/renderer/src/ui/connection-indicator.tsx) | implementation/type | [app](../architecture/app.md) | 83 |
| [packages/app/renderer/src/ui/counterparts.ts](../../packages/app/renderer/src/ui/counterparts.ts) | implementation/type | [app](../architecture/app.md) | 45 |
| [packages/app/renderer/src/ui/decision-matrix.tsx](../../packages/app/renderer/src/ui/decision-matrix.tsx) | implementation/type | [app](../architecture/app.md) | 127 |
| [packages/app/renderer/src/ui/dependency-node.tsx](../../packages/app/renderer/src/ui/dependency-node.tsx) | implementation/type | [app](../architecture/app.md) | 92 |
| [packages/app/renderer/src/ui/format-time.ts](../../packages/app/renderer/src/ui/format-time.ts) | implementation/type | [app](../architecture/app.md) | 63 |
| [packages/app/renderer/src/ui/index.ts](../../packages/app/renderer/src/ui/index.ts) | implementation/type | [app](../architecture/app.md) | 52 |
| [packages/app/renderer/src/ui/menu-placement.ts](../../packages/app/renderer/src/ui/menu-placement.ts) | implementation/type | [app](../architecture/app.md) | 71 |
| [packages/app/renderer/src/ui/menu.tsx](../../packages/app/renderer/src/ui/menu.tsx) | implementation/type | [app](../architecture/app.md) | 418 |
| [packages/app/renderer/src/ui/object-header.tsx](../../packages/app/renderer/src/ui/object-header.tsx) | implementation/type | [app](../architecture/app.md) | 221 |
| [packages/app/renderer/src/ui/risk-matrix.tsx](../../packages/app/renderer/src/ui/risk-matrix.tsx) | implementation/type | [app](../architecture/app.md) | 135 |
| [packages/app/renderer/src/ui/schedule-badge.tsx](../../packages/app/renderer/src/ui/schedule-badge.tsx) | implementation/type | [app](../architecture/app.md) | 73 |
| [packages/app/renderer/src/ui/state-view.tsx](../../packages/app/renderer/src/ui/state-view.tsx) | implementation/type | [app](../architecture/app.md) | 65 |
| [packages/app/renderer/src/ui/status-chip.tsx](../../packages/app/renderer/src/ui/status-chip.tsx) | implementation/type | [app](../architecture/app.md) | 50 |
| [packages/app/renderer/src/ui/status-dot.tsx](../../packages/app/renderer/src/ui/status-dot.tsx) | implementation/type | [app](../architecture/app.md) | 28 |
| [packages/app/renderer/src/ui/text.tsx](../../packages/app/renderer/src/ui/text.tsx) | implementation/type | [app](../architecture/app.md) | 31 |
| [packages/app/renderer/src/ui/ticker.ts](../../packages/app/renderer/src/ui/ticker.ts) | implementation/type | [app](../architecture/app.md) | 44 |
| [packages/app/renderer/src/ui/time.tsx](../../packages/app/renderer/src/ui/time.tsx) | implementation/type | [app](../architecture/app.md) | 61 |
| [packages/app/renderer/src/ui/well.tsx](../../packages/app/renderer/src/ui/well.tsx) | implementation/type | [app](../architecture/app.md) | 32 |
| [packages/app/renderer/src/ui/workflow-node.tsx](../../packages/app/renderer/src/ui/workflow-node.tsx) | implementation/type | [app](../architecture/app.md) | 264 |
| [packages/app/renderer/src/update-drafts.ts](../../packages/app/renderer/src/update-drafts.ts) | implementation/type | [app](../architecture/app.md) | 16 |
| [packages/app/renderer/src/window.d.ts](../../packages/app/renderer/src/window.d.ts) | implementation/type | [app](../architecture/app.md) | 12 |
| [packages/app/renderer/src/workflow/index.ts](../../packages/app/renderer/src/workflow/index.ts) | implementation/type | [app](../architecture/app.md) | 13 |
| [packages/app/renderer/src/workflow/layout.ts](../../packages/app/renderer/src/workflow/layout.ts) | implementation/type | [app](../architecture/app.md) | 448 |
| [packages/app/renderer/src/workflow/use-workflow.ts](../../packages/app/renderer/src/workflow/use-workflow.ts) | implementation/type | [app](../architecture/app.md) | 191 |
| [packages/app/renderer/src/workflow/workflow-canvas.tsx](../../packages/app/renderer/src/workflow/workflow-canvas.tsx) | implementation/type | [app](../architecture/app.md) | 400 |
| [packages/app/renderer/src/workflow/workflow-surface.tsx](../../packages/app/renderer/src/workflow/workflow-surface.tsx) | implementation/type | [app](../architecture/app.md) | 279 |
| [packages/app/renderer/src/workflow/workflow.css](../../packages/app/renderer/src/workflow/workflow.css) | implementation/type | [app](../architecture/app.md) | 145 |
| [packages/app/renderer/test/a11y-sweep.test.tsx](../../packages/app/renderer/test/a11y-sweep.test.tsx) | test source/fixture | [app](../architecture/app.md) | 773 |
| [packages/app/renderer/test/agent-groups.test.ts](../../packages/app/renderer/test/agent-groups.test.ts) | test source/fixture | [app](../architecture/app.md) | 80 |
| [packages/app/renderer/test/agents-surface.test.tsx](../../packages/app/renderer/test/agents-surface.test.tsx) | test source/fixture | [app](../architecture/app.md) | 272 |
| [packages/app/renderer/test/agents-write.test.tsx](../../packages/app/renderer/test/agents-write.test.tsx) | test source/fixture | [app](../architecture/app.md) | 338 |
| [packages/app/renderer/test/announcements.test.ts](../../packages/app/renderer/test/announcements.test.ts) | test source/fixture | [app](../architecture/app.md) | 158 |
| [packages/app/renderer/test/artifact-panel.test.tsx](../../packages/app/renderer/test/artifact-panel.test.tsx) | test source/fixture | [app](../architecture/app.md) | 223 |
| [packages/app/renderer/test/attention-cards.test.tsx](../../packages/app/renderer/test/attention-cards.test.tsx) | test source/fixture | [app](../architecture/app.md) | 307 |
| [packages/app/renderer/test/attention-model.test.ts](../../packages/app/renderer/test/attention-model.test.ts) | test source/fixture | [app](../architecture/app.md) | 179 |
| [packages/app/renderer/test/attention-surface.test.tsx](../../packages/app/renderer/test/attention-surface.test.tsx) | test source/fixture | [app](../architecture/app.md) | 513 |
| [packages/app/renderer/test/command-palette.test.tsx](../../packages/app/renderer/test/command-palette.test.tsx) | test source/fixture | [app](../architecture/app.md) | 269 |
| [packages/app/renderer/test/config-model.test.ts](../../packages/app/renderer/test/config-model.test.ts) | test source/fixture | [app](../architecture/app.md) | 217 |
| [packages/app/renderer/test/config-surface.test.tsx](../../packages/app/renderer/test/config-surface.test.tsx) | test source/fixture | [app](../architecture/app.md) | 647 |
| [packages/app/renderer/test/connection-states.test.tsx](../../packages/app/renderer/test/connection-states.test.tsx) | test source/fixture | [app](../architecture/app.md) | 207 |
| [packages/app/renderer/test/diff.test.ts](../../packages/app/renderer/test/diff.test.ts) | test source/fixture | [app](../architecture/app.md) | 196 |
| [packages/app/renderer/test/entry-points.test.tsx](../../packages/app/renderer/test/entry-points.test.tsx) | test source/fixture | [app](../architecture/app.md) | 341 |
| [packages/app/renderer/test/fake-bridge.test.ts](../../packages/app/renderer/test/fake-bridge.test.ts) | test source/fixture | [app](../architecture/app.md) | 303 |
| [packages/app/renderer/test/fake-bridge.ts](../../packages/app/renderer/test/fake-bridge.ts) | test source/fixture | [app](../architecture/app.md) | 886 |
| [packages/app/renderer/test/fixtures-agents.ts](../../packages/app/renderer/test/fixtures-agents.ts) | test source/fixture | [app](../architecture/app.md) | 91 |
| [packages/app/renderer/test/fixtures-artifacts.ts](../../packages/app/renderer/test/fixtures-artifacts.ts) | test source/fixture | [app](../architecture/app.md) | 160 |
| [packages/app/renderer/test/fixtures-config.ts](../../packages/app/renderer/test/fixtures-config.ts) | test source/fixture | [app](../architecture/app.md) | 157 |
| [packages/app/renderer/test/fixtures-events.ts](../../packages/app/renderer/test/fixtures-events.ts) | test source/fixture | [app](../architecture/app.md) | 181 |
| [packages/app/renderer/test/fixtures-inputs.ts](../../packages/app/renderer/test/fixtures-inputs.ts) | test source/fixture | [app](../architecture/app.md) | 102 |
| [packages/app/renderer/test/fixtures-plan.ts](../../packages/app/renderer/test/fixtures-plan.ts) | test source/fixture | [app](../architecture/app.md) | 512 |
| [packages/app/renderer/test/fixtures-workflows.ts](../../packages/app/renderer/test/fixtures-workflows.ts) | test source/fixture | [app](../architecture/app.md) | 354 |
| [packages/app/renderer/test/fixtures.ts](../../packages/app/renderer/test/fixtures.ts) | test source/fixture | [app](../architecture/app.md) | 520 |
| [packages/app/renderer/test/focus-and-selection.test.ts](../../packages/app/renderer/test/focus-and-selection.test.ts) | test source/fixture | [app](../architecture/app.md) | 215 |
| [packages/app/renderer/test/format-time.test.tsx](../../packages/app/renderer/test/format-time.test.tsx) | test source/fixture | [app](../architecture/app.md) | 70 |
| [packages/app/renderer/test/harness.tsx](../../packages/app/renderer/test/harness.tsx) | test source/fixture | [app](../architecture/app.md) | 173 |
| [packages/app/renderer/test/inline-asks.test.tsx](../../packages/app/renderer/test/inline-asks.test.tsx) | test source/fixture | [app](../architecture/app.md) | 83 |
| [packages/app/renderer/test/keyboard-map-agreement.test.tsx](../../packages/app/renderer/test/keyboard-map-agreement.test.tsx) | test source/fixture | [app](../architecture/app.md) | 359 |
| [packages/app/renderer/test/keyboard-map.test.ts](../../packages/app/renderer/test/keyboard-map.test.ts) | test source/fixture | [app](../architecture/app.md) | 202 |
| [packages/app/renderer/test/layers.test.ts](../../packages/app/renderer/test/layers.test.ts) | test source/fixture | [app](../architecture/app.md) | 61 |
| [packages/app/renderer/test/line-buffer.test.ts](../../packages/app/renderer/test/line-buffer.test.ts) | test source/fixture | [app](../architecture/app.md) | 269 |
| [packages/app/renderer/test/list-window.test.ts](../../packages/app/renderer/test/list-window.test.ts) | test source/fixture | [app](../architecture/app.md) | 265 |
| [packages/app/renderer/test/menu.test.tsx](../../packages/app/renderer/test/menu.test.tsx) | test source/fixture | [app](../architecture/app.md) | 346 |
| [packages/app/renderer/test/palette-writes.test.tsx](../../packages/app/renderer/test/palette-writes.test.tsx) | test source/fixture | [app](../architecture/app.md) | 482 |
| [packages/app/renderer/test/pane-splitter.test.tsx](../../packages/app/renderer/test/pane-splitter.test.tsx) | test source/fixture | [app](../architecture/app.md) | 335 |
| [packages/app/renderer/test/panes.test.ts](../../packages/app/renderer/test/panes.test.ts) | test source/fixture | [app](../architecture/app.md) | 203 |
| [packages/app/renderer/test/plan-decision.test.tsx](../../packages/app/renderer/test/plan-decision.test.tsx) | test source/fixture | [app](../architecture/app.md) | 321 |
| [packages/app/renderer/test/plan-graph.test.tsx](../../packages/app/renderer/test/plan-graph.test.tsx) | test source/fixture | [app](../architecture/app.md) | 495 |
| [packages/app/renderer/test/plan-model.test.ts](../../packages/app/renderer/test/plan-model.test.ts) | test source/fixture | [app](../architecture/app.md) | 199 |
| [packages/app/renderer/test/plan-risk.test.tsx](../../packages/app/renderer/test/plan-risk.test.tsx) | test source/fixture | [app](../architecture/app.md) | 199 |
| [packages/app/renderer/test/plan-surface.test.tsx](../../packages/app/renderer/test/plan-surface.test.tsx) | test source/fixture | [app](../architecture/app.md) | 711 |
| [packages/app/renderer/test/policy-editor.test.tsx](../../packages/app/renderer/test/policy-editor.test.tsx) | test source/fixture | [app](../architecture/app.md) | 502 |
| [packages/app/renderer/test/preview.test.tsx](../../packages/app/renderer/test/preview.test.tsx) | test source/fixture | [app](../architecture/app.md) | 28 |
| [packages/app/renderer/test/primitives.test.tsx](../../packages/app/renderer/test/primitives.test.tsx) | test source/fixture | [app](../architecture/app.md) | 240 |
| [packages/app/renderer/test/reconciliation.test.tsx](../../packages/app/renderer/test/reconciliation.test.tsx) | test source/fixture | [app](../architecture/app.md) | 504 |
| [packages/app/renderer/test/route-table.test.ts](../../packages/app/renderer/test/route-table.test.ts) | test source/fixture | [app](../architecture/app.md) | 195 |
| [packages/app/renderer/test/run-rows.test.ts](../../packages/app/renderer/test/run-rows.test.ts) | test source/fixture | [app](../architecture/app.md) | 119 |
| [packages/app/renderer/test/run-selection.test.ts](../../packages/app/renderer/test/run-selection.test.ts) | test source/fixture | [app](../architecture/app.md) | 107 |
| [packages/app/renderer/test/run-tree.test.tsx](../../packages/app/renderer/test/run-tree.test.tsx) | test source/fixture | [app](../architecture/app.md) | 380 |
| [packages/app/renderer/test/runs-surface.test.tsx](../../packages/app/renderer/test/runs-surface.test.tsx) | test source/fixture | [app](../architecture/app.md) | 399 |
| [packages/app/renderer/test/scroll-sweep.test.tsx](../../packages/app/renderer/test/scroll-sweep.test.tsx) | test source/fixture | [app](../architecture/app.md) | 221 |
| [packages/app/renderer/test/sidebar.test.tsx](../../packages/app/renderer/test/sidebar.test.tsx) | test source/fixture | [app](../architecture/app.md) | 95 |
| [packages/app/renderer/test/step-detail.test.tsx](../../packages/app/renderer/test/step-detail.test.tsx) | test source/fixture | [app](../architecture/app.md) | 580 |
| [packages/app/renderer/test/themes.test.tsx](../../packages/app/renderer/test/themes.test.tsx) | test source/fixture | [app](../architecture/app.md) | 67 |
| [packages/app/renderer/test/themes.tsx](../../packages/app/renderer/test/themes.tsx) | test source/fixture | [app](../architecture/app.md) | 161 |
| [packages/app/renderer/test/timeline-entries.test.ts](../../packages/app/renderer/test/timeline-entries.test.ts) | test source/fixture | [app](../architecture/app.md) | 549 |
| [packages/app/renderer/test/timeline.test.tsx](../../packages/app/renderer/test/timeline.test.tsx) | test source/fixture | [app](../architecture/app.md) | 293 |
| [packages/app/renderer/test/tool-calls.test.ts](../../packages/app/renderer/test/tool-calls.test.ts) | test source/fixture | [app](../architecture/app.md) | 127 |
| [packages/app/renderer/test/tree-rows.test.ts](../../packages/app/renderer/test/tree-rows.test.ts) | test source/fixture | [app](../architecture/app.md) | 227 |
| [packages/app/renderer/test/type-classes.test.tsx](../../packages/app/renderer/test/type-classes.test.tsx) | test source/fixture | [app](../architecture/app.md) | 151 |
| [packages/app/renderer/test/type-notes.ts](../../packages/app/renderer/test/type-notes.ts) | test source/fixture | [app](../architecture/app.md) | 110 |
| [packages/app/renderer/test/type-proof.test.tsx](../../packages/app/renderer/test/type-proof.test.tsx) | test source/fixture | [app](../architecture/app.md) | 143 |
| [packages/app/renderer/test/update-control.test.tsx](../../packages/app/renderer/test/update-control.test.tsx) | test source/fixture | [app](../architecture/app.md) | 64 |
| [packages/app/renderer/test/virtual-list.test.tsx](../../packages/app/renderer/test/virtual-list.test.tsx) | test source/fixture | [app](../architecture/app.md) | 537 |
| [packages/app/renderer/test/window-chrome.test.tsx](../../packages/app/renderer/test/window-chrome.test.tsx) | test source/fixture | [app](../architecture/app.md) | 139 |
| [packages/app/renderer/test/workflow-layout.test.ts](../../packages/app/renderer/test/workflow-layout.test.ts) | test source/fixture | [app](../architecture/app.md) | 340 |
| [packages/app/renderer/test/workflow-surface.test.tsx](../../packages/app/renderer/test/workflow-surface.test.tsx) | test source/fixture | [app](../architecture/app.md) | 373 |
| [packages/app/renderer/tsconfig.json](../../packages/app/renderer/tsconfig.json) | configuration/tool/asset | [app](../architecture/app.md) | 33 |
| [packages/app/scripts/build-daemon.js](../../packages/app/scripts/build-daemon.js) | configuration/tool/asset | [app](../architecture/app.md) | 97 |
| [packages/app/scripts/dev.js](../../packages/app/scripts/dev.js) | configuration/tool/asset | [app](../architecture/app.md) | 63 |
| [packages/app/src/bridge.ts](../../packages/app/src/bridge.ts) | implementation/type | [app](../architecture/app.md) | 458 |
| [packages/app/src/client/daemon-client.ts](../../packages/app/src/client/daemon-client.ts) | implementation/type | [app](../architecture/app.md) | 402 |
| [packages/app/src/client/subscription.ts](../../packages/app/src/client/subscription.ts) | implementation/type | [app](../architecture/app.md) | 234 |
| [packages/app/src/main/alerts.ts](../../packages/app/src/main/alerts.ts) | implementation/type | [app](../architecture/app.md) | 214 |
| [packages/app/src/main/app-menu.ts](../../packages/app/src/main/app-menu.ts) | implementation/type | [app](../architecture/app.md) | 99 |
| [packages/app/src/main/connection-state.ts](../../packages/app/src/main/connection-state.ts) | implementation/type | [app](../architecture/app.md) | 337 |
| [packages/app/src/main/daemon-process.ts](../../packages/app/src/main/daemon-process.ts) | implementation/type | [app](../architecture/app.md) | 345 |
| [packages/app/src/main/deep-link.ts](../../packages/app/src/main/deep-link.ts) | implementation/type | [app](../architecture/app.md) | 88 |
| [packages/app/src/main/index.ts](../../packages/app/src/main/index.ts) | implementation/type | [app](../architecture/app.md) | 574 |
| [packages/app/src/main/update-driver.ts](../../packages/app/src/main/update-driver.ts) | implementation/type | [app](../architecture/app.md) | 65 |
| [packages/app/src/main/update-ipc.ts](../../packages/app/src/main/update-ipc.ts) | implementation/type | [app](../architecture/app.md) | 33 |
| [packages/app/src/main/updates.ts](../../packages/app/src/main/updates.ts) | implementation/type | [app](../architecture/app.md) | 79 |
| [packages/app/src/main/workspace.ts](../../packages/app/src/main/workspace.ts) | implementation/type | [app](../architecture/app.md) | 311 |
| [packages/app/src/preferences/preferences-file.ts](../../packages/app/src/preferences/preferences-file.ts) | implementation/type | [app](../architecture/app.md) | 47 |
| [packages/app/src/preferences/schema.ts](../../packages/app/src/preferences/schema.ts) | implementation/type | [app](../architecture/app.md) | 145 |
| [packages/app/src/preload/index.cts](../../packages/app/src/preload/index.cts) | implementation/type | [app](../architecture/app.md) | 174 |
| [packages/app/src/update-contract.ts](../../packages/app/src/update-contract.ts) | implementation/type | [app](../architecture/app.md) | 10 |
| [packages/app/test/alerts.test.ts](../../packages/app/test/alerts.test.ts) | test source/fixture | [app](../architecture/app.md) | 264 |
| [packages/app/test/app-menu.test.ts](../../packages/app/test/app-menu.test.ts) | test source/fixture | [app](../architecture/app.md) | 60 |
| [packages/app/test/appearance.test.ts](../../packages/app/test/appearance.test.ts) | test source/fixture | [app](../architecture/app.md) | 321 |
| [packages/app/test/connection.test.ts](../../packages/app/test/connection.test.ts) | test source/fixture | [app](../architecture/app.md) | 382 |
| [packages/app/test/daemon-client.test.ts](../../packages/app/test/daemon-client.test.ts) | test source/fixture | [app](../architecture/app.md) | 737 |
| [packages/app/test/daemon-process.test.ts](../../packages/app/test/daemon-process.test.ts) | test source/fixture | [app](../architecture/app.md) | 271 |
| [packages/app/test/deep-link.test.ts](../../packages/app/test/deep-link.test.ts) | test source/fixture | [app](../architecture/app.md) | 95 |
| [packages/app/test/notifications.test.ts](../../packages/app/test/notifications.test.ts) | test source/fixture | [app](../architecture/app.md) | 384 |
| [packages/app/test/preferences.test.ts](../../packages/app/test/preferences.test.ts) | test source/fixture | [app](../architecture/app.md) | 133 |
| [packages/app/test/smoke/app-shell.spec.ts](../../packages/app/test/smoke/app-shell.spec.ts) | test source/fixture | [app](../architecture/app.md) | 615 |
| [packages/app/test/smoke/daemon.ts](../../packages/app/test/smoke/daemon.ts) | test source/fixture | [app](../architecture/app.md) | 352 |
| [packages/app/test/smoke/playwright.config.ts](../../packages/app/test/smoke/playwright.config.ts) | test source/fixture | [app](../architecture/app.md) | 90 |
| [packages/app/test/smoke/type-proof.spec.ts](../../packages/app/test/smoke/type-proof.spec.ts) | test source/fixture | [app](../architecture/app.md) | 400 |
| [packages/app/test/update-driver.test.ts](../../packages/app/test/update-driver.test.ts) | test source/fixture | [app](../architecture/app.md) | 78 |
| [packages/app/test/updates.test.ts](../../packages/app/test/updates.test.ts) | test source/fixture | [app](../architecture/app.md) | 128 |
| [packages/app/test/workspace.test.ts](../../packages/app/test/workspace.test.ts) | test source/fixture | [app](../architecture/app.md) | 297 |
| [packages/app/tsconfig.json](../../packages/app/tsconfig.json) | configuration/tool/asset | [app](../architecture/app.md) | 6 |
| [packages/app/tsconfig.preload.json](../../packages/app/tsconfig.preload.json) | configuration/tool/asset | [app](../architecture/app.md) | 30 |
| [packages/app/vite.config.ts](../../packages/app/vite.config.ts) | implementation/type | [app](../architecture/app.md) | 92 |
| [packages/cli/package.json](../../packages/cli/package.json) | configuration/tool/asset | [cli](../architecture/cli.md) | 31 |
| [packages/cli/src/bootstrap.ts](../../packages/cli/src/bootstrap.ts) | implementation/type | [cli](../architecture/cli.md) | 286 |
| [packages/cli/src/commands/claims.ts](../../packages/cli/src/commands/claims.ts) | implementation/type | [cli](../architecture/cli.md) | 63 |
| [packages/cli/src/commands/index.ts](../../packages/cli/src/commands/index.ts) | implementation/type | [cli](../architecture/cli.md) | 965 |
| [packages/cli/src/commands/leases.ts](../../packages/cli/src/commands/leases.ts) | implementation/type | [cli](../architecture/cli.md) | 67 |
| [packages/cli/src/commands/plan.ts](../../packages/cli/src/commands/plan.ts) | implementation/type | [cli](../architecture/cli.md) | 375 |
| [packages/cli/src/commands/selection.ts](../../packages/cli/src/commands/selection.ts) | implementation/type | [cli](../architecture/cli.md) | 186 |
| [packages/cli/src/format.ts](../../packages/cli/src/format.ts) | implementation/type | [cli](../architecture/cli.md) | 164 |
| [packages/cli/src/human-input-cli.ts](../../packages/cli/src/human-input-cli.ts) | implementation/type | [cli](../architecture/cli.md) | 40 |
| [packages/cli/src/index.ts](../../packages/cli/src/index.ts) | implementation/type | [cli](../architecture/cli.md) | 6 |
| [packages/cli/src/main.ts](../../packages/cli/src/main.ts) | implementation/type | [cli](../architecture/cli.md) | 137 |
| [packages/cli/test/answer.test.ts](../../packages/cli/test/answer.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 118 |
| [packages/cli/test/bootstrap.test.ts](../../packages/cli/test/bootstrap.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 279 |
| [packages/cli/test/claims.test.ts](../../packages/cli/test/claims.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 104 |
| [packages/cli/test/commands.test.ts](../../packages/cli/test/commands.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 283 |
| [packages/cli/test/demo.test.ts](../../packages/cli/test/demo.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 108 |
| [packages/cli/test/format.test.ts](../../packages/cli/test/format.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 287 |
| [packages/cli/test/human-input-cli.test.ts](../../packages/cli/test/human-input-cli.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 84 |
| [packages/cli/test/leases.test.ts](../../packages/cli/test/leases.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 100 |
| [packages/cli/test/main.test.ts](../../packages/cli/test/main.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 147 |
| [packages/cli/test/plan.test.ts](../../packages/cli/test/plan.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 406 |
| [packages/cli/test/release-assets.test.ts](../../packages/cli/test/release-assets.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 29 |
| [packages/cli/test/selection.test.ts](../../packages/cli/test/selection.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 236 |
| [packages/cli/test/submit-settlement.test.ts](../../packages/cli/test/submit-settlement.test.ts) | test source/fixture | [cli](../architecture/cli.md) | 66 |
| [packages/cli/tsconfig.json](../../packages/cli/tsconfig.json) | configuration/tool/asset | [cli](../architecture/cli.md) | 15 |
| [packages/core/package.json](../../packages/core/package.json) | configuration/tool/asset | [core](../architecture/core.md) | 25 |
| [packages/core/src/config.ts](../../packages/core/src/config.ts) | implementation/type | [core](../architecture/core.md) | 91 |
| [packages/core/src/errors.ts](../../packages/core/src/errors.ts) | implementation/type | [core](../architecture/core.md) | 81 |
| [packages/core/src/events/events.ts](../../packages/core/src/events/events.ts) | implementation/type | [core](../architecture/core.md) | 317 |
| [packages/core/src/events/reduce.ts](../../packages/core/src/events/reduce.ts) | implementation/type | [core](../architecture/core.md) | 374 |
| [packages/core/src/expr/ast.ts](../../packages/core/src/expr/ast.ts) | implementation/type | [core](../architecture/core.md) | 11 |
| [packages/core/src/expr/evaluate.ts](../../packages/core/src/expr/evaluate.ts) | implementation/type | [core](../architecture/core.md) | 178 |
| [packages/core/src/expr/index.ts](../../packages/core/src/expr/index.ts) | implementation/type | [core](../architecture/core.md) | 11 |
| [packages/core/src/expr/lexer.ts](../../packages/core/src/expr/lexer.ts) | implementation/type | [core](../architecture/core.md) | 82 |
| [packages/core/src/expr/parser.ts](../../packages/core/src/expr/parser.ts) | implementation/type | [core](../architecture/core.md) | 176 |
| [packages/core/src/ids.ts](../../packages/core/src/ids.ts) | implementation/type | [core](../architecture/core.md) | 70 |
| [packages/core/src/index.ts](../../packages/core/src/index.ts) | implementation/type | [core](../architecture/core.md) | 23 |
| [packages/core/src/model/agent.ts](../../packages/core/src/model/agent.ts) | implementation/type | [core](../architecture/core.md) | 595 |
| [packages/core/src/model/artifact.ts](../../packages/core/src/model/artifact.ts) | implementation/type | [core](../architecture/core.md) | 109 |
| [packages/core/src/model/plan-events.ts](../../packages/core/src/model/plan-events.ts) | implementation/type | [core](../architecture/core.md) | 92 |
| [packages/core/src/model/plan.ts](../../packages/core/src/model/plan.ts) | implementation/type | [core](../architecture/core.md) | 525 |
| [packages/core/src/model/request.ts](../../packages/core/src/model/request.ts) | implementation/type | [core](../architecture/core.md) | 127 |
| [packages/core/src/model/run.ts](../../packages/core/src/model/run.ts) | implementation/type | [core](../architecture/core.md) | 253 |
| [packages/core/src/model/workflow.ts](../../packages/core/src/model/workflow.ts) | implementation/type | [core](../architecture/core.md) | 376 |
| [packages/core/src/plan/decision-matrix.ts](../../packages/core/src/plan/decision-matrix.ts) | implementation/type | [core](../architecture/core.md) | 119 |
| [packages/core/src/plan/graph.ts](../../packages/core/src/plan/graph.ts) | implementation/type | [core](../architecture/core.md) | 290 |
| [packages/core/src/plan/index.ts](../../packages/core/src/plan/index.ts) | implementation/type | [core](../architecture/core.md) | 7 |
| [packages/core/src/plan/mermaid.ts](../../packages/core/src/plan/mermaid.ts) | implementation/type | [core](../architecture/core.md) | 80 |
| [packages/core/src/plan/risk.ts](../../packages/core/src/plan/risk.ts) | implementation/type | [core](../architecture/core.md) | 121 |
| [packages/core/src/plan/schedule.ts](../../packages/core/src/plan/schedule.ts) | implementation/type | [core](../architecture/core.md) | 569 |
| [packages/core/src/plan/signals.ts](../../packages/core/src/plan/signals.ts) | implementation/type | [core](../architecture/core.md) | 143 |
| [packages/core/src/schemas.ts](../../packages/core/src/schemas.ts) | implementation/type | [core](../architecture/core.md) | 27 |
| [packages/core/src/template/deliverables.ts](../../packages/core/src/template/deliverables.ts) | implementation/type | [core](../architecture/core.md) | 56 |
| [packages/core/src/template/index.ts](../../packages/core/src/template/index.ts) | implementation/type | [core](../architecture/core.md) | 9 |
| [packages/core/src/template/load.ts](../../packages/core/src/template/load.ts) | implementation/type | [core](../architecture/core.md) | 12 |
| [packages/core/src/template/registry.ts](../../packages/core/src/template/registry.ts) | implementation/type | [core](../architecture/core.md) | 97 |
| [packages/core/src/template/render.ts](../../packages/core/src/template/render.ts) | implementation/type | [core](../architecture/core.md) | 155 |
| [packages/core/src/util/clock.ts](../../packages/core/src/util/clock.ts) | implementation/type | [core](../architecture/core.md) | 23 |
| [packages/core/src/util/frontmatter.ts](../../packages/core/src/util/frontmatter.ts) | implementation/type | [core](../architecture/core.md) | 42 |
| [packages/core/src/util/glob.ts](../../packages/core/src/util/glob.ts) | implementation/type | [core](../architecture/core.md) | 27 |
| [packages/core/src/util/hash.ts](../../packages/core/src/util/hash.ts) | implementation/type | [core](../architecture/core.md) | 6 |
| [packages/core/src/util/jsonl.ts](../../packages/core/src/util/jsonl.ts) | implementation/type | [core](../architecture/core.md) | 99 |
| [packages/core/src/util/logger.ts](../../packages/core/src/util/logger.ts) | implementation/type | [core](../architecture/core.md) | 43 |
| [packages/core/src/util/path-get.ts](../../packages/core/src/util/path-get.ts) | implementation/type | [core](../architecture/core.md) | 16 |
| [packages/core/src/workflow/graph.ts](../../packages/core/src/workflow/graph.ts) | implementation/type | [core](../architecture/core.md) | 53 |
| [packages/core/src/workflow/index.ts](../../packages/core/src/workflow/index.ts) | implementation/type | [core](../architecture/core.md) | 4 |
| [packages/core/src/workflow/load.ts](../../packages/core/src/workflow/load.ts) | implementation/type | [core](../architecture/core.md) | 62 |
| [packages/core/src/workflow/validate.ts](../../packages/core/src/workflow/validate.ts) | implementation/type | [core](../architecture/core.md) | 242 |
| [packages/core/src/workflow/vars.ts](../../packages/core/src/workflow/vars.ts) | implementation/type | [core](../architecture/core.md) | 25 |
| [packages/core/test/events.test.ts](../../packages/core/test/events.test.ts) | test source/fixture | [core](../architecture/core.md) | 196 |
| [packages/core/test/expr.test.ts](../../packages/core/test/expr.test.ts) | test source/fixture | [core](../architecture/core.md) | 55 |
| [packages/core/test/jsonl.test.ts](../../packages/core/test/jsonl.test.ts) | test source/fixture | [core](../architecture/core.md) | 60 |
| [packages/core/test/load.test.ts](../../packages/core/test/load.test.ts) | test source/fixture | [core](../architecture/core.md) | 68 |
| [packages/core/test/permission-paths.test.ts](../../packages/core/test/permission-paths.test.ts) | test source/fixture | [core](../architecture/core.md) | 17 |
| [packages/core/test/plan.test.ts](../../packages/core/test/plan.test.ts) | test source/fixture | [core](../architecture/core.md) | 1093 |
| [packages/core/test/reduce.test.ts](../../packages/core/test/reduce.test.ts) | test source/fixture | [core](../architecture/core.md) | 227 |
| [packages/core/test/template-packs.test.ts](../../packages/core/test/template-packs.test.ts) | test source/fixture | [core](../architecture/core.md) | 51 |
| [packages/core/test/template.test.ts](../../packages/core/test/template.test.ts) | test source/fixture | [core](../architecture/core.md) | 46 |
| [packages/core/test/workflow.test.ts](../../packages/core/test/workflow.test.ts) | test source/fixture | [core](../architecture/core.md) | 166 |
| [packages/core/tsconfig.json](../../packages/core/tsconfig.json) | configuration/tool/asset | [core](../architecture/core.md) | 6 |
| [packages/daemon/package.json](../../packages/daemon/package.json) | configuration/tool/asset | [daemon](../architecture/daemon.md) | 30 |
| [packages/daemon/src/agent-model.ts](../../packages/daemon/src/agent-model.ts) | implementation/type | [daemon](../architecture/daemon.md) | 146 |
| [packages/daemon/src/config-model.ts](../../packages/daemon/src/config-model.ts) | implementation/type | [daemon](../architecture/daemon.md) | 456 |
| [packages/daemon/src/config-schema.ts](../../packages/daemon/src/config-schema.ts) | implementation/type | [daemon](../architecture/daemon.md) | 228 |
| [packages/daemon/src/control.ts](../../packages/daemon/src/control.ts) | implementation/type | [daemon](../architecture/daemon.md) | 433 |
| [packages/daemon/src/index.ts](../../packages/daemon/src/index.ts) | implementation/type | [daemon](../architecture/daemon.md) | 26 |
| [packages/daemon/src/maintenance.ts](../../packages/daemon/src/maintenance.ts) | implementation/type | [daemon](../architecture/daemon.md) | 56 |
| [packages/daemon/src/methods.ts](../../packages/daemon/src/methods.ts) | implementation/type | [daemon](../architecture/daemon.md) | 622 |
| [packages/daemon/src/notifications.ts](../../packages/daemon/src/notifications.ts) | implementation/type | [daemon](../architecture/daemon.md) | 215 |
| [packages/daemon/src/plan-control.ts](../../packages/daemon/src/plan-control.ts) | implementation/type | [daemon](../architecture/daemon.md) | 186 |
| [packages/daemon/src/plan-model.ts](../../packages/daemon/src/plan-model.ts) | implementation/type | [daemon](../architecture/daemon.md) | 680 |
| [packages/daemon/src/read-model.ts](../../packages/daemon/src/read-model.ts) | implementation/type | [daemon](../architecture/daemon.md) | 860 |
| [packages/daemon/src/server.ts](../../packages/daemon/src/server.ts) | implementation/type | [daemon](../architecture/daemon.md) | 159 |
| [packages/daemon/src/socket.ts](../../packages/daemon/src/socket.ts) | implementation/type | [daemon](../architecture/daemon.md) | 148 |
| [packages/daemon/src/subscriptions.ts](../../packages/daemon/src/subscriptions.ts) | implementation/type | [daemon](../architecture/daemon.md) | 332 |
| [packages/daemon/src/workflow-model.ts](../../packages/daemon/src/workflow-model.ts) | implementation/type | [daemon](../architecture/daemon.md) | 204 |
| [packages/daemon/test/config-methods.test.ts](../../packages/daemon/test/config-methods.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 642 |
| [packages/daemon/test/control-methods.test.ts](../../packages/daemon/test/control-methods.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 606 |
| [packages/daemon/test/fixture.ts](../../packages/daemon/test/fixture.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 415 |
| [packages/daemon/test/maintenance.test.ts](../../packages/daemon/test/maintenance.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 108 |
| [packages/daemon/test/plan-fixture.ts](../../packages/daemon/test/plan-fixture.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 192 |
| [packages/daemon/test/plan-methods.test.ts](../../packages/daemon/test/plan-methods.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 495 |
| [packages/daemon/test/read-methods.test.ts](../../packages/daemon/test/read-methods.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 669 |
| [packages/daemon/test/server.test.ts](../../packages/daemon/test/server.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 97 |
| [packages/daemon/test/socket.test.ts](../../packages/daemon/test/socket.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 382 |
| [packages/daemon/test/workflow-methods.test.ts](../../packages/daemon/test/workflow-methods.test.ts) | test source/fixture | [daemon](../architecture/daemon.md) | 310 |
| [packages/daemon/tsconfig.json](../../packages/daemon/tsconfig.json) | configuration/tool/asset | [daemon](../architecture/daemon.md) | 6 |
| [packages/design/build-tokens.js](../../packages/design/build-tokens.js) | configuration/tool/asset | [design](../architecture/design.md) | 360 |
| [packages/design/css/components.css](../../packages/design/css/components.css) | configuration/tool/asset | [design](../architecture/design.md) | 2620 |
| [packages/design/css/tokens.css](../../packages/design/css/tokens.css) | configuration/tool/asset | [design](../architecture/design.md) | 466 |
| [packages/design/fonts/LICENSE-IBM-Plex.txt](../../packages/design/fonts/LICENSE-IBM-Plex.txt) | configuration/tool/asset | [design](../architecture/design.md) | 93 |
| [packages/design/fonts/LICENSE-Noto.txt](../../packages/design/fonts/LICENSE-Noto.txt) | configuration/tool/asset | [design](../architecture/design.md) | 93 |
| [packages/design/package.json](../../packages/design/package.json) | configuration/tool/asset | [design](../architecture/design.md) | 26 |
| [packages/design/semantics.json](../../packages/design/semantics.json) | configuration/tool/asset | [design](../architecture/design.md) | 158 |
| [packages/design/src/component-api.d.ts](../../packages/design/src/component-api.d.ts) | implementation/type | [design](../architecture/design.md) | 1061 |
| [packages/design/src/index.ts](../../packages/design/src/index.ts) | implementation/type | [design](../architecture/design.md) | 8 |
| [packages/design/src/tokens.ts](../../packages/design/src/tokens.ts) | implementation/type | [design](../architecture/design.md) | 314 |
| [packages/design/test/contrast.test.ts](../../packages/design/test/contrast.test.ts) | test source/fixture | [design](../architecture/design.md) | 148 |
| [packages/design/test/fonts.test.ts](../../packages/design/test/fonts.test.ts) | test source/fixture | [design](../architecture/design.md) | 147 |
| [packages/design/test/token-lint.test.ts](../../packages/design/test/token-lint.test.ts) | test source/fixture | [design](../architecture/design.md) | 184 |
| [packages/design/tokens.json](../../packages/design/tokens.json) | configuration/tool/asset | [design](../architecture/design.md) | 1108 |
| [packages/design/tsconfig.json](../../packages/design/tsconfig.json) | configuration/tool/asset | [design](../architecture/design.md) | 5 |
| [packages/engine/package.json](../../packages/engine/package.json) | configuration/tool/asset | [engine](../architecture/engine.md) | 25 |
| [packages/engine/src/executors/agent-step.ts](../../packages/engine/src/executors/agent-step.ts) | implementation/type | [engine](../architecture/engine.md) | 402 |
| [packages/engine/src/executors/basic.ts](../../packages/engine/src/executors/basic.ts) | implementation/type | [engine](../architecture/engine.md) | 175 |
| [packages/engine/src/executors/containers.ts](../../packages/engine/src/executors/containers.ts) | implementation/type | [engine](../architecture/engine.md) | 461 |
| [packages/engine/src/executors/index.ts](../../packages/engine/src/executors/index.ts) | implementation/type | [engine](../architecture/engine.md) | 45 |
| [packages/engine/src/executors/types.ts](../../packages/engine/src/executors/types.ts) | implementation/type | [engine](../architecture/engine.md) | 139 |
| [packages/engine/src/human-input.ts](../../packages/engine/src/human-input.ts) | implementation/type | [engine](../architecture/engine.md) | 191 |
| [packages/engine/src/index.ts](../../packages/engine/src/index.ts) | implementation/type | [engine](../architecture/engine.md) | 13 |
| [packages/engine/src/orchestrator.ts](../../packages/engine/src/orchestrator.ts) | implementation/type | [engine](../architecture/engine.md) | 1529 |
| [packages/engine/src/plan/executors.ts](../../packages/engine/src/plan/executors.ts) | implementation/type | [engine](../architecture/engine.md) | 876 |
| [packages/engine/src/plan/service.ts](../../packages/engine/src/plan/service.ts) | implementation/type | [engine](../architecture/engine.md) | 1356 |
| [packages/engine/src/plugin.ts](../../packages/engine/src/plugin.ts) | implementation/type | [engine](../architecture/engine.md) | 32 |
| [packages/engine/src/program/executors.ts](../../packages/engine/src/program/executors.ts) | implementation/type | [engine](../architecture/engine.md) | 97 |
| [packages/engine/src/program/service.ts](../../packages/engine/src/program/service.ts) | implementation/type | [engine](../architecture/engine.md) | 86 |
| [packages/engine/src/program/work-items.ts](../../packages/engine/src/program/work-items.ts) | implementation/type | [engine](../architecture/engine.md) | 154 |
| [packages/engine/src/run-context.ts](../../packages/engine/src/run-context.ts) | implementation/type | [engine](../architecture/engine.md) | 304 |
| [packages/engine/src/session-model.ts](../../packages/engine/src/session-model.ts) | implementation/type | [engine](../architecture/engine.md) | 63 |
| [packages/engine/src/workspace/git-worktree.ts](../../packages/engine/src/workspace/git-worktree.ts) | implementation/type | [engine](../architecture/engine.md) | 54 |
| [packages/engine/src/workspace/provider.ts](../../packages/engine/src/workspace/provider.ts) | implementation/type | [engine](../architecture/engine.md) | 76 |
| [packages/engine/test/agent-health.e2e.test.ts](../../packages/engine/test/agent-health.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 145 |
| [packages/engine/test/agent-vars.e2e.test.ts](../../packages/engine/test/agent-vars.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 59 |
| [packages/engine/test/artifact-present.e2e.test.ts](../../packages/engine/test/artifact-present.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 86 |
| [packages/engine/test/artifact-watcher.test.ts](../../packages/engine/test/artifact-watcher.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 86 |
| [packages/engine/test/containers.test.ts](../../packages/engine/test/containers.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 698 |
| [packages/engine/test/context-caching.test.ts](../../packages/engine/test/context-caching.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 228 |
| [packages/engine/test/decision-agent.e2e.test.ts](../../packages/engine/test/decision-agent.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 66 |
| [packages/engine/test/delivery-outcome.test.ts](../../packages/engine/test/delivery-outcome.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 60 |
| [packages/engine/test/fresh-artifacts.test.ts](../../packages/engine/test/fresh-artifacts.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 126 |
| [packages/engine/test/helpers.ts](../../packages/engine/test/helpers.ts) | test source/fixture | [engine](../architecture/engine.md) | 76 |
| [packages/engine/test/human-input.test.ts](../../packages/engine/test/human-input.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 359 |
| [packages/engine/test/inputs.e2e.test.ts](../../packages/engine/test/inputs.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 91 |
| [packages/engine/test/local-workspace-branch.test.ts](../../packages/engine/test/local-workspace-branch.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 83 |
| [packages/engine/test/loop-siblings.e2e.test.ts](../../packages/engine/test/loop-siblings.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 91 |
| [packages/engine/test/model-selection.e2e.test.ts](../../packages/engine/test/model-selection.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 198 |
| [packages/engine/test/node-policy.test.ts](../../packages/engine/test/node-policy.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 99 |
| [packages/engine/test/obsolete-parent.test.ts](../../packages/engine/test/obsolete-parent.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 67 |
| [packages/engine/test/permission-sidecar.e2e.test.ts](../../packages/engine/test/permission-sidecar.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 160 |
| [packages/engine/test/permissions.test.ts](../../packages/engine/test/permissions.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 290 |
| [packages/engine/test/plan-dispatch.test.ts](../../packages/engine/test/plan-dispatch.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 416 |
| [packages/engine/test/plan-service-multiprocess.test.ts](../../packages/engine/test/plan-service-multiprocess.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 47 |
| [packages/engine/test/plan.e2e.test.ts](../../packages/engine/test/plan.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 399 |
| [packages/engine/test/plan.service.test.ts](../../packages/engine/test/plan.service.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 876 |
| [packages/engine/test/program-settlement.test.ts](../../packages/engine/test/program-settlement.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 47 |
| [packages/engine/test/program.e2e.test.ts](../../packages/engine/test/program.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 190 |
| [packages/engine/test/released-work-item.test.ts](../../packages/engine/test/released-work-item.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 47 |
| [packages/engine/test/run-lease.test.ts](../../packages/engine/test/run-lease.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 368 |
| [packages/engine/test/run-overrides.e2e.test.ts](../../packages/engine/test/run-overrides.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 124 |
| [packages/engine/test/sdlc.e2e.test.ts](../../packages/engine/test/sdlc.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 180 |
| [packages/engine/test/streaming-append-failure.e2e.test.ts](../../packages/engine/test/streaming-append-failure.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 106 |
| [packages/engine/test/terminal-recovery.test.ts](../../packages/engine/test/terminal-recovery.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 71 |
| [packages/engine/test/wedged-agent.e2e.test.ts](../../packages/engine/test/wedged-agent.e2e.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 71 |
| [packages/engine/test/work-item-claims.test.ts](../../packages/engine/test/work-item-claims.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 409 |
| [packages/engine/test/workflow-pinning.test.ts](../../packages/engine/test/workflow-pinning.test.ts) | test source/fixture | [engine](../architecture/engine.md) | 155 |
| [packages/engine/tsconfig.json](../../packages/engine/tsconfig.json) | configuration/tool/asset | [engine](../architecture/engine.md) | 6 |
| [packages/integrations/package.json](../../packages/integrations/package.json) | configuration/tool/asset | [integrations](../architecture/integrations.md) | 29 |
| [packages/integrations/src/acp-facade/config-options.ts](../../packages/integrations/src/acp-facade/config-options.ts) | implementation/type | [integrations](../architecture/integrations.md) | 296 |
| [packages/integrations/src/acp-facade/index.ts](../../packages/integrations/src/acp-facade/index.ts) | implementation/type | [integrations](../architecture/integrations.md) | 3 |
| [packages/integrations/src/acp-facade/orca-acp-agent.ts](../../packages/integrations/src/acp-facade/orca-acp-agent.ts) | implementation/type | [integrations](../architecture/integrations.md) | 498 |
| [packages/integrations/src/acp-facade/upstream-human-input.ts](../../packages/integrations/src/acp-facade/upstream-human-input.ts) | implementation/type | [integrations](../architecture/integrations.md) | 95 |
| [packages/integrations/src/index.ts](../../packages/integrations/src/index.ts) | implementation/type | [integrations](../architecture/integrations.md) | 12 |
| [packages/integrations/src/jev/executor.ts](../../packages/integrations/src/jev/executor.ts) | implementation/type | [integrations](../architecture/integrations.md) | 302 |
| [packages/integrations/src/jev/http-provider.ts](../../packages/integrations/src/jev/http-provider.ts) | implementation/type | [integrations](../architecture/integrations.md) | 57 |
| [packages/integrations/src/jev/index.ts](../../packages/integrations/src/jev/index.ts) | implementation/type | [integrations](../architecture/integrations.md) | 6 |
| [packages/integrations/src/jev/node.ts](../../packages/integrations/src/jev/node.ts) | implementation/type | [integrations](../architecture/integrations.md) | 71 |
| [packages/integrations/src/jev/plugin.ts](../../packages/integrations/src/jev/plugin.ts) | implementation/type | [integrations](../architecture/integrations.md) | 22 |
| [packages/integrations/src/jev/types.ts](../../packages/integrations/src/jev/types.ts) | implementation/type | [integrations](../architecture/integrations.md) | 83 |
| [packages/integrations/src/jev/validate.ts](../../packages/integrations/src/jev/validate.ts) | implementation/type | [integrations](../architecture/integrations.md) | 152 |
| [packages/integrations/src/kepler/index.ts](../../packages/integrations/src/kepler/index.ts) | implementation/type | [integrations](../architecture/integrations.md) | 1 |
| [packages/integrations/src/kepler/workspace-provider.ts](../../packages/integrations/src/kepler/workspace-provider.ts) | implementation/type | [integrations](../architecture/integrations.md) | 81 |
| [packages/integrations/src/t3code/contracts.ts](../../packages/integrations/src/t3code/contracts.ts) | implementation/type | [integrations](../architecture/integrations.md) | 55 |
| [packages/integrations/src/t3code/index.ts](../../packages/integrations/src/t3code/index.ts) | implementation/type | [integrations](../architecture/integrations.md) | 2 |
| [packages/integrations/src/t3code/session.ts](../../packages/integrations/src/t3code/session.ts) | implementation/type | [integrations](../architecture/integrations.md) | 169 |
| [packages/integrations/test/acp-facade-prompts.test.ts](../../packages/integrations/test/acp-facade-prompts.test.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 333 |
| [packages/integrations/test/acp-facade.test.ts](../../packages/integrations/test/acp-facade.test.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 533 |
| [packages/integrations/test/jev-eval.live.test.ts](../../packages/integrations/test/jev-eval.live.test.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 36 |
| [packages/integrations/test/jev-eval.test.ts](../../packages/integrations/test/jev-eval.test.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 443 |
| [packages/integrations/test/jev-harness.ts](../../packages/integrations/test/jev-harness.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 199 |
| [packages/integrations/test/kepler-workspace.test.ts](../../packages/integrations/test/kepler-workspace.test.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 130 |
| [packages/integrations/test/t3code-session.test.ts](../../packages/integrations/test/t3code-session.test.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 215 |
| [packages/integrations/test/upstream-human-input.test.ts](../../packages/integrations/test/upstream-human-input.test.ts) | test source/fixture | [integrations](../architecture/integrations.md) | 98 |
| [packages/integrations/tsconfig.json](../../packages/integrations/tsconfig.json) | configuration/tool/asset | [integrations](../architecture/integrations.md) | 6 |
| [packages/protocol/package.json](../../packages/protocol/package.json) | configuration/tool/asset | [protocol](../architecture/protocol.md) | 21 |
| [packages/protocol/src/agents.ts](../../packages/protocol/src/agents.ts) | implementation/type | [protocol](../architecture/protocol.md) | 117 |
| [packages/protocol/src/artifacts.ts](../../packages/protocol/src/artifacts.ts) | implementation/type | [protocol](../architecture/protocol.md) | 112 |
| [packages/protocol/src/claims.ts](../../packages/protocol/src/claims.ts) | implementation/type | [protocol](../architecture/protocol.md) | 88 |
| [packages/protocol/src/config.ts](../../packages/protocol/src/config.ts) | implementation/type | [protocol](../architecture/protocol.md) | 275 |
| [packages/protocol/src/control.ts](../../packages/protocol/src/control.ts) | implementation/type | [protocol](../architecture/protocol.md) | 189 |
| [packages/protocol/src/envelope.ts](../../packages/protocol/src/envelope.ts) | implementation/type | [protocol](../architecture/protocol.md) | 50 |
| [packages/protocol/src/errors.ts](../../packages/protocol/src/errors.ts) | implementation/type | [protocol](../architecture/protocol.md) | 89 |
| [packages/protocol/src/handshake.ts](../../packages/protocol/src/handshake.ts) | implementation/type | [protocol](../architecture/protocol.md) | 157 |
| [packages/protocol/src/index.ts](../../packages/protocol/src/index.ts) | implementation/type | [protocol](../architecture/protocol.md) | 26 |
| [packages/protocol/src/inputs.ts](../../packages/protocol/src/inputs.ts) | implementation/type | [protocol](../architecture/protocol.md) | 99 |
| [packages/protocol/src/maintenance.ts](../../packages/protocol/src/maintenance.ts) | implementation/type | [protocol](../architecture/protocol.md) | 6 |
| [packages/protocol/src/plan-control.ts](../../packages/protocol/src/plan-control.ts) | implementation/type | [protocol](../architecture/protocol.md) | 124 |
| [packages/protocol/src/plan.ts](../../packages/protocol/src/plan.ts) | implementation/type | [protocol](../architecture/protocol.md) | 523 |
| [packages/protocol/src/runs.ts](../../packages/protocol/src/runs.ts) | implementation/type | [protocol](../architecture/protocol.md) | 251 |
| [packages/protocol/src/status.ts](../../packages/protocol/src/status.ts) | implementation/type | [protocol](../architecture/protocol.md) | 120 |
| [packages/protocol/src/subscriptions.ts](../../packages/protocol/src/subscriptions.ts) | implementation/type | [protocol](../architecture/protocol.md) | 451 |
| [packages/protocol/src/version.ts](../../packages/protocol/src/version.ts) | implementation/type | [protocol](../architecture/protocol.md) | 112 |
| [packages/protocol/src/views.ts](../../packages/protocol/src/views.ts) | implementation/type | [protocol](../architecture/protocol.md) | 41 |
| [packages/protocol/src/workflows.ts](../../packages/protocol/src/workflows.ts) | implementation/type | [protocol](../architecture/protocol.md) | 216 |
| [packages/protocol/test/protocol.test.ts](../../packages/protocol/test/protocol.test.ts) | test source/fixture | [protocol](../architecture/protocol.md) | 213 |
| [packages/protocol/test/status.test.ts](../../packages/protocol/test/status.test.ts) | test source/fixture | [protocol](../architecture/protocol.md) | 95 |
| [packages/protocol/tsconfig.json](../../packages/protocol/tsconfig.json) | configuration/tool/asset | [protocol](../architecture/protocol.md) | 6 |
| [packages/store/package.json](../../packages/store/package.json) | configuration/tool/asset | [store](../architecture/store.md) | 21 |
| [packages/store/src/artifact-store.ts](../../packages/store/src/artifact-store.ts) | implementation/type | [store](../architecture/store.md) | 131 |
| [packages/store/src/claim-store.ts](../../packages/store/src/claim-store.ts) | implementation/type | [store](../architecture/store.md) | 182 |
| [packages/store/src/document-store.ts](../../packages/store/src/document-store.ts) | implementation/type | [store](../architecture/store.md) | 263 |
| [packages/store/src/event-store.ts](../../packages/store/src/event-store.ts) | implementation/type | [store](../architecture/store.md) | 158 |
| [packages/store/src/file-lock.ts](../../packages/store/src/file-lock.ts) | implementation/type | [store](../architecture/store.md) | 180 |
| [packages/store/src/index.ts](../../packages/store/src/index.ts) | implementation/type | [store](../architecture/store.md) | 11 |
| [packages/store/src/jsonl-event-store.ts](../../packages/store/src/jsonl-event-store.ts) | implementation/type | [store](../architecture/store.md) | 99 |
| [packages/store/src/jsonl-log.ts](../../packages/store/src/jsonl-log.ts) | implementation/type | [store](../architecture/store.md) | 314 |
| [packages/store/src/lease-store.ts](../../packages/store/src/lease-store.ts) | implementation/type | [store](../architecture/store.md) | 585 |
| [packages/store/src/plan-store.ts](../../packages/store/src/plan-store.ts) | implementation/type | [store](../architecture/store.md) | 133 |
| [packages/store/src/workflow-store.ts](../../packages/store/src/workflow-store.ts) | implementation/type | [store](../architecture/store.md) | 107 |
| [packages/store/test/artifact-index.test.ts](../../packages/store/test/artifact-index.test.ts) | test source/fixture | [store](../architecture/store.md) | 71 |
| [packages/store/test/binary-artifacts.test.ts](../../packages/store/test/binary-artifacts.test.ts) | test source/fixture | [store](../architecture/store.md) | 131 |
| [packages/store/test/claim-store.test.ts](../../packages/store/test/claim-store.test.ts) | test source/fixture | [store](../architecture/store.md) | 138 |
| [packages/store/test/document-store-batching.test.ts](../../packages/store/test/document-store-batching.test.ts) | test source/fixture | [store](../architecture/store.md) | 59 |
| [packages/store/test/document-store-multiprocess.test.ts](../../packages/store/test/document-store-multiprocess.test.ts) | test source/fixture | [store](../architecture/store.md) | 110 |
| [packages/store/test/event-range.test.ts](../../packages/store/test/event-range.test.ts) | test source/fixture | [store](../architecture/store.md) | 187 |
| [packages/store/test/file-lock-recovery.test.ts](../../packages/store/test/file-lock-recovery.test.ts) | test source/fixture | [store](../architecture/store.md) | 82 |
| [packages/store/test/file-lock-sharing.test.ts](../../packages/store/test/file-lock-sharing.test.ts) | test source/fixture | [store](../architecture/store.md) | 56 |
| [packages/store/test/fixtures/document-store-writer.ts](../../packages/store/test/fixtures/document-store-writer.ts) | test source/fixture | [store](../architecture/store.md) | 10 |
| [packages/store/test/jsonl-log.test.ts](../../packages/store/test/jsonl-log.test.ts) | test source/fixture | [store](../architecture/store.md) | 186 |
| [packages/store/test/lease-store.test.ts](../../packages/store/test/lease-store.test.ts) | test source/fixture | [store](../architecture/store.md) | 398 |
| [packages/store/test/old-store-replay.test.ts](../../packages/store/test/old-store-replay.test.ts) | test source/fixture | [store](../architecture/store.md) | 176 |
| [packages/store/test/plan-store.test.ts](../../packages/store/test/plan-store.test.ts) | test source/fixture | [store](../architecture/store.md) | 189 |
| [packages/store/test/stores.test.ts](../../packages/store/test/stores.test.ts) | test source/fixture | [store](../architecture/store.md) | 246 |
| [packages/store/test/workflow-store.test.ts](../../packages/store/test/workflow-store.test.ts) | test source/fixture | [store](../architecture/store.md) | 64 |
| [packages/store/tsconfig.json](../../packages/store/tsconfig.json) | configuration/tool/asset | [store](../architecture/store.md) | 6 |
| [packages/testing/package.json](../../packages/testing/package.json) | configuration/tool/asset | [testing](../architecture/testing.md) | 30 |
| [packages/testing/src/index.ts](../../packages/testing/src/index.ts) | implementation/type | [testing](../architecture/testing.md) | 72 |
| [packages/testing/src/scripted-agent/agent.ts](../../packages/testing/src/scripted-agent/agent.ts) | implementation/type | [testing](../architecture/testing.md) | 261 |
| [packages/testing/src/scripted-agent/main.ts](../../packages/testing/src/scripted-agent/main.ts) | implementation/type | [testing](../architecture/testing.md) | 45 |
| [packages/testing/src/scripted-agent/playbook.ts](../../packages/testing/src/scripted-agent/playbook.ts) | implementation/type | [testing](../architecture/testing.md) | 57 |
| [packages/testing/tsconfig.json](../../packages/testing/tsconfig.json) | configuration/tool/asset | [testing](../architecture/testing.md) | 6 |
| [pnpm-lock.yaml](../../pnpm-lock.yaml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 5025 |
| [pnpm-workspace.yaml](../../pnpm-workspace.yaml) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 21 |
| [release-compatibility.json](../../release-compatibility.json) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 5 |
| [tools/changelog.js](../../tools/changelog.js) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 171 |
| [tools/coverage-summary.js](../../tools/coverage-summary.js) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 50 |
| [tools/deploy/orca-release.py](../../tools/deploy/orca-release.py) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 367 |
| [tools/deploy/publish-feed.py](../../tools/deploy/publish-feed.py) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 48 |
| [tools/deploy/release-assets.py](../../tools/deploy/release-assets.py) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 41 |
| [tools/deploy/test_integration.py](../../tools/deploy/test_integration.py) | test source/fixture | [delivery](../architecture/delivery.md) | 118 |
| [tools/deploy/test_release.py](../../tools/deploy/test_release.py) | test source/fixture | [delivery](../architecture/delivery.md) | 229 |
| [tools/eslint-config/bin/check-css-tokens.js](../../tools/eslint-config/bin/check-css-tokens.js) | configuration/tool/asset | [tool-eslint](../architecture/tool-eslint.md) | 49 |
| [tools/eslint-config/css-tokens.d.ts](../../tools/eslint-config/css-tokens.d.ts) | implementation/type | [tool-eslint](../architecture/tool-eslint.md) | 27 |
| [tools/eslint-config/css-tokens.js](../../tools/eslint-config/css-tokens.js) | configuration/tool/asset | [tool-eslint](../architecture/tool-eslint.md) | 195 |
| [tools/eslint-config/index.js](../../tools/eslint-config/index.js) | configuration/tool/asset | [tool-eslint](../architecture/tool-eslint.md) | 154 |
| [tools/eslint-config/package.json](../../tools/eslint-config/package.json) | configuration/tool/asset | [tool-eslint](../architecture/tool-eslint.md) | 18 |
| [tools/eslint-config/rules/design-tokens-only.js](../../tools/eslint-config/rules/design-tokens-only.js) | configuration/tool/asset | [tool-eslint](../architecture/tool-eslint.md) | 120 |
| [tools/eslint-config/rules/file-header-comment.js](../../tools/eslint-config/rules/file-header-comment.js) | configuration/tool/asset | [tool-eslint](../architecture/tool-eslint.md) | 44 |
| [tools/eslint-config/rules/index.d.ts](../../tools/eslint-config/rules/index.d.ts) | implementation/type | [tool-eslint](../architecture/tool-eslint.md) | 6 |
| [tools/eslint-config/rules/index.js](../../tools/eslint-config/rules/index.js) | configuration/tool/asset | [tool-eslint](../architecture/tool-eslint.md) | 9 |
| [tools/font-build/build-fonts.js](../../tools/font-build/build-fonts.js) | configuration/tool/asset | [tool-fonts](../architecture/tool-fonts.md) | 196 |
| [tools/font-build/package.json](../../tools/font-build/package.json) | configuration/tool/asset | [tool-fonts](../architecture/tool-fonts.md) | 16 |
| [tools/release.js](../../tools/release.js) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 188 |
| [tools/test/changelog.test.js](../../tools/test/changelog.test.js) | test source/fixture | [delivery](../architecture/delivery.md) | 232 |
| [tools/test/deployment.test.js](../../tools/test/deployment.test.js) | test source/fixture | [delivery](../architecture/delivery.md) | 6 |
| [tsconfig.base.json](../../tsconfig.base.json) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 22 |
| [tsconfig.build.json](../../tsconfig.build.json) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 17 |
| [tsconfig.json](../../tsconfig.json) | configuration/tool/asset | [delivery](../architecture/delivery.md) | 32 |
| [vitest.config.ts](../../vitest.config.ts) | implementation/type | [delivery](../architecture/delivery.md) | 104 |
| [workflows/ai-sdlc.yaml](../../workflows/ai-sdlc.yaml) | configuration/tool/asset | [workflow-assets](../architecture/workflow-assets.md) | 175 |
| [workflows/plan-resume.yaml](../../workflows/plan-resume.yaml) | configuration/tool/asset | [workflow-assets](../architecture/workflow-assets.md) | 46 |
| [workflows/program.yaml](../../workflows/program.yaml) | configuration/tool/asset | [workflow-assets](../architecture/workflow-assets.md) | 133 |
