# Review detail — 13 October 2026

These are the full write-ups behind the [code review](../2026-10-13-code-review.md) and the
[documentation and design variance review](../2026-10-13-docs-code-variance.md), both pinned
at `0c75d01`.

Each scope file has the same layout:

- **Coverage:** what was read in full, in part, or skipped, and why.
- **Findings:**
  - Code scopes: location, issue, scenario and evidence, and recommendation.
  - Doc scopes: the doc claim, what the code does, and the suggested resolution.
- **Strengths** (code scopes) or **Confirmed consistent** (doc scopes).

Severities in these files are the reviewers' own. Where a verifier changed one, the two
summary reviews show the adjusted severity, and the verifier's reasoning is in V1–V6 below.
Line numbers are as of the pin.

## Code review scopes

| File | Scope |
| --- | --- |
| [C1](C1.md) | Daemon: `packages/daemon/src/**`, including `auth/` and `host-resources/` |
| [C2](C2.md) | Engine: `packages/engine/src/**` |
| [C3](C3.md) | `packages/core`, `packages/store`, `packages/protocol` |
| [C4](C4.md) | `packages/cli`, `packages/agents`, `packages/integrations`, `packages/maintenance-mcp`, `packages/testing`, example plugins |
| [C5a](C5a.md) | Electron main process except `mac-*.ts`; preload, client, preferences, first-run, diagnostics, native C addons, app scripts |
| [C5b](C5b.md) | `packages/app/src/main/mac-*.ts`, update contracts, `tools/packaged-mac`, `tools/deploy/native-mac-*.py` |
| [C6](C6.md) | Renderer: root modules, `ui`, `list`, `chrome`, `a11y`, `palette`, `runs`, `step`, `artifacts`, `attention`, `daemon-connection`, `first-run`, `diagnostics`, `resources`, `preview` |
| [C7](C7.md) | Renderer: `config`, `plan`, `workflow`, `guided-launch`, `template-authoring`, `agents` |
| [C8](C8.md) | `.github/`, `tools/**` (except Mac packaging), the design token build, dependency manifests and lockfile, a repository-wide credential sweep |

## Documentation and design scopes

| File | Scope |
| --- | --- |
| [D1](D1.md) | `README.md`, `docs/README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `ARCHITECTURE.md`, `DATA-MODEL.md`, `EXTENSIBILITY.md`, ADRs 0001–0009, `packages/maintenance-mcp/README.md` |
| [D2](D2.md) | `WORKFLOWS.md`, `PLANNING.md`, workflow inputs, revision input, request submission, live input, builtin validation, admission retry, configuration generations, root worktrees, protected storage and replay errors; shipped workflows, templates and examples |
| [D3](D3.md) | `packages/protocol/README.md`, daemon connection and security, host resources and access policy, `INTEGRATIONS.md`, the MCP operator docs, the maintenance MCP and observer runbook, `docs/contracts/` |
| [D4](D4.md) | The runtime-operator, runtime-next and runtime-foundation contracts and integration notes; the v0.5.2 checklists; the status of `docs/patches/` |
| [D5](D5.md) | `DEVELOPMENT.md`, `RELEASING.md`, `UPDATING.md`, `REAL-AGENT-TEST.md`, CI shadow selection, `ROADMAP.md`, `docs/performance/`, `changelog.d/README.md`, tooling READMEs |
| [D6](D6.md) | `docs/design/RULES.md`, `README.md`, docs 10, 20, 30 and 40; the UI sections of `AGENTS.md` |
| [D7](D7.md) | `docs/design/` docs 50, 60, 70 and 80 and the design prompt; `packages/design` against the renderer's `ui/` |
| [D8](D8.md) | `docs/implementation/` (32 notes, evidence and patches); `docs/preparation/native-mac-testing/` |
| [D9](D9.md) | `docs/preparation/` crash recovery, manual diagnostics contract and implementation, native Mac beta readiness and delivery |
| [D10](D10.md) | `docs/preparation/` private MCP access, ACP command conformance, beta feedback, first job and update support, Cal first job, configuration and launch, owned and trusted roots |
| [D11](D11.md) | `docs/research/tool-call-safety/`, the Apple Watch, iOS and SwiftUI packets, the earlier dated reviews (with the status of their open items), `docs/session-logs/` |

`Current_State/` was excluded from every scope.

## Verification

Each Critical and High finding was re-checked by a verifier asked to refute it.

| File | Findings re-checked |
| --- | --- |
| [V1](V1.md) | C2-01/D2-01, C2-02, C2-03, C3-01, C3-02/C1-08, C4-01 |
| [V2](V2.md) | C6-02 to C6-09 |
| [V3](V3.md) | C7-01 to C7-04, D7-01 to D7-05 |
| [V4](V4.md) | C5b-01, C5b-02, C5b-03, C5b-07/D8-02, D8-01, C8-01, C8-02 |
| [V5](V5.md) | C5a-01 to C5a-06 |
| [V6](V6.md) | D6-02, D6-03, D6-05 to D6-08, D6-10 to D6-12 |

The lead checked C6-01, C8-03/D5-02, D5-01, D5-03 and D1-01 directly; the summary reviews
record that evidence.
