# Sensitive-input canary audit for the next private release after v0.6.0

This is a **bounded regression audit** of how sensitive launch input reaches the surfaces a
release candidate after v0.6.0 supports. It audits `main` at
`7f42c3a7699a8da24cfbf4a1ab1f796947bfff14` (27 October 2026) and was rebased onto
`7343e151c24299e20f5ecb128be9e8657cd4aae3`, whose added commits touch only app test fixtures
and `tools/`. It is coordinated with
[#363](https://github.com/cschadewitz/Project_Orca/issues/363) and the release readiness audit
([2026-10-27-release-readiness.md](2026-10-27-release-readiness.md)).

It is a sample, not a privacy assurance:

- It does not close #363 and does not implement the #336 secret-reference resolver or a vault.
- It is not Apple Silicon/macOS acceptance.
- No real secret, user path, customer content or account data was used.
- Nothing was uploaded, deployed, activated or merged.

## What counts as a leak

Expectations come from the written contracts, not from "hide everything":

- [workflow-inputs.md](../workflow-inputs.md): `sensitive: true` covers everything beneath it.
  Validation messages never quote a value, pattern or enum. An unknown key beneath a
  sensitive declaration is reported at the enclosing path. `workflows.get` omits sensitive
  defaults, enums and vars. Preflight returns no values.
- [protected-execution-storage.md](../protected-execution-storage.md):
  - Public run views, events, notifications, replay and execution logger fields carry
    projections. A sensitive top-level var shows `[REDACTED]`, so a reader can tell "hidden"
    from "absent".
  - Exact values live in the encrypted private store. Holding them there is protected
    storage, not a disclosure.
  - Literal scrubbing is defense in depth: encoded, transformed or fragmented values are a
    documented limit.
- [configuration-generations.md](../configuration-generations.md): launch provenance
  withholds every input value.
- #363 non-goals: who may read a run (#328), the resolver (#336), and secrets an agent itself
  echoes into free-form output.
- Executors and agents are the authorized execution boundary. They receive exact values.

A canary counts as exposed if any six-character window of its unique tail appears, ignoring
letter case. A whole-string check would miss fragments and case-transformed copies. Every
third tail character is `i`, `l`, `o` or `u`, which neither ULIDs nor hex digests contain, so
no identifier can produce a false hit.

## Evidence matrix

Audience abbreviations:

- **public**: any `runs.read` reader (desktop renderer, `orca status`/`events`, MCP operator
  reads, HTTP/WebSocket subscribers) and public files under `.orca/runs`.
- **submitter**: the caller who supplied the values.
- **local operator**: the terminal or process owner.

| Surface | Audience | Contract classification | Evidence | Result |
| --- | --- | --- | --- | --- |
| `run.created.vars`, `runs.get`, `runs.list` | public | sensitive top-level → `[REDACTED]` marker | daemon wire test; engine preview and gate tests | pass |
| Event log: `runs.events`, live/replayed `event.appended`, raw `runs/<id>.jsonl` | public | literal scrub plus structural restore; private original behind opaque `executionPayloadRef` | daemon wire test (HTTP, live and replay sockets, raw file) | pass after fix 1 |
| `agent.turn.started.promptPreview` | public; also the renderer timeline ("prompted the agent, …") | must not carry a sensitive value | engine `rendered prompt previews`; daemon wire test | **leak, fixed** (fix 1) |
| `agent.turn.started.promptHash` | public | identity of the exact prompt | engine test checks it equals `sha256` of the prompt sent | retained (residual 3) |
| Launch provenance on `run.created`, `runs.get` | public | every input value withheld | engine `launch provenance` | **leak, fixed** (fix 2) |
| Operator preflight `itemWorkflow` (MCP) | operator with `config.read` | authority input to `workflowAllowed` | not changed; source-reviewed | unchanged on purpose |
| Gate question, `pendingInputs`, `orca status` pause summary, `orca answer` | public | scrubbed | engine `paused human gates`; CLI end-to-end test | pass |
| Interactive terminal port (`humanInput.mode: cli`) | local operator | same text as `orca answer` and `status` | CLI `interactive terminal port` | **leak, fixed** (fix 3) |
| Step and run errors: thrown `Error` with a JSON-quoted value, `OrcaError` details keys and arrays, `cause`, non-`Error` throw | public events and state, CLI formatting, run logs | scrubbed; `describeError` drops `cause` and stack | engine `thrown, late and cancelled results` (4 cases) | pass |
| Run logger to real stderr (`consoleLogger`), `console.*`, stdout | local operator, daemon/app stderr | execution logger redacts message and fields | same engine tests, capturing `process.stdout`/`stderr` and `console` | pass |
| Late provider answer and late logging after cancellation | public; stderr | scrubbed | engine `late result … cancelled` | pass |
| Malformed admission input: pattern, `minLength`, enum, wrong type, unknown key beneath a sensitive object | submitter (RPC error envelope, CLI stderr) | no value, pattern, enum or secret key | engine `malformed`; daemon wire refusals; CLI stderr test | pass |
| `workflows.validateInputs` preflight | submitter | no values | daemon wire test | pass |
| `workflows.get` with a sensitive default | `runs.read` reader | default withheld | daemon wire test | pass |
| `orca run`, `status`, `events --json`, `answer` (resume), stdout and stderr | local operator | redaction markers only | CLI end-to-end test through `main()`. `run --cwd` takes the `startAndRun` path; the keyed direct-admission path without `--cwd` was not driven end to end | pass |
| `.orca` store files on disk | local file readers | public files hold no plaintext; private records are ciphertext | CLI end-to-end scan of every non-YAML file | pass |
| Inherited child (undeclared subworkflow) | public | inherits sensitivity | engine preview test (child turn withheld) | pass after fix 1 |
| Resume after a gate on a pinned configuration generation | execution | redaction must not change identity | engine provenance test resumes to `completed` | pass |

The engine regression tests in the same run also re-exercised the following existing
coverage. It was not re-derived here:

- `protected-execution-inputs.test.ts`: file-backed restart, corrupt and missing records, child
  promotion, logger rebinding.
- `security-sensitive-integration.test.ts`: artifact name, path and body over HTTP and sockets.
- `config-generation-integration.test.ts`: configured credential literals.
- `live-input-integration.test.ts`: live permission questions.

### Meaningful exclusions

- **App diagnostics report**: source-reviewed only, because diagnostics activation is out of
  scope. It is hard-disabled (`DIAGNOSTICS_PRODUCTION_ENABLED = false`) and admits only a
  closed list of phase/code pairs (`profile.ts`, `report-validation.ts`). It never reads
  messages, stacks or logs.
- **Feedback files**: no writer exists. The beta feedback process is a manual template
  (`docs/preparation/beta-feedback/`).
- **Config previews and exports**: launch vars do not flow there. The config surfaces
  (`config.get`, workflow drafts, template preview) hold configuration credentials, not
  launch vars. They are unredacted to `config.read` holders by documented design, and
  configured secrets belong to #336.
- **Desktop renderer**: no renderer test added. The timeline renders `promptPreview` from
  the public event it receives. Guided launch withholding and stale draft restoration are
  covered by `guided-launch-restore-safety.test.tsx`.
- Packaged or installed builds, Windows and macOS, live providers, and the live MCP operator.

## Red and green reproductions

Red: both suites at `7f42c3a` with only the new test files added. Result: 3 failed, 11 passed.

```sh
pnpm vitest run packages/engine/test/sensitive-release-canaries.test.ts packages/cli/test/sensitive-release-canaries.test.ts
```

1. `rendered prompt previews › withholds them for sensitive runs…`: `promptPreview` was
   `pppp…SYNTHETIC-CANARY-TOKEN-q7uX9lM4oT`. The 400-character cut left ten characters of the
   token, which the whole-literal scrub cannot match.
   - An earlier probe showed a sensitive object rendered by `{{vars.config}}` publishing both
     lines of a multi-line value. YAML re-indents the value, so the literal no longer matches.
     The scrub caught only the key.
2. `launch provenance › withholds a sensitive itemWorkflow…`: `provenance.itemWorkflow.value`
   was the raw canary. `launchProvenance` copies `vars.itemWorkflow`, and the store restores
   `provenance` verbatim. Admission validates only `overrides.itemWorkflow` against the
   catalog, so any string passes.
3. `interactive terminal port shows the published question…`: the prompt printed
   `Ship SYNTHETIC-CANARY-CLITOKEN-r4uM8lQ2oV6iX9uB as SYNTHETIC-CANARY-CLITOKEN-…?`. The
   port received the authoritative rendered query, while `orca answer` and `status` show
   `[REDACTED]`.

The daemon wire test fails with only `protected-event-store.ts` reverted and passes with it.

Green: all three files pass, 15 tests. The broader regression run is under "Checks run".

## Fixes

[protected-execution-storage.md](../protected-execution-storage.md) now states the projection
rule these fixes follow. All three are projection fixes. No event schema, store format, epoch, protocol, key,
authority or permission changed.

1. **`packages/store/src/protected-event-store.ts`, `agent.turn.started`**
   - For a run with sensitive names (declared, inherited or promoted), the public
     `promptPreview` is `[REDACTED]`. This is the same marker the revision handoff already
     uses.
   - Withholding the whole preview is the explicit unavailable outcome: no literal rule can
     undo YAML, template functions or truncation.
   - Runs with no sensitive names, including runs whose only secrets are configured
     credentials, keep their scrubbed preview.
   - `promptHash` and the encrypted original are unchanged.
2. **Same file, `run.created` provenance**
   - When `itemWorkflow` is a sensitive name and the value came from vars, the public
     `itemWorkflow.value` is `[REDACTED]`; `source` is kept.
   - An explicit override is a selection and stays visible.
   - The private payload, the generation pin and the restoration identity are untouched.
   - `launchProvenance` itself is not changed: operator preflight feeds that value to
     `workflowAllowed`, and redacting it there would change an authorization input.
3. **`packages/engine/src/human-input.ts`, `executors/basic.ts`, `packages/cli/src/human-input-cli.ts`**
   - `HumanInputQuery` gains an optional `presentation`. It is the question, options and
     context that `human.requested` actually published.
   - The gate and decision path now passes the run's `emit`, which returns the published
     event, instead of the step's `emit`, which returns nothing. Both perform the same
     append; the permission path already did this.
   - The terminal port displays `presentation`. Answers still resolve against the
     authoritative option ids, and pre-existing port tests pass unchanged.
   - `UpstreamHumanInput` is deliberately unchanged (residual 8).

## Residual risks, ranked by relevance to this release

1. **Confirmed, deferred (agent echo, a #363 non-goal).**
   - An agent that echoes a sensitive value containing `"`, `\` or a control character into
     tool-call input defeats the scrub. `toolCallBody` JSON-escapes it before the scrub runs,
     and the escaped form survives in the public `agent.update` `args.text`.
   - A probe showed the plain canary scrubbed and the quoted one published.
   - Related unverified forms:
     - the 2,000-character args cap and 4,000-character message batching can split a value
       across events;
     - PEM-style multi-line values echoed through JSON.
   - Proposed patch for the owner: also add each string secret's JSON-escaped form
     (`JSON.stringify(s).slice(1, -1)`) as a needle in `redactExecutionValue`.
   - This widens the documented literal-scrub contract, so it is a decision, not a fix
     taken here.
2. **Observed, inherent to literal scrubbing.** Low-entropy sensitive scalars (booleans,
   small integers, one-character strings or object keys) are redacted wherever they occur.
   - The pattern of `[REDACTED]` reveals the value. For example, `true` is hidden while
     `false` is shown.
   - It also mangles structural text: request ids in `step.waiting.detail`,
     `child.spawned.branch`, child run ids in `result.data`, and words such as
     `to[REDACTED]en` for a secret key `k`.
   - This is not a plaintext disclosure, but it degrades diagnostics. `branch` was
     deliberately not added to the restored keys, because container branches can carry
     item-derived labels.
3. **Hypothesis.** `promptHash` (SHA-256 of the full prompt) allows offline guessing of a
   low-entropy sensitive value when the template is readable through `workflows.get`. It is
   kept as turn identity evidence. A keyed digest would be a protocol decision.
4. **By contract.** `choice`, routing and `human.answered.answer` are restored as structural
   metadata. A workflow that maps a sensitive enum one-to-one onto decision options reveals
   which value was used. The option ids are already public in the definition.
5. **Local operator stderr outside runs.** The CLI's top-level printer, the RPC error
   envelope and the bundled daemon's stderr forward raw messages.
   - No post-admission path carrying a launch value was found.
   - Malformed config YAML echoes its source line (yaml `prettyErrors`) to the local terminal.
     That concerns configured credentials (#336).
   - The bundled daemon entry installs no process error handlers, so Node's default crash
     output is unfiltered.
6. **Hypothesis, agent output.** Plan intake (`plan.onArtifactRecorded`) and plan logs have no
   protected projection for artifact content.
7. **Validation asymmetry.**
   - An unknown key beneath a *non-sensitive* object of a partly sensitive input is reported
     by name to the submitter. This follows the validation contract.
   - Storage, by contrast, treats the whole top-level input as sensitive.
   - Exposure is limited: the submitter only, and nothing is written.
8. **Hypothesis, audience undecided.** `UpstreamHumanInput` (ACP facade) still receives the
   authoritative question and context. `presentation` is now available for that port's owner
   to adopt.
9. **Information.**
   - Public logs written before this change keep their previews and provenance. There is no
     migration.
   - `docs/workflow-inputs.md`'s "Outstanding integration gate" section describes the
     pre-integration slice and reads as current.

## Checks run

Environment: Linux x64 container running as root, Node 24.21.0, pnpm 12.4.2, frozen install,
`ELECTRON_SKIP_BINARY_DOWNLOAD=1`. No Electron launch, packaged artifact or live provider.

- **Red**: the three canary files at `7f42c3a` with only the tests added. Result: 3 failed,
  11 passed. The daemon wire test also failed with only `protected-event-store.ts` reverted.
- **Full Vitest suite at `7f42c3a` plus these changes**, in two runs:
  - Core packages (`store engine daemon cli core integrations protocol agents`): 4,804 passed.
    Another 87 tests in 11 files failed only because no compiled build existed ("Acceptance
    requires a fresh compiled build"). After `pnpm exec tsc -b tsconfig.build.json`, those
    11 files passed in full (160 tests).
  - The remaining packages (`app design maintenance-mcp testing tools/test`): 4,753 passed and
    33 skipped. One test failed: `first-run.test.ts` › "refuses denied selection without
    writing files". It fails identically with every change here stashed. It relies on
    `chmod 0o500` denying writes, which root bypasses.
- **Rebased onto `7343e15`** (later main commits touch only app test fixtures and `tools/`):
  - the three canary files plus the neighbouring suites (protected inputs and boundaries,
    wire security, terminal and engine human input, live input, revision runtime, configuration
    generations, launch selection, all of `packages/store/test`, CLI formatting, containers):
    765 passed in 51 files.
  - `pnpm run typecheck` (including the renderer) and `pnpm run format:check` pass.
  - `pnpm run lint` passes. It needed `NODE_OPTIONS=--max-old-space-size=8192`; the default
    heap aborted with an out-of-memory error, not a lint finding.
