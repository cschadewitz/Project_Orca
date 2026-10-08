# Restoration acceptance fixtures (#396)

**INCOMPLETE acceptance:** these fixtures verify the existing conservative baseline in
fresh OS processes. The opt-in substrate (#394), JEV adapter (#395), and Actual-Cal
acceptance have no reviewed implementation pins here and remain explicit Vitest TODOs
in `matrix.ts`. A green baseline suite does not complete #396 or milestone 10.

Baseline: main `65606fbce827cba914a67b999b1a47c0aab2797a`. Intended validation:
Node **24.21.0**, pnpm **12.4.2**, with the unchanged frozen lockfile and build policy.

```sh
pnpm exec vitest run packages/engine/test/restoration-acceptance.test.ts --maxWorkers=2
pnpm run typecheck
pnpm exec eslint packages/engine/test/restoration-acceptance.test.ts packages/engine/test/restoration-acceptance/*.ts
pnpm exec prettier --check packages/engine/test/restoration-acceptance.test.ts packages/engine/test/restoration-acceptance/*.ts
git diff --check
```

## Owned footprint and boundary

Exactly six new files: the adjacent `restoration-acceptance.test.ts` entry point and
this directory's `fixture.ts`, `harness.ts`, `matrix.ts`, `worker.ts`, and `README.md`.
No shared runtime, bootstrap, store, JEV adapter, exports, manifest, dependency,
workflow, credential, or host configuration is changed. The parent owns review,
integration, combined-head checks, CI, and merges.

Each case creates a disposable `orca-restoration-acceptance-396-*` root with an
ownership marker, configuration, plugin module, workspaces and file store. Every
worker uses production CLI bootstrap in a new Node process with its own module cache,
PID and boot UUID. The harness records the Node executable SHA-256 and version,
supplies only a small environment allowlist, bounds output and process lifetime, and
awaits child close before treating a report as evidence. Cleanup signals only its
owned children. It never acquires credentials or executes the configured agent
command. The session provider is deterministic and in-process, returning a scripted
completed turn with no external effect. The custom-plugin marker is test-owned.

IPC reports only allowlisted IDs, counters and leak flags; raw child logs and errors
are never printed. Canary checks inspect raw diagnostics inside the worker before
reducing them to flags. Positive cases hash original encrypted generations, workflow
records and synthetic owner keys before and after restart. Added bootstrap generations
are allowed; original evidence must remain byte-for-byte unchanged. Fault injection
alters only the case's own disposable records, or adds a synthetic invalid generation
under a new ID while preserving every original record.

## Capability/refusal matrix

| Case | Baseline assertion | Opt-in acceptance |
| --- | --- | --- |
| Built-in configuration | Historical model, workspace root, workflow and pause policy stay pinned; new admissions use changed defaults | Existing behavior |
| Unchanged no-op/declarative plugin | Compatible entry identity restores recorded declarative material | Existing behavior |
| Executor closure, in-place host/FS mutation, custom workspace, plan extractor, built-in callback mutation | Entire generation refuses before a new provision or scripted turn, including unused callbacks | #394 pending |
| Changed/unavailable plugin | Refuses before fixture effects; missing module remains an unclassified bootstrap error | #394 stable diagnostic pending |
| Protected record envelope version 1 | Authenticated existing record restores in a new process | Descriptor version is a separate #394 obligation |
| Future envelope, malformed JSON, corrupt ciphertext, missing generation/input/workflow/key | Useful closed refusal; no scripted provider execution | Descriptor corruption/version coverage pending #394 |
| Authenticated ID/workflow mismatch, incomplete/duplicate definitions | Candidate refuses without changing original protected evidence | Partial plugin reconstruction pending #394 |
| Legacy generation with version-store pins | Built-in legacy record restores; unbound plugin record refuses | Opt-in legacy policy pending #394 |
| Current authority revoked, missing, or different principal/workspace | Existing admitted first attachment refuses without event changes | Restored-plugin composition pending #394/#395 |
| Live lease owned by another fresh process | IPC barrier proves ownership; resume refuses with `RUN_LEASED` | Existing behavior |
| Lost admission response | Suppressed receipt after durable acceptance; a new process retries the same intent and receives the same IDs without reprovisioning or execution | Provider response loss remains #395/#297 pending |
| Dead permission callback | A new owner cannot answer a prior process's live target or write consent | No consent restoration |
| Durable completed scripted step | Restart does not repeat the completed step when proceeding to the next historical gate | JEV artifact/result reuse pending #395 |

The lost-admission case deliberately suppresses receipt delivery after successful
persistence and exits cleanly. It does not simulate a hard crash during persistence,
a lost provider response, or exactly-once external effects. The authority fixture
exercises production sealed-admission/local-execution boundaries with synthetic
revocation; it does not prove authentication on Cal's actual private MCP connection.
Permission callback coverage uses the real owner-local registry and synthetic live
binding, without an ACP agent or durable standing-grant writer. Its successful close
is not persisted consent. A UI reconnect alone is not engine-process restoration.

## Minimal binding needs from the separately owned implementations

The actual provisional substrate seam is recorded in
[#394's owner comment](https://github.com/cschadewitz/Project_Orca/issues/394#issuecomment-6051433591).
It offers `identity/capture/validate/restore` and supports **custom executors only**.
Host, workspace, plan-extractor and human-input ports remain unsupported in v1.
The inspected adapter is [draft #543](https://github.com/cschadewitz/Project_Orca/pull/543)
at `1155f1db2f2f5dbf5b454c9dca685356b77b7d65`; neither implementation acceptance pin
is set. The shipped environment plugin still cannot attest account identity or restore.

`prepareJevFixture` supplies concrete before/after evaluation graphs, historical/current
model and endpoint settings, a node override, and synthetic missing/revoked/changed-account
and lost-response modes against #543's actual `createRestorableJevEvalPlugin` signature.
Its module bytes remain unchanged when settings change; a separate owned settings file
provides defaults at boot and current synthetic authority at execution. Platform `fetch`
is intercepted in the fixture process and records only endpoint/model, with no socket or
credential in traces. Identity values are synthetic fixture labels, not proof of the
adapter's real code/dependency closure. This preparation is **unbound and unexecuted**
until the reviewed combined head provides the real substrate and adapter.

Continue using `bootstrap`, `ConfigurationGenerations.captureLaunch/restore`, and
the existing protected execution/workflow stores. These fixtures define no competing
descriptor, loader, credential resolver, or provider retry interface.

Before replacing a TODO with an executable assertion, record the independently
reviewed exact #394/#395 heads in `implementationPins` and consume their frozen
repository contract. Required observations are:

1. Opt-in plugin capture/factory API, supported callback categories, bounded descriptor
   schema/version, and stable non-secret incompatibility/refusal diagnostics.
2. Recorded generation capture/isolated restoration through the existing bootstrap
   path, including code/dependency identity and all-or-nothing candidate activation.
3. JEV's explicit deterministic compatible provider factory/reference seam, effective
   model/endpoint defaults, node overrides, current credential/account binding and
   durable result/artifact IDs. Arbitrary injected callbacks cannot be assumed restorable.
4. Honest in-flight ambiguity status under #297. No automatic retry or exactly-once
   guarantee can be inferred from a completed durable result or lost response.

The parent binds these fixtures to reviewed combined heads and supplies the separate
operator/plugin documentation. Actual-Cal live inspection/resume, credentials,
deployment, live agents, user-data restoration and native acceptance are **UNRUN**.
Record the exact build, private target, stable IDs and final provenance in parent-owned
live evidence; a reference-client or this subprocess suite cannot replace that proof.
