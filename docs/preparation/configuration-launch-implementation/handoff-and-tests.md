# Ownership, freeze and acceptance

This is a future implementation map. **Do not launch implementation agents from
publication alone.** Parent review must accept the contract commit and exact
runtime baseline, resolve required shared interfaces and allocate the integrator.

## Owned paths

Preparation owns only the five Markdown files in this directory. Future feature
ownership below is proposed and must be collision-checked against the selected
runtime tree before kickoff.

| Owner | Direct edits after freeze | Reserved / coordination |
| --- | --- | --- |
| A: #333 structured forms | `packages/app/renderer/src/config/config-model.ts`, `config-form.tsx`, `config-surface.tsx`, `use-config.ts`, `draft-bar.tsx`; new `config/collection-model.ts`, `config/collection-controls.tsx`, `config/change-preview.tsx`; dedicated new `packages/app/renderer/test/configuration-studio-*.test.ts[x]` | No policy-editor rewrite, raw-editor replacement, protocol schema, daemon config model, main/preload or global design edits. Shared edits as proposal only. |
| B: #334 guided launch | New `packages/app/renderer/src/guided-launch/` and dedicated new `packages/app/renderer/test/guided-launch-*.test.ts[x]` | Consume A through injected navigation/refresh callbacks; do not import A's branch. No global route/palette/bootstrap registration or retry-controller ownership. |
| I: one integrator | Shared canonical types; daemon schema/config model and AST-safe edit lowering if approved; app main/preload/IPC/client/bridge/global type declarations; renderer `main.tsx`, `app.tsx`, routes/navigation/palette registration, connection boundary/draft registration, shared notifications and tests | Own all protocol/core/engine changes, barrel exports, manifests/lockfile, design token/component additions, aggregate smoke inventory. Reconcile existing #331 controller and MCP production ownership before editing shared runtime. |
| C: #386 first-run consumer (later) | Own separately allocated first-run module and native setup fixtures | Consume frozen target/config/launch contracts. No competing config editor, credential store, launcher, diagnostic collector or packaged-update engine. |

Paths in the first row abbreviate sibling files under
`packages/app/renderer/src/config/`. Future test suffix notation denotes `.test.ts`
or `.test.tsx`, not a literal bracketed filename. No file belongs to both A and B.
Any unlisted shared path goes to I; do not take it by convenience. All MCP files
remain with their current owners; this packet does not allocate them anew.

## Freeze and integration order

1. Re-read exact main, active retry integration and source contracts. Record a
   freeze comment naming the accepted full commit of this five-document packet
   and accepted runtime SHA. An actual published SHA belongs in that comment/PR,
   not a fabricated self-reference inside an uncommitted document.
2. I approves app-local shapes, metadata/edit lowering, D1/D2 dependencies and
   protected restart intent boundary. Product decisions remain with the parent/
   existing owners. Schema/API activation requires separate reviewed code.
3. Launch A and B independently with injected fixtures and one identical contract
   SHA. C can prepare first-run UI/error fixtures without claiming native setup
   or launch acceptance. No feature compiles against another feature branch.
4. Review each narrow diff and its negative tests. I integrates shared wiring on
   an existing/new authorized integration branch, preserving main/MCP ownership.
   Reconcile types once; do not duplicate controller or schema implementations.
5. Exact combined-head gates precede end-to-end acceptance. A doc PR, feature
   fixture pass or compiled MCP product pass cannot establish actual Cal or native
   beta acceptance. No main merge, release or deployment is authorized here.

Graph: accepted contracts/runtime → A and B fixtures → integrated #333/#334 →
#386 end-to-end. #424 and #420 inform the experience/asset; MCP can continue
independently. D1 projection coordination is a narrow interface gate, not a new
dependency on finishing all configuration-studio or Mac work before usable MCP.

## Copy-ready future task prompts

Replace both pin fields with actual accepted commits before sending. Their
absence is a stop condition, not permission to use moving main.

### Agent A: build structured configuration forms

Implement #333 from RUNTIME_SHA, consuming the reviewed five-document packet at
CONTRACT_SHA. Read AGENTS.md, docs/DEVELOPMENT.md, docs/design/RULES.md and relevant
checkout .agents/skills if present. Own only the A paths above. Reuse ConfigField,
the current raw editor, target/draft guard and revision checks. Implement collection
and optional-object controls only for the frozen metadata, preserve absent defaults
and unknown fields/comments, validate through the daemon seam, and distinguish
preview/save/apply acknowledgements. Use injected fixtures for unintegrated seams;
propose reserved edits to I without applying them. Do not edit credentials, grants,
MCP, main/preload, schema exports or release settings. Return exact head, owned
diff, tests and remaining integration gaps. Open a draft PR only within authorized
publication scope; do not merge main.

### Agent B: build guided launch workspace

