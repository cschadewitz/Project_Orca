# Documentation and design variance review — 13 October 2026

Every document in the repository was compared against the code, except the frozen
`Current_State/` folder. That covers `docs/` (design system, ADRs, contracts, implementation
notes, preparation packets, research and earlier reviews), the top-level `README.md`,
`AGENTS.md` and `CONTRIBUTING.md`, the package READMEs, and the design package
(`packages/design`). The work was split into eleven scopes and read in parallel.

This is a dated record, not a living spec. Its companion is the [code review](2026-10-13-code-review.md).

- **Pin:** `0c75d01eb0cab389ad1cbff5d1fb9a60bfe64362` (main, #628).
- **Method:**
  - Static. Nothing was built or run, except one read-only check by the D5 reviewer:
    `node tools/release.js notes --unreleased` (for D5-03). The D9 and D11 reviewers also ran
    the repository's Python fixture validators, which only read files.
  - Each reviewer read every assigned document in full. For every checkable claim (path,
    symbol, command, flag, method, error code, limit, state machine, behaviour, status) they
    opened the code and recorded a variance, citing file and line on both sides.
  - `Current_State/` was neither reviewed nor used as evidence.
  - Dated records (session logs, dated reviews, patches, evidence JSON) were treated as
    snapshots. They were flagged only where they make claims presented as current.
  - Preparation and proposal docs were not faulted for describing unbuilt work. They were
    flagged only where their stated status disagrees with the code, or where built code departs
    from an accepted contract.
  - Earlier reviews were consulted. A variance they had already recorded and that is still
    present is marked "previously recorded, still open".
  - All 23 variances first rated High were re-checked, by verifiers V1–V4 and V6 or by the
    lead. None was refuted. Seven stay High; sixteen drop to Medium or Low. Medium and Low
    variances were not independently verified.
- **Variance types:**
  - **stale-doc:** the doc describes what the code no longer does.
  - **contradicts-design:** the code departs from a binding rule, spec or contract.
  - **undocumented:** behaviour in the doc's scope that it leaves out.
  - **doc-conflict:** two docs disagree.
  - **status-mismatch:** a "built", "merged", "pending" or "future" claim is wrong.
  - **broken-reference:** a path, symbol or test that does not exist.
  - **missing-in-code:** the doc promises something the code does not provide.
- **Severity:**
  - **High:** misleads on security, data safety, release safety or a public contract, or
    breaks a binding design rule in a common path.
  - **Medium:** misleads on behaviour, commands, API or status.
  - **Low:** minor drift, naming or counts.

  Severities below are after verification.
- **Not covered:** pixels and layout (happy-dom has no layout engine and nothing was rendered),
  native, device and live-host claims, CI run history, and screen-reader behaviour.
- **Detail:** [`2026-10-13-review-detail/`](2026-10-13-review-detail/README.md) has each scope's
  full write-up, with coverage, every variance with its doc and code evidence, and the claims
  that were checked and found accurate.

## Summary

| Scope | Area | High | Medium | Low | All |
| --- | --- | --- | --- | --- | --- |
| [D1](2026-10-13-review-detail/D1.md) | Architecture, data model, ADRs, top-level guides | 1 | 5 | 14 | 20 |
| [D2](2026-10-13-review-detail/D2.md) | Workflows, planning, request and input contracts | 1 | 6 | 5 | 12 |
| [D3](2026-10-13-review-detail/D3.md) | Daemon, protocol, security, integrations, MCP operator |  | 7 | 10 | 17 |
| [D4](2026-10-13-review-detail/D4.md) | Runtime contracts, integration checkpoints, v0.5.2 checklists |  | 2 | 7 | 9 |
| [D5](2026-10-13-review-detail/D5.md) | Development, release, CI, roadmap, performance | 3 | 8 | 19 | 30 |
| [D6](2026-10-13-review-detail/D6.md) | Design rules, information architecture, attention, long-running content, connection states | 2 | 26 | 15 | 43 |
| [D7](2026-10-13-review-detail/D7.md) | Accessibility and keyboard, implementation guide, workflow editing, dependency graph, design package |  | 15 | 19 | 34 |
| [D8](2026-10-13-review-detail/D8.md) | Implementation notes: native, update, first-run, diagnostics |  | 7 | 6 | 13 |
| [D9](2026-10-13-review-detail/D9.md) | Preparation: crash recovery, diagnostics, native Mac |  | 7 | 10 | 17 |
| [D10](2026-10-13-review-detail/D10.md) | Preparation: private MCP, ACP, beta, first job, configuration and launch, prepared roots |  | 4 | 8 | 12 |
| [D11](2026-10-13-review-detail/D11.md) | Research, mobile proposals, follow-through of earlier reviews |  | 3 | 6 | 9 |
|  | **Total** | **7** | **90** | **119** | **216** |

| Variance type | High | Medium | Low | All |
| --- | --- | --- | --- | --- |
| stale-doc | 2 | 19 | 50 | 71 |
| contradicts-design | 5 | 32 | 17 | 54 |
| undocumented |  | 12 | 20 | 32 |
| doc-conflict |  | 14 | 12 | 26 |
| status-mismatch |  | 10 | 12 | 22 |
| broken-reference |  |  | 7 | 7 |
| missing-in-code |  | 3 | 1 | 4 |

What the 216 variances add up to:

1. **The living docs trail the last two weeks of merges.** Stale-doc and status-mismatch
   variances make up 93 of the 216. Most of them are shipped work still described as missing,
   future, blocked or pending: the
   Workflows surface and editor, guided launch, structured config, plugin restoration, admission
   retry, Windows first-run, the save-only diagnostics export and the disabled Mac updater. One
   reconciliation pass fixes most of it ([below](#the-reconciliation-pass)).
2. **A few statements are wrong in ways that matter for security or data.**
   - ADR 0008 still says the daemon is unauthenticated (D1-01).
   - Two code comments call the corrupt-sidecar fallback safe when it can drop a deny rule
     (D1-05, D11-01).
   - The intent journal is documented as never storing launch vars, but it does (D10-03).
   - The MCP launcher cannot use the access decision's read-only grant (D10-01).
   - The Windows diagnostics folder grants SYSTEM access without the approval its contract
     requires (D9-03).
   - Windows keys use DPAPI where the contract says safeStorage (D9-02).
   - The retry key limit is stated two ways (D3-01).
3. **The release docs describe a process that will fail as configured.** D5-01, D5-02 and D5-03
   are build and test defects as much as doc ones, and the code review lists them as release
   blockers.
4. **One doc is right and the code is wrong.** WORKFLOWS.md says `parallel` branches never see
   each other; in the code, later siblings see earlier siblings' artifacts (D2-01, the same
   finding as C2-01).
5. **The design system's binding rules are broken in several places, and the design docs
   contradict each other in twelve.**
   - The two Highs are focus dropped to the page body (D6-02) and the danger tone at rest
     (D6-03).
   - Medium rule breaks: confirm-in-place, extra live regions, controls inside list options, raw
     ids, native selects and wrapping rows.
6. **The protocol README describes about half of protocol 2.0.** Operator, admission,
   continuation, revision, template and workflow-draft methods, and the capability enum, are
   missing (D3-03 to D3-05, D3-08).

## Fix first

### High

| ID | Doc | What is wrong | Resolution |
| --- | --- | --- | --- |
| D1-01 | `docs/adr/0008-…md:68-73` | It says the control port is unauthenticated, that this is accepted, and that authentication "is not on the roadmap". Token authentication is the default, and unauthenticated loopback needs `--unauthenticated-loopback` (`packages/cli/src/commands/index.ts:736-740`). | Add a dated "superseded by" note to the ADR pointing at `daemon-security.md`. |
| D2-01 | `docs/WORKFLOWS.md:99-100` | It says parallel branches "never see each other". | Fix the code (C2-01), then say exactly which siblings are visible. |
| D5-01 | `docs/DEVELOPMENT.md`, app smoke | It says five surfaces and that the audited list is full. The smoke spec's shortcuts are wrong, and Workflows is never audited. | Fix the spec (code review, release blockers), then the doc. |
| D5-02 | `docs/RELEASING.md:33-47` | It says the release job re-runs CI's checks. It runs tests before the build and skips several checks. `ci-shadow-selection.md:422-424` admits the gap. | Fix the workflow (C8-03), then reconcile the two docs. |
| D5-03 | `changelog.d/README.md` | It says the section suffix is required. A committed fragment has none, and release notes fail. | Rename the fragment. |
| D6-02 | `RULES.md` rule 10, `AGENTS.md` "Do not drop focus" | Focus falls to the page body on ⌘1–⌘6, palette jumps, crumbs or `G`, on panel close, on mismatch-dialog close, and when the last Attention or inline card is answered. | Focus the new surface's landing control, or the region the leaving control belonged to. |
| D6-03 | `RULES.md` rule 17 | Destructive gate options and **Always deny** sit in the danger tone at rest. Diagnostics "Delete all and turn off" deletes in one click with no `✕` and no Keep. | Default tone at rest, with destructiveness carried by order and a `✕` when armed. The diagnostics delete arms in place, per rule 17. |

### The reconciliation pass

Each row is shipped work that docs still describe otherwise. Fix the docs in the right column
together.

| Shipped | Variances | Docs to update |
| --- | --- | --- |
| Workflows surface, editor and `workflowDrafts.*` (#610) | D1-02, D1-09, D1-12, D11-03, D5-09, D4-01, D8-07, D7-06, D3-03 | `README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/README.md`, `docs/runtime-operator-integration.md`, `docs/implementation/m10-security-contract-closure.md`, `packages/protocol/README.md`, `docs/design/60-implementation.md` |
| Guided launch, structured config, daemon-served form schema (#542, #548, #553) | D10-02, D5-10, D1-02 | `docs/ROADMAP.md`, `docs/README.md`, `docs/preparation/configuration-launch-implementation/` |
| Opt-in plugin restoration (#394) | D2-03, D4-08, D5-27, D1-07 | `docs/configuration-generations.md`, `docs/runtime-next-integration.md`, `examples/jev/RESTORATION.md`, `docs/EXTENSIBILITY.md` |
| `workflows.validateInputs` registered and advertised | D2-02, D3-10 | `docs/workflow-inputs.md`, `packages/protocol/README.md` |
| Admission retry live (`runs.admit`, `admissions.*`, `--idempotency-key`) | D2-06, D5-28, D3-04 | `docs/admission-retry.md`, `docs/performance/admission-retry-worker/README.md`, `packages/protocol/README.md` |
| Windows first-run and M21 native acceptance (#607) | D8-03, D11-07 | four first-run implementation notes, the two 9 October reviews |
| Save-only diagnostics export (preview removed), #470 merged | D8-01, D9-05, D8-12, D9-07 | `docs/implementation/diagnostics-byte-preview.md`, the native-mac beta guide, ledger and checklist, `docs/preparation/manual-diagnostics-implementation/` |
| Managed Mac updater merged with activation disabled | D11-04, D5-26, D10-09, D8-04, D8-05 | `docs/ROADMAP.md`, `docs/UPDATING.md`, `docs/preparation/beta-update-support/`, the mac-update implementation notes |
| Opt-in Linux maintenance observer | D1-13, D10-12 | `README.md`, `docs/README.md`, `docs/preparation/private-mcp-access/actual-cal-matrix.md` |
| Same-boot reconciliation (#570) | D9-04 | native-mac beta readiness docs |
| Native Mac candidate verification | D5-11 | `tools/deploy/tests/native-mac/README.md`, `tools/packaged-mac/README.md`, `docs/ROADMAP.md` |
| Protocol 2.0 and store epoch `operator-journals-v4` | D3-13, D4-07 | `docs/daemon-connection.md`, `docs/runtime-foundation-integration.md` |
| Token authentication by default | D1-01 | `docs/adr/0008-…md` |

### Design-doc conflicts to decide

These need a decision before code or docs can be made to agree:

- **D6-17:** the destructive-option digit rule is stated three ways, by doc 20,
  `component-api.d.ts` and `card-model.ts`.
- **D6-29:** in a stream, doc 30 says `G` re-enters following; doc 50 and the code use `⇧G`.
- **D6-30 / D7-08:** Config's Discard drops a draft with no confirmation, while the workflow
  editor arms its Discard.
- **D7-09:** doc 60 says reopening a decision does not confirm, and doc 80 says it asks once.
  The code does both.
- **D7-11:** "every pointer gesture has a keyboard path" is not true in the editor, and the docs
  say both.
- **D7-12:** `tokens.json` says keyboard selection uses `border-focus`, which the spec and a test
  forbid.
- **D6-27:** `semantics.json` says writes are "queued" while reconnecting; doc 40 and the code
  disable them.
- **D6-28:** doc 10 places notification settings in Config; no notification UI exists.
- **D3-08:** template and workflow-draft methods were added at protocol 2.0 without a minor
  version bump (previously recorded, still open).

## Follow-through on earlier reviews

D11 tracked 64 items from the seven earlier dated reviews and the tool-call-safety research:

- **Regressed:** none. The 24 "fixed" claims spot-checked from the
  [10 October design-conformance review](2026-10-10-design-conformance.md) all still hold.
- **Still open:** 38, one of them only partly done. These are:
  - seven tool-call-safety baseline gaps;
  - five fixes routed by the [7 October living-docs review](2026-10-07-living-docs.md) and
    never applied;
  - four gates held on purpose (C15, Mac updater activation, exact-command acceptance,
    diagnostics);
  - twenty design follow-ups.
- **Resolved:** 6, by later merges.
- **Could not be checked statically:** 7.

The D6 and D7 reviews also list, item by item, which 10 October design findings are still open.

## What was checked and found accurate

The reviewers confirmed many claims; these are the main ones. Each scope's detail file has its
full list.

- **Security docs:**
  - `daemon-security.md`'s permission matrix, audit column included, matches `OPERATIONS` in
    `auth/operations.ts` row for row.
  - Also as documented: token and credential handling, 0600/0700 file modes, transport
    refusals, the socket's 4401 close, `--read-only` omitting methods, the MCP tool list,
    host-resource limits, both plugin contracts, and the maintenance MCP being read-only.
- **Workflows and toolchain:**
  - The workflow schema, validator, routing, options, gates and completion defaults match
    WORKFLOWS.md.
  - The shipped workflows, templates and examples conform to the schema.
  - Toolchain versions, root scripts, `ci.yml`, the changelog check and the release-prepare
    version rules match DEVELOPMENT.md and RELEASING.md.
- **Design package and keyboard:**
  - `tokens.css` matches `tokens.json` for every colour in both themes and every scalar token.
  - Every row of doc 50's keyboard table except `Esc` is registered in the scope it names.
  - The connection machine matches doc 40: five states, a 5 s quiet window, give-up after three
    failures at the backoff cap, and file mode.
- **Contracts and fixtures:**
  - Diagnostics failure codes, resource limits, crypto and save ordering match their contract.
  - The Python fixture validator gives the documented result for all 6 valid and 21 invalid
    fixtures.
  - The ACP conformance and trusted-prepared-root fixtures validate against their schemas.
- **Links:** all relative links and anchors in the D1 and D11 scopes resolve, and all 209 paths
  in the 7 October doc inventory still exist.

## All variances

Grouped by scope, most severe first. Each entry gives severity (after verification) and
variance type, then the doc side, the code side and the suggested resolution. Verified entries
carry the verifier's note, and overlapping entries point at each other. Line numbers are as of
the pin.

### D1 — Architecture, data model, ADRs, top-level guides

Full write-up: [D1.md](2026-10-13-review-detail/D1.md).

- **D1-01** · **High** (confirmed) · stale-doc — ADR 0008 still says the daemon control port is unauthenticated and auth is "not on the roadmap"
  - *Doc:* `docs/adr/0008-daemon-protocol-and-desktop-app-in-one-workspace.md:68-73`
  - *Code:* `packages/cli/src/commands/index.ts:736-740`: `serve` help reads "Run the **authenticated** ORCA daemon" and "Token authentication is on by default …
  - *Resolution:* Update the doc. Add a dated "Superseded (#328)" note to that consequence: token auth is the default, unauthenticated loopback is an explicit opt-in, and authorization is per operation.
  - *Verified (lead):* `orca serve` help: "Token authentication is on by default"; ADR 0008:68-73 still says the port is unauthenticated.
- **D1-02** · **Medium** · status-mismatch — README and ARCHITECTURE say workflow editing, guided launch and structured collection editing are not built; they are
  - *Doc:* `docs/ARCHITECTURE.md:94-95`: "There is no filesystem watcher **or workflow editor**."
  - *Code:* Workflow drafts:** `packages/daemon/src/workflow-draft-methods.ts:1-6, 34ff` implements `workflowDrafts.get/open/apply/undo/redo/review/publish/discard`. It is mounted at `packages/daemon/src/methods.ts:976` …
  - *Resolution:* Update the doc:
  - *Related:* D5-09, D11-03, D1-09
- **D1-03** · **Medium** · stale-doc — DATA-MODEL gives the wrong store location and the wrong resume precedence for stored workflow definitions
  - *Doc:* `docs/DATA-MODEL.md:158-161`
  - *Code:* `packages/store/src/workflow-store.ts:7-12, 53-56, 81-86`: new snapshots are written with `writePrivateJson` to **`private-workflows/<id>@v<version>.json`** …
  - *Resolution:* Update the doc to match ARCHITECTURE. Name `private-workflows/` (encrypted) for new records and `workflows/` as legacy, and state the stored-first precedence and same-version refusal.
- **D1-04** · **Medium** · undocumented — DATA-MODEL's event-type list is incomplete (`continuation.recorded`, `revision.recorded`, protected-execution envelope fields)
  - *Doc:* `docs/DATA-MODEL.md:128-137`: "Every event is `{ id, seq, runId, at, type, payload }`. Types: …" lists run, step, agent, artifact, decision, loop, child, branch and human events.
  - *Code:* `packages/core/src/events/events.ts`:
  - *Resolution:* Update the doc. Add the two event types and the envelope fields, and link `protected-execution-storage.md` and `revision-input.md` for the details.
- **D1-05** · **Medium** · doc-conflict — Sidecar-fallback security claim: ADR 0009's 2026-10-01 clarification contradicts the in-code documentation
  - *Doc:* `docs/adr/0009-permission-grants-in-a-workspace-sidecar.md:128-133` says the corrupt-sidecar fallback "can lose restrictions too: the sidecar schema allows deny/ask rules …
  - *Code:* The behaviour matches the ADR. `packages/agents/src/acp-session.ts:120-128` skips an unreadable sidecar, and `effectivePermissionPolicy` (`packages/core/src/model/agent.ts:289-298`) then appends `DEFAULT_PERMISSION_POLICY`'s in-workspace …
  - *Resolution:* Decide. At minimum fix the two code comments to match the ADR. If fail-closed is wanted, make a corrupt sidecar suppress default rules or refuse the ask, and update the ADR.
  - *Related:* D11-01, C4-01
- **D1-06** · **Medium** · contradicts-design — `@orca/protocol` now ships Node-only file and process fences and a native-addon loader that reaches into `packages/app`; docs still call it the wire contract that depends only on core
  - *Doc:* `docs/adr/0008-…:21-24`: "`packages/protocol` is the wire contract: message envelope …, the `hello` handshake, error codes and a `major.minor` protocol version. Zod schemas … It depends on `core` for the domain types and on nothing else."
  - *Code:* `packages/protocol/package.json` exports `./update-window` and `./first-run-fence`.
  - *Resolution:* Decide. Either record this deliberate exception (Node-only subpaths, never from the renderer barrel) in ADR 0008, ARCHITECTURE and README, or move the fences to a separate shared Node package and drop the `../../app/native` path.
- **D1-07** · **Low** · undocumented — EXTENSIBILITY omits the plugin restoration seam (`OrcaPlugin.restoration`, `PluginApi.restorationIdentity`)
  - *Doc:* `docs/EXTENSIBILITY.md:8-14` says historical restoration "fails closed without an explicit restoration contract".
  - *Code:* `packages/engine/src/plugin.ts:104-121` defines `PluginRestoration` (`identity`, `capture`, `validate`, `restore`) and `PluginRestorationApi`.
  - *Resolution:* Update the doc. Add a "Restoration (opt-in, executors only)" row pointing at `engine/plugin.ts` and `examples/jev/RESTORATION.md`.
  - *Related:* D2-03
- **D1-08** · **Low** · stale-doc — The app's import boundary has undocumented exceptions, and ADR 0008 has other stale statements
  - *Doc:* `docs/adr/0008-…:29-31`: "`packages/app` depends on `protocol` **only**".
  - *Code:* `packages/app/package.json:27-28` lists `@orca/daemon` in devDependencies.
  - *Resolution:* Update the doc. Record the test and devDependency exemption, add `design` to the ADR, and add dated notes for the WebSocket and the association validation.
- **D1-09** · **Low** · stale-doc — README says "five surfaces"; the app has six (Workflows)
  - *Doc:* `README.md:90-98`: "All five surfaces have content: Attention, Runs, Plan, Agents and Config".
  - *Code:* `packages/design/src/tokens.ts:292`: `SURFACE_IDS = ['attention','runs','plan','workflows','agents','config']`.
  - *Resolution:* Update the doc. Six surfaces; add Workflows (list, viewer, editor).
- **D1-10** · **Low** · undocumented — The persistence extension seam lists 4 ports; `Stores` requires 7
  - *Doc:* `docs/EXTENSIBILITY.md:45`: "Persistence (SQLite, Postgres) | `EventStore`, `ArtifactStore`, `DocumentStore`, `ClaimStore`".
  - *Code:* `packages/store/src/document-store.ts:225-240` (`interface Stores`) also requires `LeaseStore` (`lease-store.ts:74`), `ExecutionStore` (protected …
  - *Resolution:* Update the doc. List the full `Stores` port set and note that execution and workflow-version stores hold protected material.
- **D1-11** · **Low** · broken-reference — ARCHITECTURE names the wrong `SubscriptionSource` method
  - *Doc:* `docs/ARCHITECTURE.md:134-136`: "a narrow `SubscriptionSource` seam (`subscribe(listener, filter)` + `events(runId)`) that `Orchestrator` satisfies structurally".
  - *Code:* `packages/daemon/src/subscriptions.ts:50-58` declares `subscribe(...)` and **`eventsRange(runId, range?)`**, a paged read (#208). It is satisfied by `Orchestrator.eventsRange` (`engine/src/orchestrator.ts:602`).
  - *Resolution:* Update the doc to `eventsRange(runId, { after })`.
- **D1-12** · **Low** · stale-doc — `docs/README.md` index says the editor is still a proposal
  - *Doc:* `docs/README.md:21`: "Design / binding UI rules — … editor proposals are identified as future work".
  - *Resolution:* Update the doc: "the workflow editor is built; dry run (#183) remains future work".
- **D1-13** · **Low** · doc-conflict — README and the docs index call maintenance-mcp "refusal-only"; it now has an opt-in Linux observer
  - *Doc:* `README.md:142`: "Independent read-only maintenance contract and refusal-only preparation".
  - *Resolution:* Update the doc: "read-only contract; default entry refuses, opt-in fixed Linux observer; not activated".
  - *Related:* D10-12
- **D1-14** · **Low** · doc-conflict — AGENTS' notification guidance contradicts ARCHITECTURE and omits `input.invalidated`
  - *Doc:* `AGENTS.md:177-178` lists the methods to listen to and omits `input.invalidated`.
  - *Code:* `packages/protocol/src/subscriptions.ts:66-78` has 11 methods, including `input.invalidated`.
  - *Resolution:* Update the doc. In AGENTS, list `input.invalidated` (runId, no seq, not replayed) and say `agent.changed` is one of four store-wide notifications.
- **D1-15** · **Low** · undocumented — Repo map and layering omit the inbound MCP operator adapter, the integrations→protocol edge, and two packages
  - *Doc:* `README.md:135`: `packages/integrations` = "ORCA as an ACP agent …, Kepler …, T3 Code adapter …, the `custom:jev-eval` plugin".
  - *Code:* `packages/integrations/src/mcp/` holds the inbound MCP operator adapter (`index.ts:1`, "Public entry points for the inbound ORCA MCP adapter"), reached by `orca mcp` (`packages/cli/src/commands/index.ts:276-277`).
  - *Resolution:* Update the doc. Add `mcp` (operator adapter) to the integrations row and diagram, draw integrations→protocol, and mention `testing` and `maintenance-mcp` in ARCHITECTURE's layering.
- **D1-16** · **Low** · doc-conflict — ARCHITECTURE says core does no I/O beyond parsing files; README says otherwise, and core writes JSONL
  - *Doc:* `docs/ARCHITECTURE.md:45`: "`core` has no I/O beyond parsing files."
  - *Code:* `packages/core/src/util/jsonl.ts:6, 97`: `appendJsonl` uses `appendFile`. It is used by `store/src/jsonl-log.ts:382` and `testing/src/scripted-agent/agent.ts:115`.
  - *Resolution:* Update ARCHITECTURE to README's wording.
- **D1-17** · **Low** · stale-doc — DATA-MODEL says only `parseDependencyRef()` checks the dependency grammar; the schema now runs it too
  - *Doc:* `docs/DATA-MODEL.md:54-55`: "Only `parseDependencyRef()` checks the grammar (the schema checks shape)".
  - *Code:* `packages/core/src/model/plan.ts:374-381`: `DependencyRefSchema = StoredDependencyRefSchema.superRefine(… parseDependencyRef(ref) …)`. The grammar is validated by the schema used in `DecompositionItemSchema.dependsOn` (`request.ts:165`).
  - *Resolution:* Update the doc. Intake schemas validate the grammar; stored refs keep their raw legacy shape.
- **D1-18** · **Low** · undocumented — DATA-MODEL's config, workflow and run field lists miss current keys
  - *Doc:* `docs/DATA-MODEL.md:195-203` (Config).
  - *Code:* `packages/core/src/config.ts:54-62` has `version` and `admissionRetry.{maxClaimsPerWorkspace,maxClaimsPerPrincipal}`; `config.ts:22-23` adds the git-worktree `isolateRoots`.
  - *Resolution:* Update the doc, or link `workflow-inputs.md`, `admission-retry.md` and `root-worktree-isolation.md`.
- **D1-19** · **Low** · stale-doc — DATA-MODEL says `run_` ids are ULIDs; admitted runs use UUIDs
  - *Doc:* `docs/DATA-MODEL.md:5-8`: "Generated temporal identifiers are prefixed ULIDs (`req_…`, `wi_…`, `run_…` …)". The hedge "do not infer a timestamp from every ID" follows.
  - *Code:* `packages/engine/src/direct-admission.ts:136` and `packages/engine/src/program/request-submission.ts:257` mint `run_${randomUUID()}`.
  - *Resolution:* Update the doc. Admitted runs use `run_<uuid>`; others use `run_<ULID>`.
- **D1-20** · **Low** · broken-reference — AGENTS points `useAnnounce()` at the wrong file
  - *Doc:* `AGENTS.md:275-276`: "goes through `useAnnounce()` (`a11y/announce.ts`)".
  - *Code:* `useAnnounce` is defined in `packages/app/renderer/src/a11y/announce-context.tsx:29`.
  - *Resolution:* Update the doc: "`useAnnounce()` (`a11y/announce-context.tsx`, over the channel in `a11y/announce.ts`)".

### D2 — Workflows, planning, request and input contracts

Full write-up: [D2.md](2026-10-13-review-detail/D2.md).

- **D2-01** · **High** (confirmed) · contradicts-design — Earlier finished `parallel` / `plan-dispatch` siblings are visible as artifact inputs, but WORKFLOWS.md says parallel branches "never see each other"
  - *Doc:* docs/WORKFLOWS.md:95-100. Only loop iterations see earlier siblings; "`parallel` branches run concurrently and so never see each other."
  - *Code:* `packages/engine/src/run-context.ts:199-258`: `visibleArtifacts()` adds every *earlier sibling*, meaning any child of the same container step that was spawned earlier and has `completedAt <= run.createdAt` …
  - *Resolution:* fix code. Limit earlier-sibling visibility to `loop` steps, or scope it by branch or work item. If cross-branch visibility is intended, at least document it in WORKFLOWS.md.
  - *Verified (verifier V1):* Same defect as C2-01, seen from the docs: the code, not the doc, is wrong.
  - *Related:* C2-01
- **D2-02** · **Medium** · status-mismatch — workflow-inputs.md says `workflows.validateInputs` is "not yet registered or advertised"; it is wired, advertised, and WORKFLOWS.md tells authors to use it
  - *Doc:* docs/workflow-inputs.md:149-152: "Reserved in `@orca/protocol` … It is not yet registered or advertised; authorization (#328) and wiring land at integration."
  - *Code:* `packages/daemon/src/methods.ts:969` registers the method when `ctx.workflowInputs` is set.
  - *Resolution:* update doc. Say the method is registered when the daemon has a control/preflight model and is authorized by `runs.start`, and fix the protocol source comment.
  - *Related:* D3-10
- **D2-03** · **Medium** · status-mismatch — configuration-generations.md says no plugin restoration contract exists; #394's opt-in, verified custom-executor restoration is implemented
  - *Doc:* docs/configuration-generations.md:92-99 and 113-119.
  - *Code:* `packages/engine/src/plugin.ts:97-133`: `PluginRestorationIdentity`, `PluginRestoration {identity, capture, validate, restore}`, records with `contractVersion: 1`.
  - *Resolution:* update doc. Describe the v1 opt-in contract: custom executors only, identity verification, and the refusal reasons in `PluginRestorationReason`. Keep "non-opted plugins and host/workspace/extractor callbacks remain bootstrap-bound".
  - *Related:* D4-08, D5-27, D1-07
- **D2-04** · **Medium** · undocumented — Reloadability table implies roles/program/workflows/templates apply live, but any configured plugin makes every `config.apply` return `restart-required`
  - *Doc:* docs/configuration-generations.md:66-80. The table marks `roles`, `program`, `workflows` and `templates` as applied live. Line 79-80 says only that "refreshing plugin-backed assets is refused by the bootstrap loader; restart is required."
  - *Code:* `packages/engine/src/configuration-generation.ts:254-259`: `apply()` returns `restart-required` with `restartRequired: ["plugins"]` whenever `parsed.data.plugins.length` is non-zero. It does this before preparing anything …
  - *Resolution:* decide.
- **D2-05** · **Medium** · stale-doc — PLANNING.md item-workflow precedence omits the per-run override (`--item-workflow` / `overrides.itemWorkflow`) and the `override` source
  - *Doc:* docs/PLANNING.md:131-137. The order is the item's `workflowId`, then the node pin, then `vars.itemWorkflow`. The result records "`itemWorkflowSource` (`node` or `var`)".
  - *Code:* `packages/engine/src/plan/executors.ts:536-544`: `overrides.itemWorkflow` beats `vars.itemWorkflow`, and `itemWorkflowSource` is `"node" | "override" | "var"`. The warning at :545 compares against the override as well.
  - *Resolution:* update doc. Add the override step and the `override` source, and add `--item-workflow` (plus `--agent`/`--model`) to the CLI line.
- **D2-06** · **Medium** · status-mismatch — admission-retry.md still reads as an unapplied feature-branch handoff; its "reserved patch" wiring is live
  - *Doc:* docs/admission-retry.md:3-9: shared bootstrap/protocol/auth/adapter changes "are not applied to this branch. This document does not claim production capability discovery …"
  - *Code:* `packages/daemon/src/methods.ts:393,910-925` register and advertise `runs.admit`, `admissions.get` and `admissions.reconcile`.
  - *Resolution:* update doc. Add the same dated "Current reading" header the sibling docs carry, stating that the wiring is integrated on main and naming any residual acceptance gates.
- **D2-07** · **Medium** · undocumented — WORKFLOWS.md never says that deliverables are written to per-attempt `.orca-attempts/<runId>/<stepRunId>/` paths, not the declared `produces[].path`
  - *Doc:* docs/WORKFLOWS.md:19-22, 77-81 and 318-319. `produces[].path` is presented as the deliverable path, for example `.orca/work/{{ workItem.slug }}/implementation.md`, and "ORCA appends the deliverables block".
  - *Code:* `packages/engine/src/executors/agent-step.ts:72-84`: the rendered path is rewritten to `<dir>/.orca-attempts/<runId>/<stepRunId>/<filename>`.
  - *Resolution:* update doc. Add a sentence to WORKFLOWS.md "Templates"/`produces` that the declared path chooses the directory and filename, and say where the file actually lands.
- **D2-08** · **Low** · stale-doc — workflow-inputs.md "Outstanding integration gate" still says sensitive values are unprotected and the storage design is "not implemented"
  - *Doc:* docs/workflow-inputs.md:192-233.
  - *Code:* protection is implemented:
  - *Resolution:* update doc. Change to past tense ("the #330 slice did not…") or collapse the section to a pointer to protected-execution-storage.md.
- **D2-09** · **Low** · status-mismatch — revision-input.md says `REVISION_STALE` is reserved and "until that enum is integrated" fixtures use `RUN_STATE`; the code is integrated
  - *Doc:* docs/revision-input.md:172-174.
  - *Code:* `packages/core/src/errors.ts:35` defines `"REVISION_STALE"`.
  - *Resolution:* update doc. State that `REVISION_STALE` is the shipped code.
- **D2-10** · **Low** · undocumented — The `orca revisions` CLI is undocumented; revision-input.md still lists "wire the CLI command parser" as integrator work
  - *Doc:* docs/revision-input.md:166-171 describes only the `RevisionInputClient` helper.
  - *Code:* `packages/cli/src/commands/index.ts:527-532` registers `revisions <discover <runId>|inspect|submit|replace>`, which requires `--endpoint`/`ORCA_DAEMON_URL`, `--body-file` and `--idempotency-key`.
  - *Resolution:* update doc. Add a short "CLI" paragraph covering usage, the required retained key and the daemon-only behavior.
- **D2-11** · **Low** · undocumented — The replay error contract omits the fixed `details.diagnostics.protectedState: "unavailable"` tag now attached to both protected diagnostics
  - *Doc:* docs/protected-replay-error-contract.md:76-93. Only the two fixed `RUN_STATE` messages are admitted, with "no new public error code or configurable diagnostic". The doc dates from #489 (2026-10-04).
  - *Code:* `packages/store/src/protected-file.ts:44-61`: `unreadable()` and `protectedRecordInvalid()` both carry `protectedDiagnostic = { diagnostics: { protectedState: "unavailable" } }`. This was added in #607 on 2026-10-09.
  - *Resolution:* update doc. Note the fixed, non-identifying details tag and that clients key on it.
- **D2-12** · **Low** · undocumented — WORKFLOWS.md node and field reference omits several schema fields and defaults
  - *Doc:* docs/WORKFLOWS.md:55-81. The node table and the "Defaults not shown above" paragraph omit the following:
  - *Resolution:* update doc. Add the missing fields and defaults, and cross-link revision-input.md for `revision`.

### D3 — Daemon, protocol, security, integrations, MCP operator

Full write-up: [D3.md](2026-10-13-review-detail/D3.md).

- **D3-01** · **Medium** · doc-conflict — MCP retry key limit is wrong in `mcp-operator.md` and contradicts the production contract
  - *Doc:* `docs/mcp-operator.md:151-152`: "`retry: {idempotencyKey}` is required by MCP (maximum 200 characters)". The other doc says the opposite: `docs/mcp-operator-production-contract.md:11`: "Its limit is 1–128 UTF-8 bytes, never 200 characters."
  - *Code:* `packages/protocol/src/admission-retry.ts:6-9` defines `RetryKeySchema` as 1–128 UTF-8 bytes. MCP `retry` uses it (`packages/protocol/src/operator-mutations.ts:18`). A key of 129–200 characters …
  - *Resolution:* Update `mcp-operator.md` to say "1–128 UTF-8 bytes".
- **D3-02** · **Medium** · undocumented — `PROTOCOL_VERSION` is listed as a wire code, but the daemon refuses a version mismatch with `NOT_SUPPORTED`
  - *Doc:* `packages/protocol/README.md:37-38` lists `PROTOCOL_VERSION` among the codes on the wire. Line 166 says "Major versions must match before normal client operation". The `hello` section (154-176) never says how an incompatible `hello` is …
  - *Code:* `packages/daemon/src/methods.ts:366-375`. The daemon's `hello` throws `OrcaError("NOT_SUPPORTED", "client speaks protocol …", {client, daemon})` when `isCompatible` fails …
  - *Resolution:* Decide. Either have `hello` throw `ProtocolFault("PROTOCOL_VERSION")`, or document that a mismatch answers `NOT_SUPPORTED` with `details.client` and `details.daemon` and that `PROTOCOL_VERSION` is client-synthesized.
- **D3-03** · **Medium** · undocumented — The protocol README leaves out most of the 2.0 method and capability inventory
  - *Doc:* `packages/protocol/README.md:1-4,8` calls itself "The wire contract" and says "Everything below is exported…". Lines 161-166 and 744-745 say the operator, admission and revision families exist, but the README never names or specifies them.
  - *Code:* The daemon installs these methods under the stated conditions:
  - *Resolution:* Update the doc. Add an inventory table (method → schema module → install condition → grant) plus the capability enum, or link each family to its owning doc.
- **D3-04** · **Medium** · undocumented — `runs.start` reference is incomplete: missing params and a different code path under default `orca serve`
  - *Doc:* `packages/protocol/README.md:807-822`: `params: { workflowId; vars = {}; requestId?; workItemId? }`. It describes a launch through the orchestrator. The 1.9 section (77-80) mentions only `workflowVersion` and `expectedWorkflowRevision`.
  - *Code:* `packages/protocol/src/control.ts:154-170`. `RunsStartParamsSchema` also has `idempotencyKey`, `workflowVersion`, `expectedConfigGeneration` and `expectedWorkflowRevision`.
  - *Resolution:* Update the doc with the full params, the durable-admission path and its `RUN_STATE` reconcile refusal.
- **D3-05** · **Medium** · undocumented — Maintenance admission section is incomplete: `maintenance.runtime`, drain semantics and env-var configuration
  - *Doc:* `packages/protocol/README.md:86-112`.
  - *Code:* `packages/daemon/src/maintenance.ts`:
  - *Resolution:* Update the README, or `UPDATING.md` with a README link, to cover `maintenance.runtime`, drain and defer, the durable gates and the two env vars.
- **D3-06** · **Medium** · missing-in-code — `orca agents` "models discovered" can never be populated from a daemon
  - *Doc:* `docs/INTEGRATIONS.md:122-124`: "models a running daemon has discovered are shown when `agents.list` carries them, otherwise the line reads 'not probed'".
  - *Code:* `AgentViewSchema` has no `models` field (`packages/protocol/src/agents.ts:48-75`), and the daemon's `agentView` never emits one (`packages/daemon/src/agent-model.ts:129-146`). The CLI reads `a.models` …
  - *Resolution:* Decide. Either add `models` to `AgentView` (a protocol minor) and project discovered options, or change the doc to say the CLI shows declared models only.
- **D3-07** · **Medium** · undocumented — The JEV section leaves out restart restoration limits and the beta deferral
  - *Doc:* `docs/INTEGRATIONS.md:216-401`. It presents `plugins: ["@orca/integrations/jev-eval"]` as the setup, with no mention of restart behavior or beta status.
  - *Code:* The default plugin has no `restoration` hook (`packages/integrations/src/jev/plugin.ts:18-25,51-53`). Under `docs/contracts/plugin-restoration-v1.md`'s table ("Legacy behavior-bearing plugin | New bootstrap → Refused") …
  - *Resolution:* Update the doc. Add a "Restart and beta status" note linking `plugin-restoration-v1.md` and `examples/jev/RESTORATION.md`.
- **D3-08** · **Low** · contradicts-design — Template and workflow-draft methods were added at protocol 2.0 without a minor bump, and the version history is silent
  - *Doc:* `packages/protocol/README.md:8-22`: version history up to 2.0. `version.ts:12-14,95-115`: the rule says added methods bump the minor.
  - *Code:* `templates.*` and `workflowDrafts.*` are installed (`methods.ts:973-977`), but `PROTOCOL_VERSION` stays `{2,0}` (`version.ts:116`) and neither the README nor `version.ts` history mentions them.
  - *Resolution:* Decide. Bump to 2.1 with a history entry, or write the exception into `version.ts` and the README.
- **D3-09** · **Low** · undocumented — The `daemon-security.md` permission table leaves out `host.telemetry.read`
  - *Doc:* `docs/daemon-security.md:92-110` lists 15 permissions under "A credential holds a list of these permissions". `host.telemetry.read` appears only in the presets (`:146-147`) and the matrix (`:174`).
  - *Code:* `packages/daemon/src/auth/principal.ts:24-58`. `PERMISSIONS` has 16 entries, the first being `host.telemetry.read`, which is not a workspace permission, so restricted scopes may hold it (`:66-75`).
  - *Resolution:* Update the doc. Add a row marked "explicit opt-in; never in a preset; allowed for restricted scopes; proposal per host-resource-access-policy".
- **D3-10** · **Low** · status-mismatch — `workflows.validateInputs` is labelled "reserved" although it is implemented and advertised
  - *Doc:* `docs/daemon-security.md:199`: "(reserved for #330)". By contrast, `packages/protocol/README.md:72-80` describes it as added in 1.9.
  - *Code:* It is registered when `workflowInputs` is wired (`packages/daemon/src/methods.ts:969`), and `orca serve` always wires it and advertises the capability (`packages/cli/src/commands/index.ts:1223,1233`). Stale "reserved" markers remain at …
  - *Resolution:* Update the security doc row and drop the stale `reserved` comments and flag.
  - *Related:* D2-02
- **D3-11** · **Low** · doc-conflict — The protocol README's control-method table gives `config.set` only `config.write`
  - *Doc:* `packages/protocol/README.md:741`: "`config.set`, `config.apply` | `config.write`". Also `:466-467`: "current operation authority requires `config.write`".
  - *Code:* `packages/daemon/src/auth/operations.ts:197-202`. `config.set` also requires `config.read`, and discovery omits it without both (`guard.ts:196`). `docs/daemon-security.md:109,117-121` documents both grants.
  - *Resolution:* Update the README row to "`config.write` + `config.read` (set); `config.write` (apply)".
- **D3-12** · **Low** · broken-reference — The README's "method lookup" line anchor points at the wrong lines
  - *Doc:* `packages/protocol/README.md:173-174` links `../daemon/src/server.ts#L187-L195` as the method lookup. The paired guard anchor `guard.ts#L176-L187` is correct.
  - *Code:* `server.ts:187-195` is the `fail` helper, parse and kind checks. The method lookup is at `server.ts:202-203`, and the authorize call is at `:195-200`.
  - *Resolution:* Change the anchor to `#L202-L203`, or link the function by name.
- **D3-13** · **Low** · stale-doc — `daemon-connection.md` still says the combined protocol is 1.10
  - *Doc:* `docs/daemon-connection.md:116-117`: "Hello identity is additive and the combined protocol minor is 1.10". This sits in the present-tense "are wired in this tree" section. The doc's own header (`:3-4`) says main is 2.0.
  - *Code:* `packages/protocol/src/version.ts:116` is `{ major: 2, minor: 0 }`.
  - *Resolution:* Update the doc: "introduced in 1.10; current main is 2.0".
- **D3-14** · **Low** · status-mismatch — The production-contract preparation doc reads as current state that main has since replaced
  - *Doc:* `docs/mcp-operator-production-contract.md:3`: "It installs no handler, grant, capability, transport or production adapter." `:62`: "currently absent hooks correctly report owner-unavailable." Neither has a historical marker or a forward …
  - *Code:* All ten aliases are mounted when their services exist (`packages/daemon/src/operator-mutations.ts:20-164`), with grants in `auth/operations.ts:73-92` and capabilities in `methods.ts:383`. The CLI wires `liveState` and `liveRevision` …
  - *Resolution:* Update the doc. Add a dated "implemented on main; see mcp-operator.md" banner and fix the stale code comment.
- **D3-15** · **Low** · status-mismatch — `installed-plugin-release-v1.md` says the launcher wiring is unimplemented; a guarded seam and launcher exist
  - *Doc:* `docs/contracts/installed-plugin-release-v1.md:103-104,114-115`: "The ordinary CLI `serve` command does not supply `BootstrapOptions.installedPluginRelease`" (true) and "The launcher wiring and any real installation/launch remain …
  - *Code:* `serveWithInstalledPluginRelease` is a public CLI export (`packages/cli/src/commands/index.ts:961-973`, `packages/cli/src/index.ts:6`). It refuses `--unauthenticated-loopback` and passes the pin into bootstrap.
  - *Resolution:* Update the doc to name the seam and the unapproved launcher, and say that approval is the remaining gate.
- **D3-16** · **Low** · stale-doc — The status-fold table leaves out `created` plus a lapsed lease → `stale`
  - *Doc:* `packages/protocol/README.md:143-144`: `created` → `blocked`; "`running`/`waiting` with a lapsed or absent run lease → `stale`".
  - *Code:* `packages/protocol/src/status.ts:84-85`, in `displayStatusForRun`: `case "created": return ctx.leaseLapsed ? "stale" : "blocked";`.
  - *Resolution:* Update the table row to "`created`/`running`/`waiting` with a lapsed lease → `stale`".
- **D3-17** · **Low** · undocumented — The `/rpc` 1 MB body limit and HTTP 413 are undocumented
  - *Doc:* The README transport section (`:26-58`) and the HTTP status table in `docs/daemon-security.md:332-339` list 401, 403 and 200 outcomes only.
  - *Code:* `packages/daemon/src/server.ts:137,145,958-961`. A body over 1,000,000 bytes is answered with HTTP 413 and a `{kind:"response", id:0, ok:false}` envelope.
  - *Resolution:* Update the doc with one line in the transport section or the status table.

### D4 — Runtime contracts, integration checkpoints, v0.5.2 checklists

Full write-up: [D4.md](2026-10-13-review-detail/D4.md).

- **D4-01** · **Medium** · stale-doc — The evidence map says workflow-draft ownership is outside the auth inventory, but #180 drafts have shipped with grants and per-principal ownership
  - *Doc:* docs/runtime-operator-integration.md:15 (Limit column of the "Direct daemon HTTP/WS enforce…" row) says "Workflow-editor draft ownership …
  - *Code:* The `auth/operations.ts` inventory now holds eight `workflowDrafts.*` operations: packages/daemon/src/auth/operations.ts:154-193. `get` needs `config.read`. `open/apply/undo/redo/review/publish/discard` need `config.write` plus …
  - *Resolution:* Update the doc. Record that `workflowDrafts.*` (#180/#610) is inventoried with config.read/config.write and per-principal draft ownership. Narrow the limit to "no HTTP/WS security-suite coverage; secret references and #336 migration absent". docs/implementation/m10-security-contract-closure.md:58 ("Neither API/model ships at this pin") has the same drift outside this scope.
  - *Related:* D8-07
- **D4-02** · **Medium** · contradicts-design — Revision retry operationIds cannot be inspected or reconciled through `admissions.get/reconcile`, which contradicts the frozen sealed-kind dispatch, and the in-progress envelope still advertises "inspect"
  - *Doc:* docs/runtime-operator-parallel-contract.md:629-635 freezes "shared service `inspect(operationId…)` and `reconcile(operationId…)` … Wire inventory: `admissions.get` and `admissions.reconcile`, with fixed registered operation kinds".
  - *Code:* packages/daemon/src/admission-retry.ts:121-165 dispatches only `request.submit` and `run.admit`. Every other kind (`revision.submit`, `revision.replace` …
  - *Resolution:* Decide between two options. One is to add a revision-kind receipt dispatcher, as the contract specifies. The other is to state in the evidence map and in docs/revision-input.md / docs/mcp-operator.md that revision operationIds are recoverable only by same-key replay, and annotate the contract.
- **D4-03** · **Low** · contradicts-design — The frozen `OPERATOR_CURSOR_STALE` error code was never added; cursor staleness is a `restartRequired` page
  - *Doc:* docs/runtime-operator-parallel-contract.md:969-971: "Add core `RETRY_CONFLICT`, `RETRY_LIMIT`, `REVISION_STALE`, `CONTINUATION_STALE` and `OPERATOR_CURSOR_STALE` through the integrator's reserved errors patch".
  - *Code:* packages/core/src/errors.ts:5-58 has the other four codes but no `OPERATOR_CURSOR_STALE`. A repo-wide grep finds the string only in this doc.
  - *Resolution:* Update the doc. Annotate the contract to say cursor staleness is signalled by `restartRequired: true` and no `OPERATOR_CURSOR_STALE` code exists.
- **D4-04** · **Low** · stale-doc — The MCP server SDK is pinned to 2.3.0, but the operator docs still state 2.2.0
  - *Doc:* docs/runtime-operator-integration.md:124: "Exact SDK server/client/core 2.2.0 dependencies and MCP exports".
  - *Code:* packages/integrations/package.json:33 and packages/maintenance-mcp/package.json:22 pin `@modelcontextprotocol/server` `2.3.0`.
  - *Resolution:* Update the doc. Note in the integration doc (and annotate the contract) that the server is now 2.3.0 while client/core stay 2.2.0.
- **D4-05** · **Low** · stale-doc — Sections headed "Current" or "Remaining", and present-tense limitations, in the integration doc are superseded by later sections and by the code
  - *Doc:* docs/runtime-operator-integration.md:
  - *Code:* Ten MCP mutation aliases are mounted: packages/daemon/src/operator-mutations.ts:19-165; methods.ts:383, :985; server.ts:700.
  - *Resolution:* Update the doc. Re-head these as dated checkpoints, or add one-line "superseded by §…" notes. Keep only Request/direct startup dispatch as open.
- **D4-06** · **Low** · stale-doc — The "current" evidence map is pinned to 4 October, and the previous review's 7 October forward note was never added
  - *Doc:* docs/runtime-operator-integration.md:3-5 ("As of 4 October 2026, main is `94a02bd…`") and :16 (the actual-Cal row ends at the 2026-10-04 discovery).
  - *Resolution:* Update the doc. Re-pin the map to a current SHA, or add the dated forward note proposed by the previous review.
- **D4-07** · **Low** · stale-doc — runtime-foundation-integration.md states protocol 1.9 and store epoch protected-execution-v2 in the present tense, while living docs route readers to it for current boundaries
  - *Doc:* docs/runtime-foundation-integration.md:18: "Protocol 1.9 registers `workflows.validateInputs`…".
  - *Code:* packages/protocol/src/version.ts:116 has `PROTOCOL_VERSION = {major: 2, minor: 0}`.
  - *Resolution:* Update the doc. Add a dated header or forward note to both integration docs naming current protocol 2.0 / operator-journals-v4, or point the living docs at runtime-operator-integration.md instead.
- **D4-08** · **Low** · stale-doc — runtime-next-integration.md says custom executors always bind a generation to their bootstrap, but #394 opt-in restoration has shipped and the operator contract was updated
  - *Doc:* docs/runtime-next-integration.md:45-50: "Custom executors, plan callbacks and plugin provider/host closures with unrecorded state bind the entire generation to its original bootstrap lifetime… restarting the engine process crosses the …
  - *Code:* Plugins can opt in to versioned restoration of custom executors after installed-code and dependency verification: packages/engine/src/plugin.ts:21-30 (PluginRestorationData); changelog.d/394-plugin-restoration.added.md …
  - *Resolution:* Update the doc with a one-line forward note that #394 opt-in restoration exists for verified custom executors. Host, workspace, plan and input callbacks remain unsupported.
  - *Related:* D2-03
- **D4-09** · **Low** · status-mismatch — The operator parallel contract's header still says "specifies future interfaces", while later edits add present-tense status and the code has implemented everything
  - *Doc:* docs/runtime-operator-parallel-contract.md:
  - *Code:* Every frozen interface and file listed at :475-527 and :735-740 exists and is production-wired:
  - *Resolution:* Update the doc. Add a one-line dated status note at the top: implemented and integrated, see the runtime-operator-integration evidence map. Alternatively, move the 9 October current-status paragraphs to the integration doc.

### D5 — Development, release, CI, roadmap, performance

Full write-up: [D5.md](2026-10-13-review-detail/D5.md).

- **D5-01** · **High** (confirmed) · stale-doc — App smoke still targets the five pre-#610 surfaces with stale ⌘ shortcuts; the Workflows surface is never audited (release gate)
  - *Doc:* docs/DEVELOPMENT.md:536-548. "axe finds no violations on **any of the five surfaces** in either theme … As of v0.5.0 the list is full …
  - *Code:* There are now six surfaces: packages/design/src/tokens.ts:292 `SURFACE_IDS = ['attention','runs','plan','workflows','agents','config']`.
  - *Resolution:* fix code. Derive AUDITED shortcuts from `SURFACES` (or update them to 5/6), add a `workflows` entry with a content-only `ready` selector, then update DEVELOPMENT.md to "six surfaces".
  - *Verified (lead):* `semantics.json` orders surfaces Attention, Runs, Plan, Workflows, Agents, Config; `app-shell.spec.ts:140-143` still presses ⌘4/⌘5 for Agents/Config.
  - *Related:* D7-13
- **D5-02** · **High** (confirmed) · contradicts-design — Release publication does not re-run CI's check set; it runs tests before build, so production MCP acceptance cannot find its compiled inputs
  - *Doc:* docs/RELEASING.md:33-35. `release-publish.yml` "re-runs typecheck, lint, format, tests, build and the compiled-CLI smoke test". RELEASING.md:44-47: "That is why `release-publish.yml` re-runs **the full check set** against the merge commit …
  - *Code:* The release check job runs `pnpm install` (with ELECTRON_SKIP_BINARY_DOWNLOAD), then typecheck, lint, format:check, `pnpm test`, `pnpm run build`, then the CLI demo: release-publish.yml:75-86.
  - *Resolution:* fix code. Move `pnpm run build` before `pnpm test` and add design:check, retry acceptance and `ORCA_MCP_REQUIRE_PRODUCTION=1` (or call a shared verification workflow). Then align RELEASING.md with ci-shadow-selection.md.
  - *Verified (lead):* Same defect as C8-03, seen from RELEASING.md.
  - *Related:* C8-03
- **D5-03** · **High** (confirmed) · contradicts-design — A committed fragment with no section suffix makes `tools/release.js notes --unreleased` and `prepare` fail
  - *Doc:* changelog.d/README.md:9-17 says to name fragments `<issue>-<slug>.<section>.md` (`0` if there is no issue). RELEASING.md:19-26 and 287-291 say `node tools/release.js notes --unreleased` "renders what is pending" and `prepare` renders the …
  - *Code:* `changelog.d/daemon-handler-settlement.md` (added in 9b727ea) has no `<section>`.
  - *Resolution:* fix code/data. Rename it to e.g. `0-daemon-handler-settlement.fixed.md`. Optionally have changelog.yml validate fragment names.
  - *Verified (lead):* `changelog.d/daemon-handler-settlement.md` has no section suffix.
- **D5-04** · **Medium** · stale-doc — RELEASING says desktop packaging runs on `ubuntu-latest`; the Linux leg (and the release jobs) run on the self-hosted homelab runner
  - *Doc:* docs/RELEASING.md:70-71 says "`.github/workflows/desktop.yml` builds both, on `ubuntu-latest`, `macos-latest` and `windows-latest`". RELEASING.md:309-310 says "built by `desktop.yml` on three platform runners".
  - *Code:* desktop.yml:51 is `os: [self-hosted, linux, x64, homelab]`.
  - *Resolution:* update doc. List the actual runner matrix and the homelab prerequisite for the release pipeline.
  - *Related:* D11-02
- **D5-05** · **Medium** · stale-doc — RELEASING's daemon-selection order and "home directory" workspace are stale since first-run and saved endpoints
  - *Doc:* docs/RELEASING.md:104-123 gives the order (1) `ORCA_DAEMON_URL`, (2) the bundled daemon if packaged, (3) `http://127.0.0.1:6722`. RELEASING.md:128-135: "**The workspace it serves is `ORCA_WORKSPACE` …
  - *Code:* packages/app/src/main/index.ts:5-8: "Which daemon, in order: `ORCA_DAEMON_URL`, then the saved endpoint, then the daemon inside a packaged app over a verified first-run selection or explicit ORCA_WORKSPACE. Without an explicit target or …
  - *Resolution:* update doc. Describe the env, saved endpoint and first-run selection precedence and the disconnected setup state.
- **D5-06** · **Medium** · stale-doc — The DEVELOPMENT dev-app recipes no longer attach the app to `orca serve`
  - *Doc:* docs/DEVELOPMENT.md:30-31 says `pnpm run orca serve` ("the daemon, on 127.0.0.1:6722") and then `pnpm --filter @orca/app dev # the app against that daemon`. Line 44 says "The app reads `ORCA_DAEMON_URL` to attach to a daemon elsewhere". …
  - *Code:* Without `ORCA_DAEMON_URL`, a saved endpoint or `ORCA_WORKSPACE`, the app does not try the default URL; it opens disconnected with "Choose a project…" (workspace.ts:922-925, 970-973).
  - *Resolution:* update doc. Add `ORCA_WORKSPACE=<dir>` and/or `ORCA_DAEMON_URL` plus `ORCA_DAEMON_TOKEN_FILE=<dir>/auth/local-client.token` to both recipes.
- **D5-07** · **Medium** · undocumented — `pnpm test` needs a prior `pnpm run build`; DEVELOPMENT lists test before build and never says so
  - *Doc:* docs/DEVELOPMENT.md:16-28. The setup block runs `pnpm test` (line 25) and `pnpm run test:coverage` (26) before `pnpm run build` (27), with no build prerequisite stated for tests.
  - *Code:* the production MCP fixture throws without `packages/cli/dist/main.js`, `packages/integrations/dist/mcp/transport.js` and `packages/testing/dist/scripted-agent/main.js` (mcp-operator-production-fixture.ts:237-247). The other emitted-dist …
  - *Resolution:* update doc. Move `pnpm run build` above the test commands and state the dependency.
- **D5-08** · **Medium** · contradicts-design — The lint "escape hatch" works only for stylesheets; the TSX rule has no `orca-allow-literal` and two of its three messages don't say how to add a token
  - *Doc:* docs/DEVELOPMENT.md:353-358. "**The escape hatch is to add the token** … **Both lint messages say so**, so the fix is in the failure. For a value no token could sensibly name …
  - *Code:* Only the CSS scanner honours the marker: tools/eslint-config/css-tokens.js:42-43 and 145-156.
  - *Resolution:* decide. Either teach `design-tokens-only` the marker and the token hint, or document that TSX uses `eslint-disable-next-line orca/design-tokens-only -- reason` and fix the "both messages" claim.
- **D5-09** · **Medium** · status-mismatch — ROADMAP says "five surfaces, no workflow editor" and lists visual authoring as backlog; #610 shipped the Workflows surface, editor and drafts
  - *Doc:* docs/ROADMAP.md:23 has the "Five desktop surfaces and five Plan modes" row with remaining boundary "No agent cost, run percentage/ETA, **workflow editor**, …". ROADMAP.md:75 lists `ship-group:visual-authoring` (drafts/publish #180 …
  - *Code:* Six surfaces: tokens.ts:292.
  - *Resolution:* update doc. Add a six-surface/editor row, narrow visual-authoring to #183 and residual acceptance, and refresh the reconciliation pin.
  - *Related:* D1-02, D11-03
- **D5-10** · **Medium** · status-mismatch — ROADMAP still lists M21 structured forms, guided launch and plugin restoration as not implemented
  - *Doc:* docs/ROADMAP.md:46 (M21) says "Remaining work: #333 structured create/delete/reorder and semantic preview; #334 guided Request/direct launch and asset/workspace choices. #440 is reconciled preparation awaiting accepted packet/runtime …
  - *Code:* Structured forms are mounted in Config: packages/app/renderer/src/config/configuration-studio-surface.tsx:15,188. Insert, move and remove edits are in config/structured-form/collection-model.ts:57-77. #545, then #553 (dcd545d) …
  - *Resolution:* update doc. Move these to the implemented-with-limits table, keeping native/beta acceptance gaps as the remaining boundary.
  - *Related:* D10-02
- **D5-11** · **Medium** · stale-doc — The native-mac validator README (and the packaged-mac README and ROADMAP) say candidate mode is refused; it now runs native candidate verification
  - *Doc:* tools/deploy/tests/native-mac/README.md:3-6: "neither verifies production candidates … no … archive extraction or subprocesses are used by the validator".
  - *Code:* tools/deploy/native-mac-verify.py:2: "Single delivery-v1 validator: synthetic fixtures or explicitly trusted native candidates".
  - *Resolution:* update doc. Document candidate mode's inputs, macOS requirement, subprocess use and that it is unexercised natively.
- **D5-12** · **Low** · doc-conflict — ci-shadow-selection.md gives two selector versions (1.3.0 and 1.1.1)
  - *Doc:* docs/ci-shadow-selection.md:16 says "Selector **1.3.0**". Line 275-276 says "selector version **1.1.1**", in the artifact contract, which is not marked historical.
  - *Code:* tools/ci-shadow/selector.js:11 is `SELECTOR_VERSION = "1.3.0"`, and plan.schema.v1.json:47-48 has `"const": "1.3.0"`.
  - *Resolution:* update doc. Line 276 should say 1.3.0. Optionally add the newer tests to the Verification command at 452-456 (tools/test/ci-package-selection.test.js, ci-shadow-evidence.test.js).
- **D5-13** · **Low** · doc-conflict — The lint table says components.css is checked "for colours and stacking order"; it is checked in full
  - *Doc:* docs/DEVELOPMENT.md:332 has the table row "every `.css` under `packages/app/renderer`, and `components.css` for colours and stacking order". This contradicts DEVELOPMENT.md:360-361 ("`components.css` is checked in full").
  - *Code:* package.json `lint:css` passes `packages/design/css/components.css` without `--colours-only`. css-tokens.js:132-138 says "Nothing passes it today". The header comment in tools/eslint-config/bin/check-css-tokens.js:8-9 is equally stale.
  - *Resolution:* update doc (and the bin header comment).
- **D5-14** · **Low** · stale-doc — The `orca-allow-literal` count in components.css is 3, not 2
  - *Doc:* docs/DEVELOPMENT.md:367-369: "`grep -c orca-allow-literal components.css` returns 2: the note itself, and the paragraph at the top of the file".
  - *Code:* `grep -c` returns 3 (packages/design/css/components.css:13, 226 and 231). Line 226 is a second explanatory comment above the exemption.
  - *Resolution:* update doc.
- **D5-15** · **Low** · stale-doc — Small drifts in how DEVELOPMENT describes the local lint rules
  - *Doc:* docs/DEVELOPMENT.md:325: "One local rule, `orca/file-header-comment`".
  - *Code:* The plugin has two local rules: tools/eslint-config/rules/index.js:8.
  - *Resolution:* update doc.
- **D5-16** · **Low** · stale-doc — "Only ci.yml runs automatically before a pull request merges" leaves out ci-shadow.yml; the self-hosted smoke workflow is undocumented
  - *Doc:* docs/DEVELOPMENT.md:440-442. changelog.d/README.md:71 says "only CI runs automatically before merge".
  - *Code:* .github/workflows/ci-shadow.yml:4-7 runs on `workflow_run: [CI] completed`, including for PR runs (advisory, not a gate). .github/workflows/selfhosted_runner_smoketest.yml (homelab, dispatch-only) is not mentioned in any doc in scope.
  - *Resolution:* update doc. Say "the only pre-merge *gate*" and mention the advisory consumer.
- **D5-17** · **Low** · undocumented — A third dev-only route `#resources` and a standalone Chromium Playwright config are undocumented
  - *Doc:* docs/DEVELOPMENT.md:241 says "`#type` is the second dev-only route". Line 261 says "Both routes are dev-only". Line 775-776 says "No browser binaries are involved … `playwright install` is never needed".
  - *Code:* packages/app/renderer/src/routes.tsx:16-18 and 29 add a third dev-only route, `#resources` (`preview/resources.tsx`). packages/app/renderer/test/resources-browser.config.ts:1-23 is a Playwright config that launches standalone Chromium …
  - *Resolution:* update doc. Mention the route and how to run the browser spec.
- **D5-18** · **Low** · stale-doc — The renderer test-kit description understates the fake bridge
  - *Doc:* docs/DEVELOPMENT.md:526-527: "`fake-bridge.ts` is a `window.orca` answering `hello`, **the five read methods** and notifications from `fixtures.ts`".
  - *Code:* packages/app/renderer/test/fake-bridge.ts:168-199 answers about 20 read methods (runs, inputs, claims, artifacts, workflows, agents, config, plans and items, schedule, dependencies, risks, decisions …
  - *Resolution:* update doc.
- **D5-19** · **Low** · stale-doc — "Python deploy tooling is not part of the JavaScript suite"; several Python suites run inside Vitest
  - *Doc:* docs/DEVELOPMENT.md:506-507: "Deployment tooling also includes Python (`tools/deploy/orca-release.py`); it is not part of that JavaScript suite."
  - *Code:* tools/test/deployment.test.js:4-5 runs `python3 -B tools/deploy/test_release.py`. tools/test/agent01-owner-staging.test.js:21-30 runs test_agent01_staging.py. tools/test/native-mac-validator-integration.test.js:63-68 runs …
  - *Resolution:* update doc. Say that the Debian adapter's stdlib tests run via `tools/test/deployment.test.js` and need `python3`.
- **D5-20** · **Low** · undocumented — Test-run settings that affect local runs are missing from DEVELOPMENT
  - *Doc:* docs/DEVELOPMENT.md:405-432 (Coverage). Lines 418-421 list the excluded files as `packages/testing`, the `index.ts` barrels and `main.ts`.
  - *Code:* vitest.config.ts:76-85 also excludes `packages/app/src/main/**`, `packages/app/src/preload/**` and `packages/design/src/**`.
  - *Resolution:* update doc.
- **D5-21** · **Low** · broken-reference — DEVELOPMENT's list of state-changing commands names "cancel" and "config apply"; the CLI has neither
  - *Doc:* docs/DEVELOPMENT.md:104-105: "`answer`, resume/cancel, claims release, leases break, config apply and credential commands mutate operator state."
  - *Code:* the CLI command table in packages/cli/src/commands/index.ts:275-752 has mcp, auth, validate, graph, agents, ping, run, admissions, revisions, submit, plan, claims, leases, runs, status, events, resume, answer, acp, serve …
  - *Resolution:* update doc. Name these as app/RPC actions.
- **D5-22** · **Low** · contradicts-design — The demo-workspace recipe omits the required workItem fields; the CLI's printed example would fail
  - *Doc:* docs/DEVELOPMENT.md:210-214: the demo leaves a config "so `orca --config <path>/orca.config.yaml run <workflow>` exercises any workflow without an LLM."
  - *Code:* `ai-sdlc` requires `workItem` (workflows/ai-sdlc.yaml:12-13). With no stored binding, `vars.workItem` must have a safe slug, a title **and a description** (packages/engine/src/run-context.ts:323-347).
  - *Resolution:* fix code (add `"description"` to the hint) and mention the workItem shape in the doc.
- **D5-23** · **Low** · stale-doc — The mcp-credential-admin README's present-tense scope and rollback are superseded by #627
  - *Doc:* docs/performance/mcp-credential-admin/README.md:4-6: "Every issue/revoke still launches its own Node process and calls the same `openAuthDirectory`". Line 183-184: "Roll back by reverting the one fixture import URL".
  - *Code:* since 362a2cb (#627, 2026-10-12), credential administration and HTTP bridges for every fixture in a test file are "served by one compiled process instead of one fresh `node -e` for each credential change" …
  - *Resolution:* update doc. Add a dated forward note pointing to #627.
- **D5-24** · **Low** · undocumented — The packaged-mac README says the slice "does not … extract" and omits three files in its directory
  - *Doc:* tools/packaged-mac/README.md:3-5: "It does not launch, mount, extract, sign … It changes no workflow, manifest…". The README documents only the executor preflight, launch environment, packaging plan and acceptance packet.
  - *Code:* tools/packaged-mac/native-containment.py:1-5 does "Bounded native extraction into private scratch".
  - *Resolution:* update doc.
- **D5-25** · **Low** · undocumented — RELEASING leaves out native acceptance as a publication gate, and its label list omits `no-changelog`
  - *Doc:* docs/RELEASING.md:319-321 says publication depends on "its Linux Electron smoke check and the Linux/macOS/Windows type-proof matrix". RELEASING.md:305 lists labels `release` and `release:*`.
  - *Code:* the app-smoke `type-proof` job also runs the native admission-intent and revision-workflow acceptance on macOS and Windows (app-smoke.yml:267-308), and any failure there fails `app-verification` …
  - *Resolution:* update doc.
- **D5-26** · **Low** · undocumented — ROADMAP and UPDATING say "no Mac update driver/engine" without mentioning the merged, disabled Mac update application
  - *Doc:* docs/ROADMAP.md:33 says "Main has no Mac update driver." ROADMAP.md:62 says #439 "does not supply a Mac engine". UPDATING.md:13 and 89-90 cover only activation.
  - *Code:* packages/app/src/main/index.ts:836-873 wires `createManagedMacUpdateApplication(...)` and `installMacUpdateIPC`, with `activationAllowed: () => false` and no authority. This is the Mac updater groundwork from 3ffb16e (#550) and the …
  - *Resolution:* update doc. Say "merged, production-disabled Mac update composition; no activation".
  - *Related:* D11-04
- **D5-27** · **Low** · stale-doc — The JEV restoration doc still describes #394 as future
  - *Doc:* examples/jev/RESTORATION.md:3-7: "Cross-process restoration of that default plugin remains conservatively refused **until #394 supplies** the versioned runtime attachment and protected-record integration."
  - *Code:* #394's opt-in restoration is merged (packages/engine/src/plugin.ts:119-170; changelog.d/394-plugin-restoration.*). The JEV seam is still marked provisional (packages/integrations/src/jev/plugin.ts:28-41). The default export remains …
  - *Resolution:* update doc. Name the remaining JEV bridge integration rather than #394.
  - *Related:* D2-03
- **D5-28** · **Low** · status-mismatch — The admission-retry-worker README says "The draft is not merged"
  - *Doc:* docs/performance/admission-retry-worker/README.md:219.
  - *Code:* the helper is merged and in use: packages/engine/test/admission-retry-multiprocess/compiled-worker.ts and harness.ts:3 (`import { compileRetryWorker }`), with the regression in packages/engine/test/admission-retry-compiled-worker.test.ts.
  - *Resolution:* update doc. Add a dated merged note.
- **D5-29** · **Low** · stale-doc — The baseline procedure contrasts with `ubuntu-latest`; the Linux type-proof leg runs on the homelab runner
  - *Doc:* docs/DEVELOPMENT.md:725-727: "a Linux baseline shot on a laptop and a Linux baseline shot on `ubuntu-latest` are different pictures". The artifact is described as `type-proof-<os>`.
  - *Code:* app-smoke.yml:183-184 has `os: ubuntu-latest` (a label only) with `runner: [self-hosted, linux, x64, homelab]`. The Linux baselines therefore come from the homelab image, and the artifact is named `type-proof-ubuntu-latest`.
  - *Resolution:* update doc.
- **D5-30** · **Low** · contradicts-design — Several pending fragments break the README's naming and shape rules (they still render)
  - *Doc:* changelog.d/README.md:16-30. `<issue>` is the issue number (`0` if none). `added`, `changed` and `fixed` hold "bullets", "keeping the area prefix".
  - *Code:* No issue number: `mac-fixed-path-timestamps.fixed.md`, `operator-integration.store.md`, `operator-windows-sync.fixed.md` (plus D5-03's file).
  - *Resolution:* fix data (rename and reshape before the next prepare).

### D6 — Design rules, information architecture, attention, long-running content, connection states

Full write-up: [D6.md](2026-10-13-review-detail/D6.md).

- **D6-02** · **High** (confirmed) · contradicts-design — Focus falls to the page body in several places (rule 10)
  - *Doc:* `RULES.md:38-43` — "When the control holding focus leaves … focus moves to its neighbour (`focusAfterLeaving`) or to the region it belonged to, never to the page body …
  - *Code:* Surface switch (⌘1–⌘6, nav, any deep link, alert activation): `App.tsx:162-165` / `:177-186` only `setActive`; `PrimaryPane` is re-keyed per surface (`App.tsx:258-260`) so the subtree holding focus unmounts …
  - *Resolution:* fix code — focus the new primary pane / its first landmark on surface change, hand focus back to the trigger on panel and dialog close, and send focus to the surface region when the last card leaves.
  - *Verified (verifier V6):* Focus falls to the body after ⌘1–⌘6, palette jumps, crumbs or `G`, on panel close, on mismatch-dialog close, and when the last card is answered; J/K then do nothing until the person tabs back in. The "new ask arriving" case moves focus to a different card rather than the body (see C6-03).
  - *Related:* C6-03, D7-05
- **D6-03** · **High** (confirmed) · contradicts-design — Danger tone at rest, without `✕`, on gate/permission cards and on Diagnostics "Delete all and turn off"
  - *Doc:* `RULES.md:71-76` (rule 17: "A resting screen carries no danger tone"; a no-way-back act arms its own row, Keep first, ✕ Confirm); `README.md:128-131` ("the tone and the `✕` together … A control at rest … is the default tone") …
  - *Code:* `attention/answer-card.tsx:237` paints every destructive option `tone="danger"` at rest with no `✕` (pressing it only *selects*; `Answer` commits). `:273-281` **Always deny** is `tone="danger"` at rest, no `✕`, commits on one click.
  - *Resolution:* fix code — destructive options default tone (destructiveness carried by order/position and a `✕` when armed), Diagnostics delete arms in place per rule 17; update `button.tsx` header.
  - *Verified (verifier V6):* The rule sentence was added on 2026-10-11, after the prior review rated the gate card as matching. Diagnostics "Delete all and turn off" is one click with no confirmation in main either.
- **D6-01** · **Medium** (confirmed, was High) · contradicts-design — Every reconnect, including a 400 ms blip the 5 s quiet window hides, flashes the surfaces to "Loading…" and throws away scroll, held position, buffered output and focus
  - *Doc:* `AGENTS.md:200-202` — "Leaving `live` is held silent for five seconds, so a blip changes nothing on screen"; `docs/design/40-connection-states.md:28-33` — silent for 5 s; streaming panes "keep the output they have … and resume in place" …
  - *Code:* `packages/app/src/main/connection-state.ts:181-185` bumps `generation` on every transition into `live` (blips included) and `publish()` (`:372-379`) pushes it because the JSON differs. Every data hook keys a full reset on it …
  - *Resolution:* fix code — reconcile on a new generation without dropping to `phase: "loading"` (keep the last snapshot on screen, swap when the read lands) and keep the step buffer across generations.
  - *Verified (verifier V2):* Verified as C6-04: re-reading after reattachment is sanctioned; the reset to loading is the defect. Rare with the bundled local daemon.
  - *Related:* C6-04
- **D6-04** · **Medium** (confirmed, was High) · contradicts-design — Rule-17 confirmations still break order/`✕` (previously recorded, still open)
  - *Doc:* `RULES.md:71-76`; conformance review follow-up 22 ("Destructive confirmations that break rule 17").
  - *Code:* `workflow/editor/workflow-editor.tsx:331-338` armed "Discard every change" has no `✕` and no Keep; `plan/relationship-inspector.tsx:131-145` "Waive, unblocking …" (danger) is listed before "Keep it", no `✕` …
  - *Resolution:* fix code — Keep first and focused, `✕ Confirm` in danger tone, consequence on the two-line variant (lift `ClaimRow`'s state machine as follow-up 21 suggests).
  - *Verified (verifier V3):* Verified as D7-01 and D7-02.
  - *Related:* D7-01, D7-02
- **D6-05** · **Medium** (confirmed, was High) · contradicts-design — The Workflows list is a hand-mapped `<table>` whose rows wrap
  - *Doc:* `RULES.md:34-37` (rule 9: rows fixed height, never wrap; two lines is a declared variant); `AGENTS.md:210-234` ("A list of rows is `VirtualList`, not a `map`" …
  - *Code:* `workflow/workflows-surface.tsx:139-203` renders `state.workflows.map(...)` into `<tr>`s; each row stacks name+id over a `display: block` description capped only at `--measure-prose` (`:163-168`, `workflow/workflow.css:224-228` …
  - *Resolution:* fix code (VirtualList `grid` with a declared two-line variant, description cut at its end with `title`) or record the exception in AGENTS.md.
  - *Verified (verifier V6):* Rule 9 is broken, but the list is small and every action is reachable by Tab.
- **D6-07** · **Medium** (confirmed, was High) · contradicts-design — Native `<select>` popovers (previously recorded, still open)
  - *Doc:* `RULES.md:66` ("Every popover is a `Menu`"); `AGENTS.md:140-149`; conformance review "Beyond the design" bullet.
  - *Code:* `config/structured-form/structured-form.tsx:322`, `template-authoring/editor.tsx:129`, `template-authoring/surface.tsx:248,260,314` (plus dev-only `preview/resources.tsx:71,89,107,121`). `config/config-form.tsx:7-8` itself explains why a …
  - *Resolution:* fix code — use `Menu` as `config-form.tsx` and `preferences-section.tsx` do.
  - *Verified (verifier V6):* The native selects are operable; the harm is consistency.
  - *Related:* D7-30
- **D6-08** · **Medium** (confirmed, was High) · contradicts-design — Raw ids printed in Plan journal rows (previously recorded for risk; wider than recorded)
  - *Doc:* `RULES.md:29-33` (an id in a row "is never printed or sliced raw"); `renderer/test/object-id-guard.test.ts:126-138` `NEVER_DISPLAYED` says risks/decisions/dependencies are shown by key or target, never by id.
  - *Code:* `plan/journal.tsx:128` renders the daemon's `entry.summary`, produced by `packages/core/src/plan/journal-summary.ts:14` (`${dependencyId} …`), `:18` (`${riskId} {json}`), `:22` (`${decisionId} = …`). Review recorded only `risk.updated` …
  - *Resolution:* fix code — summarise by key/slug (core already has `slug()` for work items) or have the renderer format the payload.
  - *Verified (verifier V6):* Wider than written: the journal's fallback branch dumps whole payloads as JSON, raw ids included, for six more event types. The summary is shared with the CLI, so fix it in the renderer.
- **D6-09** · **Medium** (confirmed (narrowed), was High) · contradicts-design — Each surface adds its own `role="status"` "Not connected" banner: extra polite live regions, wrong words in file mode, a text banner where the spec has a 2 px rule
  - *Doc:* `AGENTS.md:268-277` ("the **one** polite live region … A surface that wants to announce something adds to that fold; it does not add a region"); `docs/design/40-connection-states.md:11-13,28-31` (reconnecting = thin bar …
  - *Code:* `attention/attention-surface.tsx:148-152`, `runs/runs-surface.tsx:233-237`, `plan/plan-surface.tsx:540-544`, `config/config-surface.tsx:216-220`, `agents/agents-surface.tsx:122-126` …
  - *Resolution:* fix code — drop the per-surface banners (the chrome owns the bar), say nothing stale in `file`, and make the sweep count `role="status"|"log"|"alert"` too.
  - *Verified (lead):* One of the six cited banners (`config/config-surface.tsx`) is in the legacy Config surface the shipped app never renders; the other five are live. Same harm as D7-03.
  - *Related:* D7-03
- **D6-11** · **Medium** (confirmed, was High) · contradicts-design — Attention failed-row error text is neither cut nor titled
  - *Doc:* `RULES.md:55-59` (rule 15.1: a label longer than its box is cut at its end, whole in `title`); `RULES.md:34` (rows never wrap).
  - *Code:* `attention/attention-surface.tsx:390-400` puts `{run.error.message}` in a bare `Text style="caption"` inside `.orca-attn__row` (`components.css:1077-1089`: `white-space: nowrap` …
  - *Resolution:* fix code — give the message an `.orca-truncate`-style cell with the whole text in `title`.
  - *Verified (verifier V6):* Reasoned from CSS: a long message overflows the row and pushes the time out of view; the truncated run name has no `title` either.
- **D6-12** · **Medium** (confirmed) · missing-in-code — Deep links that land on the surface but not on the object (gate, artifact, agent)
  - *Doc:* `docs/design/10-information-architecture.md:155,158,162` (`orca://gate/…` "that gate focused, answer buttons armed"; `orca://artifact/…?run=` "the docked panel, that artifact, version 3"; `orca://agent/…` "that agent's card") …
  - *Code:* `route-table.ts:114-115,131-141,152-153` resolve all three, but `App.tsx:310-314` passes no route to `AttentionSurface`, `App.tsx:316-331` passes only `{ runId }` for an artifact route and never calls the panel's `open` …
  - *Resolution:* fix code — thread `gate`/`artifact`/`agent` routes to the surface/panel (focus the card, `panel.open({runId,name,version})`, select the agent).
  - *Verified (verifier V6):* Artifact links also drop the version. The prior review had marked deep links as matching.
  - *Related:* C6-15
- **D6-13** · **Medium** · missing-in-code — Failed runs on Attention cannot be opened
  - *Doc:* `docs/design/20-attention-and-gates.md:19` ("The rows are the failures' rows, `Enter` opens the selected run"); `docs/design/10-information-architecture.md:91-97` ("the top item in the sidebar is never a dead end") …
  - *Code:* the Failed `VirtualList` (`attention-surface.tsx:252-263`) only selects (`onSelect={setFailureIndex}`); `Enter` is registered only inside `Running` (`:311-319`); `FailedRow` (`:390-400`) has no link and no `G`.
  - *Resolution:* fix code — register `Enter` (and pointer open) on the failures list through `onOpenRun`.
- **D6-14** · **Medium** · contradicts-design — Crumbs and counterparts that do nothing
  - *Doc:* `docs/design/10-information-architecture.md:113-121` ("Every crumb is a link … one component, no dead ends"); `route-table.ts:225-227` claims a crumb with no URL is left "plain text rather than a link that goes nowhere".
  - *Code:* `ui/object-header.tsx:274-292` renders every non-current crumb as a `<button>`; `App.tsx:272-275` ignores it when `urlForCrumb` is undefined …
  - *Resolution:* fix code — draw URL-less crumbs as text (or give `plan` a URL), and either implement or drop "Runs that attempted this"; or document the dead end in 10.
- **D6-15** · **Medium** · contradicts-design — Permission card drops the run (when an agent is known) and always drops the work item
  - *Doc:* `docs/design/20-attention-and-gates.md:55-63` (every gate card carries "the run and work item it belongs to"; a permission card carries "one thing more: who is asking … rather than only the run").
  - *Code:* `attention/permission-card.tsx:58-67` subtitle is `agent?.id ?? input.runName` + host + step — the run name only when there is no agent, the work item never; `gate-card.tsx:63-69` shows run + work item.
  - *Resolution:* fix code — show agent/host *and* run and work item.
- **D6-16** · **Medium** · doc-conflict — Inline cards: no keys, but the key hint is still drawn; and they never announce
  - *Doc:* `docs/design/20-attention-and-gates.md:39-41` ("identical controls and identical keyboard handling"); `RULES.md:44-45` ("Gates and permission asks announce assertively"). Previously recorded as a documented exception ("The inline card …
  - *Code:* `attention/inline-asks.tsx:78-81` passes no `focused` (so `use-card-keys.ts:44,72` register nothing), contradicting `use-card-keys.ts:6-10` ("brings its own keys with it") …
  - *Resolution:* decide — either give the focused inline card its keys or write the exception into 20 and hide the hint inline; fix the inline-replay comment.
- **D6-17** · **Medium** · doc-conflict — Destructive-option digit rule stated three ways
  - *Doc:* `docs/design/20-attention-and-gates.md:47` ("never bound to `1`"); `packages/design/src/component-api.d.ts:417-418` (`destructive`: "Never bound to a number key") …
  - *Code:* `attention/card-model.ts:36-43` binds destructive options to digits after the safe ones (e.g. `2`), and to `1` when all options are destructive (asserted in `renderer/test/attention-model.test.ts:37-45`). The exception is written only in …
  - *Resolution:* update doc — state the all-destructive case in 20 and correct `component-api.d.ts:418`.
- **D6-18** · **Medium** (partly re-checked) · contradicts-design — Config's own object header puts the connection bars and link notices above it
  - *Doc:* `docs/design/10-information-architecture.md:32-35`, `docs/design/40-connection-states.md:94-96` (bars and the landing notice sit "under its object header").
  - *Code:* `App.tsx:369-381` gives Config no chrome header (crumbs only come from Runs/Plan/Workflows, `App.tsx:100-114`), so `PrimaryPane` draws the notices first (`chrome/primary-pane.tsx:39-41`) …
  - *Resolution:* fix code — hand Config's header up to the chrome like Plan/Workflows.
  - *Verified (lead):* One cited line is in the legacy Config surface (unreachable in the shipped app); the same layout holds for the shipped `configuration-studio-surface.tsx:99`.
- **D6-19** · **Medium** · contradicts-design — Waiting colour on things that are not waiting (partly previously recorded)
  - *Doc:* `RULES.md:23-25`, `README.md:136-143` (statuses map one-to-one onto tokens; waiting is the one that costs the person something); `semantics.json` `runStatus`.
  - *Code:* `.orca-attn__row` hard-codes `border-left: … var(--status-waiting)` (`packages/design/css/components.css:1086`) and Attention passes only `orca-attn__row` for both the **Failed** and the **Running** lists (`attention-surface.tsx:257,332`) …
  - *Resolution:* fix code — use `.orca-attn__row--failed` / a running modifier, a neutral eyebrow for default cards, default tone for the correction summary.
- **D6-20** · **Medium** · undocumented — Workflow-node overlay colours contradict the chip they carry
  - *Doc:* `README.md:136-147` (statuses one-to-one onto tokens; cancelled/stale share the neutral ramp); `semantics.json` cancelled note "a cancel is not a fault"; `RULES.md:18-20` (colour is the third channel of the same status).
  - *Code:* `ui/workflow-node.tsx:104-120` maps `cancelled` → `orca-node--failed` (red tint, `components.css:1481-1485`) and `blocked`/`held` → `orca-node--waiting` (amber) …
  - *Resolution:* decide — add neutral/blocked/held modifiers or document the four-state reduction.
- **D6-21** · **Medium** · contradicts-design — File mode and read-only daemons: answer controls are disabled, not absent; Config studio composes its own reason
  - *Doc:* `docs/design/40-connection-states.md:13,48-51` (file mode: "the buttons are absent rather than disabled"); `:16-19` (a control asks for the method it calls); `AGENTS.md:204-208` ("a control must not compose its own" reason).
  - *Code:* `useWritesPresent` (`chrome/use-connection.ts:56-59`) has no caller; Attention and inline cards always render option/Answer/Always buttons and only disable them with `writability()`'s reason (`attention-surface.tsx:120` …
  - *Resolution:* fix code — gate card controls on `useMethodPresent("inputs.answer")`, and route the studio through `writability()`.
- **D6-22** · **Medium** (partly re-checked) · contradicts-design — Last-known values: dimming is all-or-nothing by surface, and running things keep animating (partly previously recorded)
  - *Doc:* `docs/design/40-connection-states.md:11-12,37-41` (values at `opacity-stale`, labels at full strength; "Running steps do not keep animating: the pulse stops and the glyph becomes `◷`").
  - *Code:* only `plan/plan-surface.tsx:549` and `config/config-surface.tsx:225` dim — and they dim whole bodies, labels included (previously recorded, still open); Attention, Agents, timeline and step detail dim nothing …
  - *Resolution:* fix code — a stale variant on value cells/StatusChip/meter/caret driven by `clocksRun()`.
  - *Verified (lead):* The `config/config-surface.tsx:225` example is in the legacy surface; the other examples are in shipped code.
- **D6-23** · **Medium** · contradicts-design — A long finished step does not open "at the top"
  - *Doc:* `docs/design/30-long-running-content.md:44-45` ("A finished run opens in held mode at the top of the failing step"); `docs/design/10-information-architecture.md:154` (`orca://run/…/step/build.2` "output scrolled to its start").
  - *Code:* `step/use-step-log.ts:140-163` reads the step's **tail** page when `hasMore` and `openHeld` then puts the reader at row 0 of that tail (`:131-136`), i.e. the first of the last 500 events, under a "Load earlier output" marker …
  - *Resolution:* decide — read the first page for finished steps (or say "end of output" in 30), select the failing step on open, hide the jump button when nothing is streaming.
- **D6-24** · **Medium** · contradicts-design — The Agents policy panel is a second pane with its own width and border and no splitter
  - *Doc:* `AGENTS.md:156-166` ("Every pane boundary is a `PaneSplitter` … does not state a width … a pane beside one draws no border of its own"); `docs/design/10-information-architecture.md:42-50` ("Every boundary in the window is draggable").
  - *Code:* `config/policy.css:16-25` `.orca-policy { flex: 0 0 var(--panel-w-policy); border-left: …; background: var(--surface-raised) }` beside `.orca-agents__split` (`agents/agents.css:185-193`, `agents-surface.tsx:134`) …
  - *Resolution:* fix code — use the shared `panel` boundary like the workflow inspector.
- **D6-25** · **Medium** · contradicts-design — Menus open inside clipping containers (previously recorded for the schedule "why"; also timeline rows)
  - *Doc:* `AGENTS.md:142` ("Placement flips rather than clips"); conformance follow-up 22 ("why" menu clipped).
  - *Code:* `.orca-menu` is `position: absolute` inside a `position: relative` anchor with `min-width: var(--panel-width)` (`components.css:2372-2390`) …
  - *Resolution:* fix code — portal/fixed-position menus or place triggers outside the clipping box.
- **D6-26** · **Medium** · undocumented — Row lists rendered with `.map`, outside the documented exceptions
  - *Doc:* `AGENTS.md:210` and `:245-257` (only Attention cards and Config permission rows are exceptions); `docs/design/30-long-running-content.md:8-13`.
  - *Code:* Agents claims list `agents/agents-surface.tsx:400-415` (`<ul>{claims.map(<ClaimRow/>)}</ul>`, rows with Release controls); step tool calls `step/step-detail.tsx:139-148`; Workflows list (D6-05). None says why.
  - *Resolution:* decide — virtualise or list these as bounded exceptions in AGENTS.md.
- **D6-27** · **Medium** · stale-doc — `semantics.json` still says reconnecting writes are "queued"
  - *Doc:* `docs/design/40-connection-states.md:11,90-93` (no outbox; disabled with the reason); README layout calls `semantics.json` an EDIT source of truth.
  - *Code:* `packages/design/semantics.json:73` `"reconnecting": { …, "writes": "queued" }`, exported as `CONNECTION_PRESENTATION.reconnecting.writes` (`packages/design/src/tokens.ts:255`); `renderer/src/connection.ts:135-139` disables instead.
  - *Resolution:* update `semantics.json` (`"disabled"`) and regenerate.
- **D6-28** · **Medium** · doc-conflict — Notification preferences: 10 says they are in Config; code says they are not, and there is no UI anywhere
  - *Doc:* `docs/design/10-information-architecture.md:232-234` ("Application preferences (theme, density, notifications) are a section of the Config surface"); `docs/design/20-attention-and-gates.md:68` (opt-in per tier).
  - *Code:* `config/preferences-section.tsx:17-19` ("deliberately not here yet: their surface is the Attention side"), but Attention has none either; tiers only in `src/preferences/schema.ts:34-44`. No-UI previously recorded as a deferral …
  - *Resolution:* decide — build the toggles or say in 10/20 they are file-only for now.
- **D6-29** · **Medium** · doc-conflict — `G` in a stream: 30 says it re-enters following; 50 and code say it goes to the top
  - *Doc:* `docs/design/30-long-running-content.md:43-44` ("the button, `End`, `G`"); `docs/design/50-accessibility-and-keyboard.md:76` (`G`/`⇧G` top/bottom, `⇧G` follows).
  - *Code:* `step/output-pane.tsx:175-195` `G` = top + hold, `Shift+G` = latest + follow.
  - *Resolution:* update doc 30 to `⇧G`.
- **D6-30** · **Medium** · doc-conflict — Config **Discard** destroys a draft with no confirm and no undo, while the workflow editor arms it
  - *Doc:* `RULES.md:71-76` (a no-way-back act arms its row; draft edits do not ask "because Save, Discard and Undo are the way back"); `README.md:128-129` names "an armed **Discard every change**".
  - *Code:* `config/draft-bar.tsx:131-133` ghost **Discard** calls `onDiscard` immediately; `config/use-config.ts:181` has no undo. `workflow/editor/workflow-editor.tsx:331-338` arms "Discard every change".
  - *Resolution:* decide — state whether Discard itself is a no-way-back act and make both save bars behave the same.
  - *Related:* D7-08
- **D6-06** · **Low** (confirmed, was High) · contradicts-design — A sentence passed as a `Menu` `hint`
  - *Doc:* `RULES.md:66-70` (rule 16: "A `hint` is a one-word meta … a sentence is the menu's `note`"); `ui/menu.tsx:76-81`.
  - *Code:* `plan/use-decision-writes.ts:79` and `plan/use-plan-writes.ts:144` set `hint: "the matrix's recommendation"`; it reaches `Menu` via `palette/command-palette.tsx:416-421`, where `hint` is drawn in the uppercase, unwrapped eyebrow style.
  - *Resolution:* fix code — one word ("recommended") or move the phrase to the menu `note`.
  - *Verified (verifier V6):* Cosmetic; only in the palette's Decide picker.
- **D6-10** · **Low** (confirmed, was High) · contradicts-design — Counts that are not `counted`/`unit` (rule 15.2)
  - *Doc:* `RULES.md:60-62` ("Write a count with `counted` or `unit` … the noun agrees … a no-break space holds the two together").
  - *Code:* `agents/agent-card.tsx:113` `` `${agent.roundTripMs} ms` `` (plain space, on screen); `workflow/editor/editor-canvas.tsx:536` `` `${inner.length} inside` `` (previously recorded, still open) …
  - *Resolution:* fix code — `unit(n, "ms")`, `counted(n, "dependency")`, etc.
  - *Verified (verifier V6):* Breaks the letter of rule 15.2 with little visible effect.
  - *Related:* D7-22
- **D6-31** · **Low** · stale-doc — Window diagram and status bar (partly previously recorded)
  - *Doc:* `docs/design/10-information-architecture.md:7` (title bar `● connected`), `:21` (status bar `orca-daemon 0.9.4 · 3 runs active`) …
  - *Code:* the indicator moved to the status bar (`chrome/title-bar.tsx:6-9`, `chrome/status-bar.tsx:33-38`) — diagram stale. "runs active" still missing and `status-bar.tsx:17-18` still says "no protocol method serves it" though …
  - *Resolution:* update the diagram; add the count; carry a `lastLive` in the snapshot or fix the comments.
- **D6-32** · **Low** · doc-conflict — Design docs contradict each other on colour use
  - *Doc:* `RULES.md:23` ("`status-succeeded` appears at chip scale only") vs `40-connection-states.md:10` (`● connected` in `status-succeeded`, implemented over the whole indicator, `components.css:2479-2481`). `README.md:124-127` (only menus …
  - *Resolution:* decide — carve the exceptions into RULES/README or change the specs; delete the unused YAML colour classes.
- **D6-33** · **Low** · stale-doc — Stale code comments that contradict the docs they cite
  - *Doc:* `10-information-architecture.md:56-61,172-184`, `20-attention-and-gates.md:15-20`.
  - *Code:* `App.tsx:54-57` (Attention "showing running runs … is still not built" — it is, `attention-surface.tsx:175-176`); `App.tsx:169-170` and `:278-280` (surfaces "do not exist until v0.5.0 and v0.6.0" / "v0.5.0's") …
  - *Resolution:* update the comments.
- **D6-34** · **Low** · doc-conflict — Palette navigation lists fewer kinds than 10 promises
  - *Doc:* `docs/design/10-information-architecture.md:204-206` (navigation: "recent runs, work items, agents, config files, workflows") vs the same doc `:220-221` ("the ten most recent runs and the configured agents").
  - *Code:* `palette/object-sources.tsx:80-128` registers runs and agents only; no navigation source anywhere for work items, config documents or workflows.
  - *Resolution:* update doc (or add the three sources).
- **D6-35** · **Low** · contradicts-design — `object-id-guard` covers four field families; correction card prints opaque ids raw
  - *Doc:* `AGENTS.md:103-107` ("`object-id-guard.test.ts` fails on a raw id in JSX"); `RULES.md:29-33`.
  - *Code:* the guard matches only `*RunId|*WorkItemId|*RequestId|*EventId` (`renderer/test/object-id-guard.test.ts:65`). `attention/revision-card.tsx:115-116` prints `destinationId` and `attemptId` raw in mono …
  - *Resolution:* fix code/test — `ObjectId variant="full"` (or a kind) for these, and widen the guard or narrow AGENTS' wording.
- **D6-36** · **Low** · stale-doc — Smaller long-running-content drifts
  - *Doc:* `docs/design/30-long-running-content.md:8` ("virtualised above 200 rows"), `:29` (sticky "current tool call"), `:61` (long-line "affordance"), `:110` (accruing durations tick at 1 Hz).
  - *Code:* `list/list-window.ts` has no threshold — every `VirtualList` always windows; `step/output-pane.tsx:261-277` passes no `header` (previously recorded, still open); the fold is a non-interactive span (`output-pane.tsx:333` …
  - *Resolution:* update 30 ("always windowed"); tick the wait label off `ui/ticker.ts`.
- **D6-37** · **Low** · stale-doc — Auto-approved timeline rows name `gate:auto`, not the policy (previously recorded, still open)
  - *Doc:* `docs/design/20-attention-and-gates.md:76-78` ("with the policy that approved it").
  - *Code:* `runs/timeline/timeline-entries.ts:31-38,281-282` — deliberately prints the source because the event does not carry the policy.
  - *Resolution:* update doc 20 (the event carries no policy).
- **D6-38** · **Low** · undocumented — Collapsed rail hides the waiting count (previously recorded, still open)
  - *Doc:* `docs/design/20-attention-and-gates.md:28-31` (the sidebar Attention row carries the same number).
  - *Code:* `components.css:2134-2137` `display: none` on `.orca-nav__count` under `data-sidebar="collapsed"`.
  - *Resolution:* decide — show a badge on the glyph or document it.
- **D6-39** · **Low** · missing-in-code — Runs and Agents say nothing for an id they do not have (previously recorded, still open)
  - *Doc:* `docs/design/10-information-architecture.md:36-38` (a notice when "an object the surface does not have").
  - *Code:* only Plan reports one (`App.tsx:194-196`); `RunsSurface`/`AgentsSurface` have no `onMissing`.
  - *Resolution:* fix code.
- **D6-40** · **Low** · contradicts-design — Status drawn outside `StatusChip`, list re-declared, unaligned chip columns
  - *Doc:* `RULES.md:13-17` (use `STATUS_PRESENTATION`, never re-declare; a status is drawn by `StatusChip`; a column is `aligned`).
  - *Code:* the timeline draws glyph + " — word" itself (`runs/timeline/timeline.tsx:279-295`); `plan/plan-model.ts:46-54` re-declares `ITEM_STATUSES` though `@orca/design` exports `WORK_ITEM_STATUSES` (`packages/design/src/tokens.ts:226`) …
  - *Resolution:* fix code or note the timeline marker as a sanctioned second rendering.
- **D6-41** · **Low** · stale-doc — AGENTS.md's connection snapshot and the startup state
  - *Doc:* `AGENTS.md:194-197` (`{ state, since, eventCursor?, versions?, orcaVersion?, capabilities? }`, "one of the design's five"); `40-connection-states.md:3`.
  - *Code:* `src/bridge.ts:125-153` also carries `generation` and `methods`, both read by the renderer (`use-connection.ts:75-84`, `connection.ts:124-131`). The machine starts in `reconnecting` (`connection-state.ts:147,158`) and publishes it …
  - *Resolution:* update AGENTS/40 (fields; first-connect and auth-failure behaviour).
- **D6-42** · **Low** · undocumented — Attention cards re-announce assertively on every visit
  - *Doc:* `RULES.md:44-45` (gates and asks announce assertively — when they open); `docs/design/20-attention-and-gates.md:21-24`.
  - *Code:* `ui/card.tsx:32` puts `role="alert" aria-live="assertive"` on every inbox card; `PrimaryPane` is re-keyed per surface (`App.tsx:258-260`), so each return to Attention re-inserts every open card as a new alert.
  - *Resolution:* fix code — announce on `input.opened` via the announcer (assertive channel) rather than by mounting.
- **D6-43** · **Low** · contradicts-design — Failure notifications fire for historical failures at launch
  - *Doc:* `docs/design/20-attention-and-gates.md:13` ("OS notification on run failure only").
  - *Code:* `attention/use-attention.ts:247` sends every failed run in the store (`runs.list({status:["failed"]})`, `:217`) as an alert item …
  - *Resolution:* fix code — only notify failures whose `finishedAt` is after the window opened.

### D7 — Accessibility and keyboard, implementation guide, workflow editing, dependency graph, design package

Full write-up: [D7.md](2026-10-13-review-detail/D7.md).

- **D7-01** · **Medium** (confirmed, was High) · contradicts-design — Workflow editor "Discard" confirmation breaks the confirm-in-place contract (previously recorded, still open)
  - *Doc:* `docs/design/RULES.md` rule 17 and `60-implementation.md:362-380` say the act with no way back arms its row: **Keep** first and focused, **✕ Confirm** in the danger tone, `Esc` through the layer stack.
  - *Code:* `packages/app/renderer/src/workflow/editor/workflow-editor.tsx:255-264,331-338`
  - *Resolution:* Fix the code. Reuse the armed-row pattern (`ClaimRow`), which is also follow-up 21's case for lifting it into `ui/`.
  - *Verified (verifier V3):* `docs/design/README.md:128-130` accepts a single armed Discard button; the missing `✕` is the undisputed part.
  - *Related:* D6-04, D6-30
- **D7-02** · **Medium** (confirmed, was High) · contradicts-design — Plan's waive and reopen confirmations: danger first, no ✕, no Keep focus, focus dropped (partly previously recorded, still open)
  - *Doc:* `80-dependency-graph-options.md:67-71` ("a waive that asks once") and `:149-150` ("reopening asks once"), together with RULES 17 (Keep first and focused, `Esc` via the layer stack) and `50:43-60,57` (focus never dropped …
  - *Code:* `plan/relationship-inspector.tsx:130-151`: the armed group puts the danger **"Waive, unblocking …"** before "Keep it", with no `✕`.
  - *Resolution:* Fix the code. Use the same lifted armed-row primitive as D7-01.
  - *Verified (verifier V3):* Overlaps C7-19. The docs disagree on whether reopen confirms at all (`60:370-372` vs `80:149-150`).
  - *Related:* D6-04, C7-19
- **D7-03** · **Medium** (confirmed (narrowed), was High) · contradicts-design — More implicit polite live regions than the spec allows (`role="status"`), including one that speaks on every editor edit
  - *Doc:* `50:166-172` names two polite regions: the step-transition announcer and the connection state.
  - *Code:* `role="status"` implies `aria-live="polite"`, and it appears in all of these:
  - *Resolution:* Decide, then fix both sides:
  - *Verified (verifier V3):* The clear harm is the editor status line announced twice per edit; the connection banners are partly documented.
  - *Related:* D6-09, C6-22
- **D7-04** · **Medium** (confirmed, was High) · contradicts-design — Event timeline is a `listbox` whose `option`s contain a button (nested-interactive)
  - *Doc:* `50:161-165` says a list whose rows hold controls must be a `grid` of `row`s with `gridcell`s, because a button inside an `option` is a control nothing can reach. It says the schedule table and the decision list "are the two such lists …
  - *Code:* `runs/timeline/timeline.tsx:183-204` uses `VirtualList` with the default `listbox` role.
  - *Resolution:* Fix the code. Make the timeline `role="grid"` with gridcells, or move the copy menu out of the row (into the docked detail or the timeline bar). Then update 50's "two such lists".
  - *Related:* C6-17
- **D7-05** · **Medium** (confirmed, was High) · contradicts-design — Leaving the workflow editor drops focus to the page body
  - *Doc:* RULES 10 and `50:43-60`: whatever removes a focused control says where focus goes next, a neighbour or the owning region, and never the body.
  - *Code:* `workflow/workflow-surface.tsx:166-178`: `onClose` and `onPublished` call `setEditing(false)`, which unmounts the whole editor, including the focused **Close the editor** …
  - *Resolution:* Fix the code. Return focus to the Edit button (or the canvas) when the editor closes, and to the canvas on Back to editing. Add the editor to 50's list of focus-move cases.
- **D7-06** · **Medium** · doc-conflict — "The editor reuses DraftBar and adds Validate all and Publish" is false, and quotes text 70 no longer has
  - *Doc:* `60-implementation.md:720-722`: "it is the one the workflow editor reuses — the editor adds **Validate all** and **Publish** to it rather than drawing a second bar".
  - *Code:* `workflow/editor/workflow-editor.tsx:292-353` hand-rolls `<div className="orca-draftbar">` and does not import or use `DraftBar`. It has no Validate (the validation panel is live) and no plain Publish. It does have **Close the editor** …
  - *Resolution:* Update the docs. Correct 60, `component-api.d.ts` (`DraftBarProps`) and the `draft-bar.tsx` header to say the editor shares the class, not the component. Add Close to 70's list. (Or decide to make the editor use `DraftBar`.)
- **D7-07** · **Medium** · contradicts-design — A read-only editor (someone else's draft, or a daemon that can't write) still registers every write key, silently dead
  - *Doc:* `70:107-108`: "you get theirs read-only … no palette, **no keys that write**, no publish".
  - *Code:* `workflow/editor/editor-canvas.tsx:186-247`
  - *Resolution:* Fix the code. Register the write keys only when `!readOnly` (re-register on change), or register them with `unavailable: writable.reason`.
- **D7-08** · **Medium** · contradicts-design — Config's DraftBar **Discard** drops a draft with no confirmation
  - *Doc:* `60-implementation.md:379-380`: "confirm only the act with no way back — cancel, waive, release, **discard a draft** — and confirm it on the row it was asked on".
  - *Code:* `config/draft-bar.tsx:131-133` is a plain ghost **Discard** that calls `onDiscard` directly.
  - *Resolution:* Decide. Arm Discard in place as the workflow editor's does (after D7-01's fix), or narrow 60's sentence to workflow drafts.
  - *Related:* D6-30
- **D7-09** · **Medium** · doc-conflict — Whether reopening a decision confirms: the docs contradict each other and the code does both
  - *Doc:* `60-implementation.md:370-372`: "Cancel, waive and release carry one; resume, decide and **reopen do not**".
  - *Code:* The decision list's reopen is armed with the danger tone (`plan/decision-mode.tsx:350-375`).
  - *Resolution:* Decide once, then make 60, 80 and both palette rows agree.
- **D7-10** · **Medium** · stale-doc — Palette "Start a run" as documented no longer exists
  - *Doc:* `60-implementation.md:388-402`: **Start a run**; the choice calls `runs.start { workflowId }`; "Three use it: Start a run, Decide, Update risk".
  - *Code:* `palette/start-run.tsx:37-110`
  - *Resolution:* Update the doc (60, "Palette write actions"): describe admission, both labels and the four pickers.
- **D7-11** · **Medium** · doc-conflict — "Every pointer gesture has a keyboard path" is not true in the editor (and the docs say both)
  - *Doc:* `50:112-114`: "Every pointer gesture in the editor (dragging a palette item, a node or a connection) has one of these keys or a palette or inspector control as its keyboard path".
  - *Code:* Dragging a node to pin its position has no keyboard equivalent (`editor-canvas.tsx:263-321`). ⌥↑/⌥↓ reorder the file, not the layout.
  - *Resolution:* Decide. Either add keyboard nudge and "insert on the selected edge" paths, or state in 50 and 70 that layout placement is pointer-only by design, with Tidy as the keyboard fallback.
- **D7-12** · **Medium** · doc-conflict — `tokens.json` usage note says keyboard selection uses `border-focus`, which the spec and tests forbid
  - *Doc:* `50:39-41`: selection is `surface-selected` plus the accent rail, focus is the ring, and they look different.
  - *Code:* `packages/design/tokens.json:79`, `surface-selected` usage: "Keyboard selection uses this plus **border-focus**, never this alone."
  - *Resolution:* Update `tokens.json` to say "plus the 2px accent rail".
- **D7-13** · **Medium** · stale-doc — The smoke job's audited-surface table is stale: wrong shortcuts, and Workflows never audited
  - *Doc:* `50:241`: "AxeBuilder over Attention, Runs and Agents".
  - *Code:* `packages/app/test/smoke/app-shell.spec.ts:131-149` (`AUDITED`)
  - *Resolution:* Fix the code (derive the digits from `SURFACES`, add Workflows), then update 50:241.
  - *Related:* D5-01
- **D7-14** · **Medium** · stale-doc — `component-api.d.ts` omits props the built components rely on
  - *Doc:* `60-implementation.md:45-47` and AGENTS.md: a divergence from `component-api.d.ts` is corrected in that file in the same PR.
  - *Code:* `WorkflowNodeProps`**: code adds `draft?: "added"|"changed"|"removed"`, `invalid?` and `flag?` (`ui/workflow-node.tsx`, used by `editor-canvas.tsx:520-533`). The API (`component-api.d.ts:848-867`) has none of them …
  - *Resolution:* Update `component-api.d.ts`.
- **D7-15** · **Medium** · contradicts-design — The editor's palette/outline column and its validation split are pane boundaries with no splitter
  - *Doc:* `50:196`: "Every pane boundary is draggable, and every one is a control".
  - *Code:* `workflow/editor/editor.css:54-58` gives `.orca-wfedit__sidebar` a fixed `width: var(--sidebar-width)` with no `--pane-*` and no `PaneSplitter`.
  - *Resolution:* Decide. Add boundaries such as `wfedit-sidebar` and `wfedit-validation`, or document these as fixed and give the validation cap its own token.
- **D7-16** · **Low** · stale-doc — The keyboard-map agreement test does not transcribe the Plan graph rows, and its `Esc` rationale is wrong
  - *Doc:* `50:236`: "the table below is transcribed and asserted". The table is above, as is the "map below" at `50:203`.
  - *Code:* `renderer/test/keyboard-map-agreement.test.tsx:66-137` has no `plan-graph` rows, although `50:94-98` lists five. The keys are registered (`plan/dependency-graph.tsx:117-141`, `ui/use-canvas-view.ts:166-186`) but nothing asserts them.
  - *Resolution:* Fix the test (add the plan-graph mount and rows, and the Esc row), and fix "below" to "above" in 50.
- **D7-17** · **Low** · undocumented — Registered keys the 50 table does not list
  - *Doc:* `50:62-101` (the table) and `:116`.
  - *Code:* `card` J/K "Next card / Previous card" (`attention/attention-surface.tsx:423-424`).
  - *Resolution:* Update 50's table.
- **D7-18** · **Low** · stale-doc — The ⌘\ label says "artifact panel"; the dock is now also Plan's inspector
  - *Doc:* `50:68`: "Toggle the docked panel"; `80:62-71`: the dock is a Plan surface too.
  - *Code:* `chrome/use-chrome-shortcuts.ts:33-37` uses the label "Show or hide the artifact panel".
  - *Resolution:* Fix the code label to "Show or hide the docked panel".
- **D7-19** · **Low** · undocumented — Application-menu accelerators bypass the KeyboardMap and palette; ⌘R can drop Config drafts
  - *Doc:* `50:116-119` and `60:282-288`: every shortcut is in the map and the palette ("a shortcut that skips it is a shortcut nobody can discover"). The `Esc` row says "never lose an unsent draft".
  - *Code:* `packages/app/src/main/app-menu.ts:47-85`
  - *Resolution:* Decide. Register ⌘O as a map and palette command (or document menu accelerators as an exception). Consider dropping or guarding `reload` in packaged builds.
- **D7-20** · **Low** · stale-doc — Pane-size section says "five" boundaries; there are seven
  - *Doc:* `60-implementation.md:199` says "There are five, and they are the ones that exist".
  - *Code:* `panes.ts:84-171` (`PANE_BOUNDARIES`) has seven: `sidebar`, `panel`, `runs-detail`, `runs-tree`, `plan-rail`, `plan-risk`, `plan-decision`. Of those …
  - *Resolution:* Update the doc and the `panes.ts` header.
- **D7-21** · **Low** · stale-doc — 60's as-built palette and popover statements predate v0.6.0
  - *Doc:* `60:332-334`: "Nothing was added to the chrome of any screen" for writes.
  - *Code:* v0.6.0 put writes on screen:
  - *Resolution:* Update the doc.
- **D7-22** · **Low** · contradicts-design — Counts that bypass `counted`/`unit`, which the sweep's pattern misses (one previously recorded, still open)
  - *Doc:* `60:156-161`: every count goes through `counted`, `countedOf` or `unit` with a no-break space ("so it holds in a `title`, an `aria-label` …"), and "`count.test.ts` sweeps the sources".
  - *Code:* `workflow/editor/editor-canvas.tsx:536`: `${inner.length} inside — double-click to open`. This is previously recorded and still open; the label also gives only a pointer instruction.
  - *Resolution:* Fix the code (use `counted`) and widen the sweep.
  - *Related:* D6-10
- **D7-23** · **Low** · stale-doc — Viewer `Enter` and the collapsed count cover `loop` too; the docs say subworkflow and parallel only
  - *Doc:* `50:81`: "Expand or collapse the selected `subworkflow` or `parallel`".
  - *Code:* `workflow/workflow-canvas.tsx:422-433` (`collapsedOf`) treats any node with `nested` graphs as a container, explicitly including a `loop` body. `Enter` toggles any such node (`:180-187`).
  - *Resolution:* Update the docs to say "`loop`, `parallel` or inline `subworkflow`".
- **D7-24** · **Low** · doc-conflict — 70 says the draft bar already shows "3 runs pinned to v11", then lists it as not built
  - *Doc:* `70:140-142` says, in the present tense: "The draft bar states this in numbers — `3 runs pinned to v11` — and each is a link". `70:304` says this is not built.
  - *Code:* no count. The review panel says only "Runs already started stay on v{base}" (`workflow-editor.tsx:483`).
  - *Resolution:* Update the doc and mark the line as intent.
- **D7-25** · **Low** · broken-reference — Code comments and the "historical" section quote 70 text that no longer exists
  - *Doc:* `70:166-167` (as-built): `layout.ts` is "thirty lines of arithmetic"; it is 671 lines.
  - *Code:* `workflow/layout.ts:4-6` still says "thirty lines" and quotes "you edit a list and a form, the graph follows" from 70.
  - *Resolution:* Update the comments and the historical bullet.
- **D7-26** · **Low** · undocumented — Validation rows and start-node deletion behave differently from 70's description
  - *Doc:* `70:113-114`: "Every row names where it is and selects it when pressed".
  - *Code:* `workflow/editor/editor-panels.tsx:193-216`: a graph-level issue in the current graph (no node or edge) has `where === ""`, so it gets no button and cannot be pressed.
  - *Resolution:* Update 70 to cover both.
- **D7-27** · **Low** · status-mismatch — 80 still says both options are built and frames B as hypothetical
  - *Doc:* `80:3-6`: "Both are built … `ScreenDepsDedicated` … `ScreenDepsMode`".
  - *Code:* only Option B exists (`plan/deps-mode.tsx`, `plan/dependency-graph.tsx`). Neither symbol exists anywhere in the repo; they lived in the Claude Design artifact. All three "if you pick B" changes have shipped (`80:48-71`).
  - *Resolution:* Update the doc: mark the comparison as historical and point the names at the artifact.
- **D7-28** · **Low** · contradicts-design — Waived dependency edges are drawn in the same colour as open ones (previously recorded, still open)
  - *Doc:* `80:128-130`: a dependency's "state is its colour and a word (`dependencyState`), never colour alone".
  - *Code:* `packages/design/semantics.json` `dependencyState`: `open: "graph-edge"`, `waived: "graph-edge"`. The colours are identical, and no `⊘` marker is on the edge (review follow-up 4).
  - *Resolution:* Fix the code (a distinct stroke or marker), or document it.
- **D7-29** · **Low** · stale-doc — The viewer still prints "ORCA keeps no copy" for pinned runs (previously recorded, still open)
  - *Doc:* `70:144-151` says `workflows.get({ id, version })` serves the pinned graph. `70:186-190` acknowledges that the viewer still draws the on-disk definition (follow-up 7).
  - *Code:* `workflow/workflow-surface.tsx:15,208` and `workflow/use-workflow.ts:18`.
  - *Resolution:* Fix the code (follow-up 7).
- **D7-30** · **Low** · contradicts-design — Native `<select>` popovers outside `Menu` (previously recorded, still open)
  - *Doc:* `60:424-428` ("every popover uses it") and AGENTS.md ("Every popover is a `Menu`").
  - *Code:* `template-authoring/surface.tsx:248,260,314`
  - *Resolution:* Fix the code.
  - *Related:* D6-07
- **D7-31** · **Low** · stale-doc — `component-api.d.ts` minor drift (`className`, optionality, location claims)
  - *Doc:* `component-api.d.ts:8-11` says the "built" primitives exist in `renderer/src/ui`. The entries listed below omit `className`, and `VirtualListProps.selectedIndex` is optional.
  - *Code:* `className` is accepted by `Chip`, `StatusDot`, `Card`, `Well`, `Duration`, `Time`, `ObjectId`, `ScheduleBadge`, `StateView` and `ConnectionIndicator` (ui/*), and by `OutputPane` (with `ref`).
  - *Resolution:* Update `component-api.d.ts`.
- **D7-32** · **Low** · broken-reference — `tokens.json` usage notes: a reference to a token that doesn't exist, and grounds that aren't named
  - *Doc:* `50:10-12`: the usage note names each token's grounds, and "a token whose note does not name its grounds is incomplete".
  - *Code:* `tokens.json:87` (`border-hairline`) says "anything that must be seen to be used takes **border-default**". No such token exists; it means `border-control`, as `test/contrast.test.ts:9` says.
  - *Resolution:* Update `tokens.json`.
- **D7-33** · **Low** · contradicts-design — Glyphs drawn from outside the bundled faces
  - *Doc:* AGENTS.md / `fonts/README.md`: glyphs come from a bundled symbol face, never the OS.
  - *Code:* The editor outline grip `⋮` U+22EE (`workflow/editor/editor-panels.tsx:115`).
  - *Resolution:* Fix the code. Add them to the subsets (or replace the grip), and extend `fonts.test.ts`.
- **D7-34** · **Low** · status-mismatch — `claude-design-prompt.md` is unlabelled history whose vocabulary conflicts with the system
  - *Doc:* `claude-design-prompt.md:38-39` gives run statuses as `created → running ⇄ waiting → completed | failed | cancelled`.
  - *Code:* The eight `RunStatus` values use `succeeded`, not `completed` (`semantics.json`).
  - *Resolution:* Update the doc with a one-line header marking it as the original brief, not current vocabulary.

### D8 — Implementation notes: native, update, first-run, diagnostics

Full write-up: [D8.md](2026-10-13-review-detail/D8.md).

- **D8-01** · **Medium** (confirmed, was High) · stale-doc — The byte-backed diagnostics preview doc describes an IPC/bridge API that was removed
  - *Doc:* `docs/implementation/diagnostics-byte-preview.md:3-53`. It says "`preparePreview` returns metadata and a fresh handle". It also describes one sequential `readPreviewBlock(handle, offset)` returning 16,384-byte blocks …
  - *Code:* `packages/app/src/diagnostics-contract.ts:57-69`: the bridge exposes only `status/setEnabled/setMinutes/prepareExport/cancelExport/chooseDestination/save/discardPrevious/retryCleanup/acknowledgeUnknown/subscribe`. …
  - *Resolution:* update doc. Mark it superseded by the save-only scope and describe the `prepareExport → chooseDestination → save` lifecycle, or retire the file.
  - *Verified (verifier V4):* The code is more private than the doc says, so a reader overestimates exposure.
  - *Related:* D9-05
- **D8-02** · **Medium** (confirmed (partly overstated), was High) · undocumented — Ordinary macOS startup now depends on the mounted replacement bootstrap, which auto-provisions the recovery namespace. Docs call the authority undecided or say it never happens implicitly.
  - *Doc:* `mac-replacement-native-producers.md:33-34`: "the replacement namespace never implicitly provisions its root". Lines 65-67: "The initial namespace provisioning/continuity authority must be supplied first". Lines 89-93 list "Who may …
  - *Code:* On every darwin launch, whether packaged or not, `index.ts:82-89` mounts `createManagedMacReplacementStartup`, and `index.ts:1230-1238` awaits `initialize([appWriterRoot])`. If ordinary startup is not allowed …
  - *Resolution:* decide. Record the chosen provisioning authority (main at first launch, before producers) and its failure modes (missing addon, non-APFS, port collision → recovery shell). Decide whether unpackaged/dev Mac runs should be gated. Then update the superseded statements.
  - *Verified (verifier V4):* `mac-closed-window-fixed-path.md` is consistent with the code; the undocumented part is first-launch auto-provisioning and its failure modes. Operational harm is counted in C5b-01 and C5b-07.
  - *Related:* C5b-07, C5b-01
- **D8-03** · **Medium** · stale-doc — Four first-run docs still say Windows first-run ownership is blocked; M21 implemented it
  - *Doc:* `first-run-durable-ownership.md:141-142`: "Windows ownership remains blocked under the inherited current-user observation contract."
  - *Code:* `packages/protocol/src/first-run-fence.ts:104-106` (Windows boot/host observation), `:143-147` (Windows volume via the native addon) and `:174` (Windows native lock).
  - *Resolution:* update doc. Add a dated note in each that Windows SID/NTFS support landed in the M21 delta, and link `m21-windows-first-run.md`.
  - *Related:* D11-07
- **D8-04** · **Medium** · stale-doc — Coordinator and candidate docs describe the pre-drain ordering; code now drains before download and refuses without a drain port
  - *Doc:* `mac-updater-coordinator.md:44-50` ("Implemented behavior"): approval serializes one verified download, then "acquires an all-window draft lease and then an atomic owned-daemon admission lease". It does not mention drain.
  - *Code:* `packages/app/src/main/mac-updates.ts:289-296`: on approval the coordinator observes or acquires drain before `downloading`.
  - *Resolution:* update doc. Add a superseded note to the coordinator, candidate, rehearsal and drain docs that points to `mac-update-replacement-recovery.md`, and fix the code comment at `mac-update-candidates.ts:68`.
- **D8-05** · **Medium** · stale-doc — Several slice docs still state "no production IPC / no renderer entry point / guard always refuses / no child-stop capability"
  - *Doc:* `mac-update-window-binding.md:143-144`: "There is no renderer-accessible Mac offer, approval, or install entrypoint". Lines 155-157: "`MacUpdateGuards.prepareAdmission` remains conservatively blocked."
  - *Code:* `index.ts:850-873` constructs `createManagedMacUpdateApplication` and calls `installMacUpdateIPC`. This registers `orca:macUpdate.read`/`orca:macUpdate.act` and pushes `orca:macUpdate.changed` (`mac-update-application.ts:113-146`).
  - *Resolution:* update doc. Add a one-line "superseded by …" status banner to each older slice doc; fix the `mac-updates.ts:2` comment.
- **D8-07** · **Medium** · status-mismatch — The M10 security review says #180 workflow drafts are "future source absent"; drafts shipped, with a different authority model than the recorded contract
  - *Doc:* `m10-security-contract-closure.md:58`: "#328 workflow draft read/edit/publish/ownership … **BLOCKED — future source absent** … Neither API/model ships at this pin." Line 62: "No durable per-principal workflow draft exists".
  - *Code:* Drafts shipped in #610 (11 Oct): `packages/protocol/src/workflow-drafts.ts:1-21` and `packages/daemon/src/workflow-draft-methods.ts`.
  - *Resolution:* decide. The owner should confirm whether the shipped #180 authority model satisfies the M10 contract, then update both docs.
  - *Related:* D4-01
- **D8-08** · **Medium** · stale-doc — The `app-native-recovery-composition.md` residual-task table is mostly done or superseded, and its ledger requirement conflicts with the fixed-path design
  - *Doc:* `app-native-recovery-composition.md:94`: the replacement bootstrap is not mounted.
  - *Code:* The bootstrap is mounted (`index.ts:82-89,1230`).
  - *Resolution:* update doc. Mark the table historical and point to `mac-closed-window-fixed-path.md` and `app-held-nonmac-verification.md`. Note in `mac-update-replacement-recovery.md` that the ledger-based recovery class is not the production owner.
- **D8-06** · **Low** · status-mismatch — All six pinned patches are presented as unapplied or pending, but their content is in the tree
  - *Doc:* `mac-update-replacement-recovery.md:103-105,118`: `571-shared-wiring.patch` "is an unapplied reviewable patch … The integration owner applies it".
  - *Code:* A line-presence check of each patch's added lines against the current target files (≥12-character lines) found the patches applied:
  - *Resolution:* update doc. Add an "applied in <integration>" note next to each patch link, or move the patches under an explicitly historical heading.
- **D8-09** · **Low** · stale-doc — The Windows native source digest is described as five inputs; the helper now hashes seven
  - *Doc:* `windows-diagnostic-envelope-composition.md:164-169`: "five-input Windows source digest … includes binding.gyp, clock.c, storage-windows.c, keys-windows.c and windows-delay-load.c".
  - *Code:* `packages/app/scripts/diagnostics-native-package.js:33-49` hashes …
  - *Resolution:* update doc. List the seven inputs, or mark the digest as pinned to its head.
- **D8-10** · **Low** · stale-doc — Rehearsal case counts no longer match the test file
  - *Doc:* `mac-update-rehearsal.md:47` ("The 16 pre-restart cases"), `:117` ("Eight additional integration schedules") and `:215` ("24 combined rehearsal cases").
  - *Code:* `packages/app/test/mac-update-rehearsal.test.ts` declares 16 `it` entries. The restart group is 4 plain tests plus `it.each` × 4 at line 203, which is 8 cases …
  - *Resolution:* update doc. Restate the counts or drop them.
- **D8-11** · **Low** · stale-doc — The native-mac-testing preparation docs are not reconciled with what was built (handoff forward link previously recorded, still open)
  - *Doc:* `docs/preparation/native-mac-testing/implementation-handoff.md` has no dated forward link to current foundations. **This was previously recorded, still open**: `docs/reviews/2026-10-07-living-docs.md:154`.
  - *Code:* The harness slices were built under `tools/packaged-mac/` (`executor-preflight.js`, `launch-environment.js`, `packaging-plan.js`, `acceptance-packet.js`), with tests in `tools/test/packaged-mac-*.test.js`. None of the proposed paths exist.
  - *Resolution:* update doc. Add the dated addendum to `implementation-handoff.md`, `fixture-contracts.md` and `harness-design.md`, as was done for `test-matrix.md`.
- **D8-12** · **Low** · stale-doc — The evidence template still promises an "immutable preview" for the diagnostic export
  - *Doc:* `docs/preparation/native-mac-testing/evidence-template.md:140-142`: "Optional native-validated #416 manual diagnostic export has its own consent, immutable preview and complete-report 1 MiB cap".
  - *Code:* In-app preview was removed; the flow is save-only (`diagnostics-contract.ts:57-69`; see D8-01). The 1 MiB cap is accurate (`diagnostics/profile.ts:7`).
  - *Resolution:* update doc. Replace "immutable preview" with the save-only descriptor (source, byte count, digest, lifetime).
- **D8-13** · **Low** · broken-reference — Minor reference and count drift
  - *Doc:* `shared-app-consolidation.md:59`: the coverage override is "at `vitest.config.ts:101`". `first-run-native-integration.md:17`: "`FirstRunBridge` and its four workspace-transition IPC routes".
  - *Code:* The app `functions: 95` threshold is now at `vitest.config.ts:107`; line 102 is the global `functions: 89`. First-run IPC now registers eight routes (`packages/app/src/main/first-run/ipc.ts:56-63`), adding `prepareRecovery` …
  - *Resolution:* update doc. Anchor to the setting instead of a line number, and note the four later routes.

### D9 — Preparation: crash recovery, diagnostics, native Mac

Full write-up: [D9.md](2026-10-13-review-detail/D9.md).

- **D9-01** · **Medium** · contradicts-design — `resume_failed` is recorded for unobserved or unauthorized resume outcomes
  - *Doc:* `manual-diagnostics-contract/failure-mapping.md:24` limits `resume_failed` to the case where "An already authorized, user-initiated resume failed". Line 55 adds: "Export `resume_failed` only when the resume operation outcome is actually …
  - *Code:* `packages/app/src/client/daemon-client.ts:544-550` (`runsResume`) wraps the whole call in …
  - *Resolution:* fix code. Emit only on a daemon-returned, authorized error response for `runs.resume`. Leave transport loss and pre-dispatch or auth refusals `unknown`, as the contract requires.
- **D9-02** · **Medium** · contradicts-design — Windows diagnostics keys use direct DPAPI, but the "single authority" contract and test matrix still require Electron safeStorage
  - *Doc:* `crash-recovery/integration-contract.md:3-4` says the document is "the single authority for this slice's engineering parameters".
  - *Code:* `packages/app/src/main/diagnostics/initialize.ts:26` selects `loadWindowsDiagnosticsKeyAdapter(legacyKeys)` on win32.
  - *Resolution:* update doc. Amend RC1 (§Key adapter), test-matrix "Keys" and native-packaging-acceptance:134 to record the Windows direct-DPAPI wrapper, its entropy/UI-forbidden settings and the legacy `v10` read-only path. Route the change through the Casey/Cal review that the contract requires for material changes.
- **D9-03** · **Medium** · contradicts-design — Windows private diagnostics DACL grants SYSTEM without the documented requirement and approval the privacy contract demands
  - *Doc:* `manual-diagnostics-contract/privacy-and-storage.md:59-62` says: "No `Everyone`, `Users` or `Authenticated Users` grants. Any SYSTEM allowance needs a documented platform requirement and D4 approval." D4 is still listed as pending …
  - *Code:* `packages/app/native/diagnostics/storage-windows-common.h:140-145` (`new_security`) builds every new private root and file DACL with `FILE_ALL_ACCESS` ACEs for the current user **and** `WinLocalSystemSid` (inherited by children). This code …
  - *Resolution:* decide. Record the platform requirement (for example backup or AV service access) and D4 approval in the contract or windows-native-implementation, or drop the SYSTEM ACE.
- **D9-04** · **Medium** · status-mismatch — Native Mac beta docs say no orphan-reconciliation command exists; main ships same-boot reconciliation (#570)
  - *Doc:* `native-mac-beta-readiness/readiness.md:7-8` (labelled "Current slice, 2026-10-09"): "#570 recovery remains with the separate integration owner; the current owner-loss path has no supported orphan-reconciliation command."
  - *Code:* #607 (`b3a2846`, 2026-10-09) integrated #570: `changelog.d/570-same-boot-first-run.added.md` ("Add explicit same-boot orphan reconciliation").
  - *Resolution:* update doc. Describe the same-boot reconciliation controls and their limits (same boot only, unknown-writer refusal, native acceptance still open), and keep the cross-boot gap explicit.
- **D9-05** · **Medium** · doc-conflict — Mac beta guide, ledger and checklist still describe an in-app diagnostics "preview", which the 9 October save-only decision removed
  - *Doc:* `native-mac-beta-readiness/getting-started-draft.md:131-132` tells testers to "Preview the exact allowlisted report, omissions and local destination before choosing local export". Lines 140 and 154 bind the guide to …
  - *Code:* The bridge has no preview methods (`src/diagnostics-contract.ts:57-69`), and tests assert their absence (`test/diagnostics-preload.test.ts:89-91`).
  - *Resolution:* update doc. Replace "preview" with the save-only flow (Export, then Choose destination, then Save), add the save-only banner to these four docs, and tell testers to inspect the saved local file before sharing.
  - *Related:* D8-01, D8-12
- **D9-06** · **Medium** · stale-doc — The contract's exact-field table has 24-hour bounds and omits the required `coverage` object; the schema and code cap at 15 minutes and require coverage
  - *Doc:* `manual-diagnostics-contract/contract.md:17` gives `windowMs` as "Integer 0–86,400,000", and `contract.md:32` gives `events[].offsetMs` as "Integer 0–86,400,000". The "Exact fields and meaning" table (`contract.md:10-35`) has no `coverage` …
  - *Code:* `schema-v1.json:35-38,169-172` set `maximum: 900000` (15 minutes).
  - *Resolution:* update doc. Set `windowMs`/`offsetMs` to 0–900,000, add the `coverage` row with its rolling-only requirement, and note that `omissions.unavailable` is fixed to `unknown` in the current producer.
- **D9-07** · **Medium** · status-mismatch — Diagnostics implementation packet status is stale: #470 is "not merged" and producers, clock and native adapter are "unconnected"
  - *Doc:* `manual-diagnostics-implementation/README.md:66-67`: "#470 has disabled storage/controller/IPC/UI integration. Its production native adapter refuses authority; production boot clock and diagnostic producers remain unconnected."
  - *Code:* #470 merged as `db579fb` (2026-10-08).
  - *Resolution:* update doc. Mark #470 merged, and say that producers, clock and native storage are connected but production capture is disabled and acceptance is still open. Add a dated "superseded by native-packaging-acceptance/windows-native-implementation" pointer to crash-recovery/implementation-handoff.md.
- **D9-08** · **Low** · stale-doc — Fixture README digest, size and description for `rolling.json` are wrong
  - *Doc:* `manual-diagnostics-contract/fixtures/README.md:20` lists `rolling.json` as 1227 bytes with SHA-256 `1fe14846…cff6`. Line 11 says the byte count and SHA-256 "cover those exact committed bytes".
  - *Resolution:* update doc with the new byte count and digest, describe it as a 5-minute coverage sample, and change the range to 934–1,369.
- **D9-09** · **Low** · undocumented — Runtime validator rejects every valid contract fixture; the runtime profile is an undocumented strict subset of schema v1
  - *Doc:* `fixtures/README.md:10-12` calls each valid file "the complete proposed export".
  - *Code:* `report-validation.ts:78-87` (file numbering) requires `coverage`, so all five one-shot fixtures fail.
  - *Resolution:* update doc. State in contract.md and fixtures/README that the current runtime validator accepts only the all-unknown rolling envelope until reviewed producers fill those fields, or add a runtime-shaped valid fixture.
- **D9-10** · **Low** · stale-doc — Older crash-recovery slices still say Windows native support, packaging, producers and the bridge are absent, without forward pointers
  - *Doc:* These documents sit next to the later Windows implementation in the same 2026-10-09 merge, and none links forward to it:
  - *Code:* The win32 loader is enabled (`native-addon.ts:17`, `native-storage.ts:40`).
  - *Resolution:* update doc. Add one-line "superseded by windows-native-implementation.md / production-adapters.md" banners, or a crash-recovery README listing the current authoritative documents.
- **D9-11** · **Low** · stale-doc — Test matrix cites "seven explicitly pending adapter cases" that do not exist
  - *Doc:* `crash-recovery/test-matrix.md:33` says "Seven explicitly pending adapter cases cover C21–C26." `implementation-handoff.md:338-339` says the opposite: "The seven previous real-adapter TODO families now have executable implementation tests."
  - *Code:* `packages/app/test/recovery-preparation/export-observations.test.ts` has 17 active `it` cases and no `it.todo`/`skip`. No `.todo(` appears anywhere under `packages/app/test` or `packages/app/renderer/test` …
  - *Resolution:* update doc. Drop the sentence or point to the implementation tests named in the handoff.
- **D9-12** · **Low** · contradicts-design — Approved export-cleanup design calls for a separate staging subdirectory; code stages next to the checkpoints
  - *Doc:* `crash-recovery/export-cleanup-proposal.md:39-40` says "Use one fixed export-staging subdirectory under the private app profile …
  - *Code:* `packages/app/src/main/diagnostics/recovery-disk.ts:53-65` (`allowedNames`) and `:867-890` create `export-stage.tmp` directly in the same diagnostics root as `slot-*.bin` and `*.key`. There is no staging subdirectory. Native storage …
  - *Resolution:* update doc. Record the same-root fixed name as the accepted layout. If directory separation was intended for cleanup isolation, fix the code instead.
- **D9-13** · **Low** · contradicts-design — Save dialog's default filename and title differ from the contract
  - *Doc:* `manual-diagnostics-contract/preview-and-consent.md:80` says "The destination picker proposes `orca-diagnostic-<reportId>.json`; no date, username, workspace name or title."
  - *Code:* `packages/app/src/main/index.ts:163-164` uses `title: "Save diagnostic preview"` and `defaultPath: "orca-diagnostics.json"`. That is a fixed name with no reportId …
  - *Resolution:* decide. Either update the contract to the fixed filename, or append the reportId. Retitle the dialog (for example "Save diagnostic report").
- **D9-14** · **Low** · doc-conflict — Contract packet status and decision table conflict with the reconciled contract; validator cites a missing file
  - *Doc:* `manual-diagnostics-contract/README.md:4-5`: "**Not approved for capture, retention, export implementation or tester use.**" Decision 9 approved the disabled implementation (`crash-recovery/integration-contract.md:33`), and #470 is merged.
  - *Code:* `profile.ts:2-9` and `recovery-contract.ts:73-85` implement the contract.md values.
  - *Resolution:* update doc. Annotate the README status and D1 as superseded by contract.md §"Reconciled rolling implementation budgets" and decisions 1–9, and fix the validate.py comment target.
- **D9-15** · **Low** · stale-doc — Schema `storeFormat` enum cannot represent the current store epoch
  - *Doc:* `manual-diagnostics-contract/contract.md:21` and `schema-v1.json:80-82` allow `versions.storeFormat` to be only `config-generations-v3` or `unknown`. The schema was revised on 2026-10-04 (15-minute bounds …
  - *Code:* `release-compatibility.json:2` is `"storeEpoch": "operator-journals-v4"` (protocol 2.0). The current producer always emits `unknown` (`snapshot.ts:51-61`) …
  - *Resolution:* update doc. Note that the enum is pinned to the 3 October baseline and must be revised (with a schema version decision) before any storeFormat producer is added.
- **D9-16** · **Low** · stale-doc — The 2 October native-mac-delivery packet has drifted from the as-built adapters
  - *Doc:* `native-mac-delivery/current-state.md:5-7,18,40` is the dated audit (appId `dev.orca.desktop`, no forward link). This is **previously recorded, still open** at `docs/reviews/2026-10-07-living-docs.md:154`.
  - *Code:* `appId` is `com.schadewitz.orca` (`electron-builder.yml:18`).
  - *Resolution:* update doc. Add a dated forward note from current-state, implementation-handoff and delivery-design to production-adapters, and from production-adapters to `docs/implementation/mac-native-provider-composition.md`, covering the in-app validator, the runtime JSON interface and the Command Line Tools Python dependency.
- **D9-17** · **Low** · doc-conflict — Living docs lag the merged native and diagnostics foundations and do not link the crash-recovery authority
  - *Doc:* `docs/ROADMAP.md:47` (last edited 2026-10-07) lists the M22 foundation as "fixture-only validation/identity producer".
  - *Resolution:* update doc in the ROADMAP/README owner's slice. Say "fixture and source-only candidate validator/producer (unrun)", and add navigation to crash-recovery/integration-contract and native-mac-beta-readiness/readiness.

### D10 — Preparation: private MCP, ACP, beta, first job, configuration and launch, prepared roots

Full write-up: [D10.md](2026-10-13-review-detail/D10.md).

- **D10-01** · **Medium** · contradicts-design — The guarded MCP launcher cannot use the access decision's least-privilege read-only grant
  - *Doc:* `docs/preparation/private-mcp-access/decision.md:57-64` proposes the initial credential: "only `runs.read`, `artifacts.read` and `workflows.read`" with a finite expiry. `connection-design.md:187-195` lists Launch/preflight …
  - *Code:* `tools/deploy/private-mcp-service/credential-policy.js:6-14,114-120` accepts exactly two envelopes: `scoped-six`, which adds `runs.start`, `runs.control` and `inputs.answer` …
  - *Resolution:* decide. Either add a reviewed read-only `scoped-read` policy to `credential-policy.js`, or add a dated note to decision.md and connection-design.md that the approved envelope became `scoped-six`/owned.
- **D10-02** · **Medium** · status-mismatch — M21 status in the living docs and the packet ("not frozen", "guided UI remains separate") is contradicted by the mounted guided launch and structured config
  - *Doc:* `docs/ROADMAP.md:46` lists #333 structured create/delete/reorder and #334 guided launch as remaining, and says #440 is "awaiting accepted packet/runtime freeze, not implementation".
  - *Code:* `packages/app/renderer/src/guided-launch/README.md:3-8`: "mounted integration … consumes the accepted #440 packet and #542 declarations (`703c422…`)"; `orca://launch`, the Config header and the palette open `GuidedLaunch`.
  - *Resolution:* update doc. Add a dated forward note to the packet README and interfaces.md naming #542/#548/#553 and the frozen contract file, and update ROADMAP M21 and docs/README:57 (living docs). The native, sample and acceptance gates still remain.
  - *Related:* D5-10
- **D10-03** · **Medium** · stale-doc — The encrypted intent journal now stores full launch commands, including input vars; the docs and a code header say it does not
  - *Doc:* `configuration-launch-implementation/interfaces.md:181-183`: "The launch draft retains its local typed input values; the review DTO does not echo them."
  - *Code:* `LaunchReview.command` carries the full `RunsAdmitParams`/`RequestsSubmitParams` with `vars` (`configuration-launch-contract.ts:88-90,120-131`; renderer `guided-launch/contracts.ts:67-82`).
  - *Resolution:* update doc and fix the code comment. Record the integrator's guided-command extension in interfaces.md and README, and correct the `admission-intents.ts:1` header.
  - *Related:* C5a-05
- **D10-04** · **Medium** · doc-conflict — Private-MCP decision and design docs still present the OAuth per-user identity chain and "BLOCKED (current)"; the selected and deployed topology differs
  - *Doc:* `connection-design.md:145-166` makes per-request OAuth issuer/subject validation and a subject-to-principal mapping the security contract.
  - *Resolution:* update doc. Add a dated forward note in decision.md and connection-design.md (and handoff.md) pointing to service-supervision/agent01-supervision and the actual-Cal matrix, stating that per-human OAuth attribution was deferred.
- **D10-05** · **Low** · contradicts-design — The built guided-launch preview omits fields the accepted interaction spec makes mandatory
  - *Doc:* `cal-first-job-experience/interaction-spec.md:21`: the minimum Target preview is "authenticated workspaceId/instanceId, connection epoch, observed time, server/protocol and effective operation scope".
  - *Code:* `packages/app/renderer/src/guided-launch/guided-launch.tsx:299-358` shows only `endpointId / workspaceId`, the generation, root and checkout lines, selection provenance, the vars and "Publication is unavailable". There is no instanceId …
  - *Resolution:* decide. Either add the missing preview rows or record an accepted deviation in the spec. Result-review UI not yet built is expected and not counted here.
- **D10-06** · **Low** · stale-doc — interfaces.md proposed shapes diverge from the frozen contract file
  - *Doc:* `configuration-launch-implementation/interfaces.md:113-121` defines `FieldMetadata` without `visibility`, and `:150` says "A form cannot infer that a field is non-secret because current `ConfigFieldDescription` has no flag".
  - *Code:* `configuration-launch-contract.ts:35-44` adds `visibility`, served by the daemon (`config-form-schema.ts:75`).
  - *Resolution:* update doc. Point interfaces.md at `configuration-launch-contract.ts` as the frozen source.
- **D10-07** · **Low** · stale-doc — The capability-map forward link proposed by the prior review was never added; classifications are now superseded (previously recorded, still open)
  - *Doc:* `cal-first-job-experience/capability-map.md:95-100` classifies C13/C14 as "active-integration-only", C15 as "documented contract", C17 guided launch as "future proposal" and C18 template editor as "future proposal".
  - *Code:* #415/#434 are merged (`docs/preparation/configuration-launch-implementation/README.md:56-60`). Guided launch is mounted (`guided-launch/README.md:3-8`). The template editor exists (`packages/app/renderer/src/template-authoring/*`, #544).
  - *Resolution:* update doc. Add the dated forward note without rewriting the C01–C22 rows.
- **D10-08** · **Low** · stale-doc — The beta-first-job offline evidence hash binding is broken by later fixture edits
  - *Doc:* `beta-first-job/validation.md:126-129`: "Source script/patch hashes bind this record to the implementation".
  - *Code:* `examples/beta-first-job/fixture.js` now hashes to `c1a0d31f…`. #609 (`24241f2`) added a Node >= 24 gate (`fixture.js:170`) …
  - *Resolution:* update doc. Annotate that the evidence binds the `bfb1310` implementation, or re-record the evidence on the current fixture.
- **D10-09** · **Low** · stale-doc — The beta-update-support "current" status predates the merged (disabled) Mac update orchestration and engine choice
  - *Doc:* `beta-update-support/update-contract.md:119-121`: "Mac updater selection/lifecycle is unimplemented".
  - *Code:* #550 (`3ffb16e`) and #607 merged a candidate-bound Mac update composition: `packages/app/src/main/mac-updates.ts:1-5`, `mac-managed-update-application.ts` …
  - *Resolution:* update doc. Add a dated note that lifecycle source and native-autoUpdater composition exist but are disabled pending authority and native acceptance.
  - *Related:* D11-04
- **D10-10** · **Low** · contradicts-design — The launcher's private-file ancestor check is weaker than service-supervision states
  - *Doc:* `private-mcp-access/service-supervision.md:19`: copy the profile "under a directory without writable or symlink ancestors"; the same rule applies to the token and credential-store files.
  - *Code:* `tools/deploy/private-mcp-service/credential-policy.js:163-165` accepts group- or world-writable ancestors when the sticky bit is set (`st.mode & 0o022 && !(st.mode & 0o1000)`) and never checks ancestor ownership. By contrast …
  - *Resolution:* decide. Either document the sticky-directory exception, or tighten the check to reject writable ancestors and verify ancestor owners.
- **D10-11** · **Low** · status-mismatch — m10-owned-plugin lists #558/#562 as still pending merge, but its code is on main
  - *Doc:* `private-mcp-access/m10-owned-plugin.md:193-195`: "Remaining gates: … separately pending #558/#562/new-slice review/CI/merge".
  - *Code:* `serveWithInstalledPluginRelease` (`packages/cli/src/commands/index.ts:961-973`), the manifest verifier (`packages/cli/src/plugin-release.ts:60-106`), the candidate and launcher …
  - *Resolution:* update doc. Note that the source is merged; root pin approval and host and actual-Cal gates remain.
- **D10-12** · **Low** · stale-doc — The actual-Cal matrix says maintenance production sources refuse observations; an opt-in Linux observer now exists
  - *Doc:* `private-mcp-access/actual-cal-matrix.md:42-43`: "Maintenance MCP is inactive and its production sources refuse observations."
  - *Code:* `packages/maintenance-mcp/src/linux-observer.ts:1,30,75` is an opt-in `fixed_linux_preparation` source that reads `/proc/meminfo` MemAvailable and kernel health.
  - *Resolution:* update doc. Change to "the default entry refuses; an inactive opt-in Linux observer exists".
  - *Related:* D1-13

### D11 — Research, mobile proposals, follow-through of earlier reviews

Full write-up: [D11.md](2026-10-13-review-detail/D11.md).

- **D11-01** · **Medium** · contradicts-design — Code comment still calls the corrupt-sidecar skip "conservative"; docs say it can drop deny rules
  - *Doc:* docs/research/tool-call-safety/current-state.md:121-125 says `loadEffectivePermissionPolicy` skips unreadable sidecars, that sidecars can hold deny/ask rules so skipping can expose later default allows …
  - *Code:* packages/agents/src/permissions.ts:238-246 still says skipping "is the *conservative* direction … Dropping it can turn an `allow` back into an `ask` …
  - *Resolution:* Fix the code comment now. Separately, decide whether to make the skip fail closed (the policy.md:325-327 direction). The docs are right.
  - *Related:* D1-05
- **D11-02** · **Medium** · stale-doc — RELEASING.md says packaging runs on `ubuntu-latest`; it runs on a self-hosted homelab runner (living-docs routed fix never applied)
  - *Doc:* docs/RELEASING.md:70-71: "`.github/workflows/desktop.yml` builds both, on `ubuntu-latest`, `macos-latest` and `windows-latest`." docs/reviews/2026-10-07-living-docs.md:153 routed exactly this correction to the native owner: "Replace the …
  - *Code:* .github/workflows/desktop.yml:51 is `os: [self-hosted, linux, x64, homelab]`, with macos-latest at :56 and windows-latest at :61.
  - *Resolution:* Update the doc as living-docs.md:153 proposes.
  - *Related:* D5-04
- **D11-03** · **Medium** · doc-conflict — Living docs still say five surfaces and no workflow editor; design-conformance and the code show a sixth Workflows surface and a built editor
  - *Doc:* docs/reviews/2026-10-10-design-conformance.md:43, :91-97 and :222-225: "Workflow editor … **Built**: drafts, visual editor, validation panel (#180–#182)" and "Workflows is the sixth surface (⑂, `⌘4`; Agents `⌘5`, Config `⌘6`)".
  - *Code:* packages/design/semantics.json `surface` lists six surfaces: attention, runs, plan, **workflows ⑂**, agents, config.
  - *Resolution:* Update ROADMAP, ARCHITECTURE, README and docs/README to say six surfaces with the editor built over drafts, validation still in flight and dry run (#183) still deferred.
  - *Related:* D1-02, D5-09
- **D11-04** · **Low** · stale-doc — "Main has no Mac update driver" understates the managed Mac updater that main composes
  - *Doc:* docs/ROADMAP.md:33: "Main has no Mac update driver."
  - *Code:* packages/app/src/main/index.ts:848-872 builds `createManagedMacUpdateApplication({... native: () => autoUpdater, activationAllowed: () => false ...})` and calls `installMacUpdateIPC(...)`.
  - *Resolution:* Update the doc to "Mac update application is composed in main but activation is hard-disabled (`activationAllowed: () => false`); no Mac `UpdateDriver`".
  - *Related:* D5-26, D10-09
- **D11-05** · **Low** · status-mismatch — Mobile and research docs call #459/#461 open drafts whose files are not in the checkout; both merged and are in-tree
  - *Doc:* docs/preparation/swiftui-readonly-pilot/README.md:19-22: "These are reviewed drafts, not merged specifications. Links are pinned because their files are not in this checkout."
  - *Resolution:* Update the docs with a dated note pointing the pinned links to the in-tree files.
- **D11-06** · **Low** · doc-conflict — Dated research describes ROADMAP.md as a stale 1 October ledger; ROADMAP has since been reconciled
  - *Doc:* docs/research/tool-call-safety/roadmap.md:161-165: "ROADMAP.md is a 2026-10-01 ledger: its statements that configuration generations/live callbacks remain future work are superseded by integrated code."
  - *Resolution:* Update the docs with a one-line dated note, or leave them as historical. These are a decision for the owners, not a code change.
- **D11-07** · **Low** · status-mismatch — 2026-10-09 integration reviews still say "local / unpublished / M21 disposition pending / Windows first-run refuses"; the same merge (#607) resolved those
  - *Doc:* docs/reviews/2026-10-09-integration-candidate.md:3-5 ("M21's final native disposition is pending") and :11 ("The candidate remains local. Publication and CI require the parent's prerequisite checkpoint").
  - *Resolution:* Update each review with a dated forward note pointing to #607, m21-windows-acceptance.md and m21-windows-first-run.md. The held gates (C15, Mac activation, exact-command, diagnostics) are unchanged and should stay as they are.
  - *Related:* D8-03
- **D11-08** · **Low** · stale-doc — Living-docs review's CI "current references" are superseded, and living docs still cite it as the evidence pin
  - *Doc:* docs/reviews/2026-10-07-living-docs.md:78: "serial Node22/24/full-check authority retained".
  - *Code:* .github/workflows/ci.yml:47-48 runs `node: [24]` only. Node 22 was retired in #609; docs/ci-shadow-selection.md:410 says "`check (node 22)` is retired".
  - *Resolution:* Update the doc by adding a dated "superseded by #609 / ci-shadow allowlist" note to the review, or by re-pinning the ROADMAP evidence map.
- **D11-09** · **Low** · stale-doc — Renderer comments say "no daemon advertises `runs.control` yet"; `orca serve` advertises it unless `--read-only` (found during the design spot-check, outside my assigned docs)
  - *Doc:* packages/app/renderer/src/connection.ts:82-84: "the answer today is almost always no: **no daemon advertises `runs.control` yet** (it arrives with the control methods)".
  - *Code:* packages/cli/src/commands/index.ts:1028-1036 builds `ControlModel` whenever `!readOnly`, and index.ts:1224 advertises `...(control ? ["runs.control"] : [])`. The capability is in protocol/src/handshake.ts:173.
  - *Resolution:* Update the comments. The other reviewers who own the renderer can dedupe this.
