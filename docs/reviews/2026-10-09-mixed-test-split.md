# Mixed test suite split — 9 October 2026

Base: `0de7693e50cd130d9d67bdcd5654747a4fce6deb`. Rechecked all 23 audit entries against this checkout rather than treating the historical allocations as current case counts. Only test files and this review evidence change.

The 20 split originals register 474 cases before and after the split (20 files become 40). Their 297 registration expressions preserve test bodies/assertions, parameter tables, platform conditions, enclosing loops and suite paths. Runtime collection with an unmatched name filter confirms identical expanded full-name/status multisets, including the restoration TODO. The 23 audited files total 578 current cases.

| Original test | Before | Retained | Companion | Moved |
| --- | ---: | ---: | --- | ---: |
| `packages/agents/test/handshake.test.ts` | 10 | 2 | `handshake.unit.test.ts` | 8 |
| `packages/agents/test/hosts.test.ts` | 6 | 3 | `hosts.unit.test.ts` | 3 |
| `packages/app/test/daemon-client.test.ts` | 18 | 15 | `daemon-client.unit.test.ts` | 3 |
| `packages/app/test/daemon-connection.test.ts` | 30 | 27 | `daemon-connection.integration.test.ts` | 3 |
| `packages/app/test/mac-update-guards.test.ts` | 23 | 12 | `mac-update-guards.integration.test.ts` | 11 |
| `packages/app/test/notifications.test.ts` | 9 | 8 | `notifications.integration.test.ts` | 1 |
| `packages/app/test/report-validation.test.ts` | 8 | 6 | `report-validation.integration.test.ts` | 2 |
| `packages/cli/test/commands.test.ts` | 27 | 26 | `commands.unit.test.ts` | 1 |
| `packages/cli/test/runtime-launch.test.ts` | 8 | 4 | `runtime-launch.unit.test.ts` | 4 |
| `packages/daemon/test/config-methods.test.ts` | 27 | 22 | `config-methods.unit.test.ts` | 5 |
| `packages/daemon/test/configuration-studio-integration.test.ts` | 19 | 17 | `configuration-studio-integration.unit.test.ts` | 2 |
| `packages/daemon/test/server.test.ts` | 6 | 4 | `server.unit.test.ts` | 2 |
| `packages/engine/test/restoration-acceptance.test.ts` | 118 | 117 | `restoration-acceptance.unit.test.ts` | 1 |
| `packages/integrations/test/acp-facade.test.ts` | 10 | 8 | `acp-facade.unit.test.ts` | 2 |
| `packages/integrations/test/jev-eval.test.ts` | 38 | 13 | `jev-eval.unit.test.ts` | 25 |
| `packages/integrations/test/jev-restoration.test.ts` | 40 | 23 | `jev-restoration.integration.test.ts` | 17 |
| `packages/integrations/test/mcp-operator.test.ts` | 15 | 14 | `mcp-operator.integration.test.ts` | 1 |
| `packages/integrations/test/mcp-replay-diagnostics.test.ts` | 6 | 5 | `mcp-replay-diagnostics.unit.test.ts` | 1 |
| `packages/maintenance-mcp/test/maintenance.test.ts` | 42 | 40 | `maintenance.integration.test.ts` | 2 |
| `packages/store/test/windows-sync-journal.test.ts` | 14 | 13 | `windows-sync-journal.integration.test.ts` | 1 |

## Rechecked boundaries

- `selection.test.ts` stays intact: all 15 cases exercise CLI/bootstrap/store behavior, including the argv test previously called unit.
- `host-resources-native.test.ts` stays intact: all 11 cases inject the worker or filesystem port; the worker client uses `FakeWorker`, not a native worker.
- `mac-updates.test.ts` stays intact: its current 78 cases use synthetic coordinator ports; the historical four daemon cases are absent from this base file.
- `jev-restoration.test.ts` moves 17 cases to the companion integration suite: these use the production orchestrator with memory or reopened file stores, even when HTTP and credentials are injected. The 23 descriptor/adapter cases stay together.
- The journal simulation suite still opens real journal files and uses real persistence/locks. It is filesystem integration with simulated platform/sync branches; its native sync case gets a separate integration target. It is not labelled pure unit.
- The maintenance suite currently has 42 cases, one more than the historical 41. All current registrations are preserved.

## Validation

Root TypeScript typecheck, ESLint over all 40 affected files, Prettier over those files, and `git diff --check` pass. Unit extracts avoid integration-only setup/cleanup. Snapshot filenames are not used by these suites.

Focused execution uses one worker: 35 files / 339 cases, 334 passed, two Linux-only recovery cases skipped on Windows, and three failures. All three failures reproduce on the untouched base: the two `orca submit` cases (request creation/body-file) and the runtime-launch submit guard case report `Selected item workflow is unavailable`. No production fix or assertion change is made. A final recheck of the two cleaned unit-hook suites passes all 14 cases.

The fresh-process restoration, real handshake/host children, ACP facade and replay-diagnostics suites are collected for identity but their execution is deferred to protect the parent candidate/native Windows test priority. Full suite, global coverage, native UI acceptance and explicit mandatory retry acceptance are not claimed. Parent-thread coordination was attempted but the app could not resolve the delegated source thread.

Discovery uses the existing `packages/*/test/**/*.test.ts` glob and CI shadow graph regex, so companion files remain in package selection and full fallback. Both mandatory retry files and their registrations remain byte-for-byte unchanged. Exact committed-head selection is checked locally; no CI run is dispatched.

Machine-readable inventory: [2026-10-09-mixed-test-split.json](2026-10-09-mixed-test-split.json). Full before/after reports and the independent identity scripts remain in the task-15 workspace.