Implement #334 from RUNTIME_SHA, consuming the same reviewed packet at CONTRACT_SHA.
Read AGENTS.md and the design/development guidance and relevant checkout skills.
Own only the B paths above. Keep Request and direct mode separate. Support the
reviewed D2 asset when supplied, otherwise use visibly synthetic fixtures and block
production selection. Consume existing target identity, typed validation, coherent
preflight and #331 admission controller through injected seams. No guessed checkout,
agent override or new retry ledger. Preserve exact receipt envelopes, current-auth
refusals and original intent on response loss; test keyboard, cancel/back, changed
target and late-response races. Propose global wiring to I. Return exact head, owned
diff, tests and gaps; no MCP edits, credentials, installs, deployment or main merge.

### Integrator: join configuration and launch

Use RUNTIME_SHA and CONTRACT_SHA plus independently reviewed A/B heads. Re-audit
active #331/MCP composition and retain their ownership. Consolidate types and
approved schema/edit lowering; wire main/preload/IPC and renderer boot/navigation
once. Resolve D1/D2 and restart-intent semantics with their owners before enabling
production launch. Run exact combined checks below. Keep unsupported capabilities
unavailable; never use a legacy detached RPC to imply retry-safe admission. Report
the assembled ancestry, actual enabled methods, failures and separately unrun
packaged/physical/actual-Cal checks. No main merge/release/deployment.

## Acceptance oracles (not executed by this packet)

| ID | Case | Required outcome / owner |
| --- | --- | --- |
| C01 | Empty supported config | Create host, agent and role entirely through forms, validate, review, save, explicitly apply; A/I |
| C02 | Array insert/delete/move; nested unknown fields and comments | Exact untargeted bytes/comments retained; stable keyboard focus; A/I |
| C03 | Record duplicates, dots/brackets, unsafe keys, optional object and union switch | No ambiguous targeting or prototype mutation; unsupported metadata refused without data loss; A/I |
| C04 | Defaults: absent/null/false/zero/empty | No automatic default materialization or false deletion; server validation authoritative; A/I |
| C05 | In-use host/agent removal and role/model mismatch | Precise authorized reference errors, no silent repair/save; A/I |
| C06 | Raw/form transition, cancel, navigation, reconnect | Preserve draft or explicit discard; no target crossover; A/I |
| C07 | External edit, Reload and concurrent save | CONFIG_STALE retains draft; no blind rebase/resubmit; new review required; A/I |
| C08 | Late validation/save and edit-during-save | Ignore old target/sequence response; do not clear newer edits; A/I |
| C09 | Save/apply response loss, generation race, restart-only setting | No false active claim; current-state reconciliation; failed apply leaves active generation intact; I |
| C10 | Raw/structured permission changes and sidecar | Current server authority, exact confirmation, no sidecar default or credential echo; A/I |
| L01 | Direct minimal job versus Request | Correct distinct persistent identity, supported selectors only; B/I |
| L02 | Required, typed, unknown and sensitive inputs | Existing validator behavior; no secret/default/enum echo; B/I |
| L03 | Workflow same-version content edit or config apply after review | Guarded stale refusal creates no new work; B/I |
| L04 | Missing/stale D1 checkout evidence | No launch or arbitrary path fallback; projection owner/I |
| L05 | Double-click and lost acknowledgement | One original durable admission; key stable; changed-command conflict; B/I |
| L06 | Disconnect, app restart and changed credentials | Recover original intent under current authority or explicit blocked state; no new root; B/I |
| L07 | Same URL/different workspace, new boot/epoch and late reply | Freeze original draft, invalidate review, never cross-route; B/I |
| L08 | Prepared/in-progress/recoverable-failure/accepted/terminal | Accurate separate UI states and IDs; no premature completion; B/I |
| L09 | Cancel/Back/Escape before and after send | No pre-send work; post-send close is not run cancellation; focus restored; B/I |
| L10 | Read-only, missing method, revoked access | Visible reason plus real server refusal; no fallback elevated credential; B/I |
| N01 | Both themes, keyboard/screen reader, short/tall window | Single live region, bounded scrolling, focus/error access and no run-status invention; A/B/I |
| N02 | Finder launch, spaces/non-ASCII path, unavailable tool/auth/workspace | Normal-app actionable setup, no hidden shell assumption; #386 |
| N03 | Harmless sample then authorized real agent, packaged/physical cohort | Separate signed-build/platform/real-agent evidence; #386/#388/#390 |

## Verification scope

For this preparation: check exactly five owned Markdown files, balanced code
fences, whitespace, all relative links against the pinned tree, unique C/L/N case
IDs, distinct A/B path sets, and published diff/base/head identity. Markdown is
excluded by repository Prettier configuration; do not call its success prose QA.
No runtime test, provider call, auth test, UI screenshot, real-agent execution or
native packaging is performed or implied.

For implementation: run repository typecheck, lint/CSS rules, formatting,
design generated-file checks, focused tests and aggregate suite/coverage/build on
the final combined commit, followed by actual app smoke per DEVELOPMENT.md. Record
passed/failed/blocked/not-run separately. Pin screenshots/artifacts to that build.
Native Mac and Windows physical acceptance and actual-Cal #393 proof remain
separate. Do not weaken assertions or count fixture declarations as execution.
