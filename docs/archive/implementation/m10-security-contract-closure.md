# M10 bounded security and unsupported-adapter review

Reviewed on 9 October 2026 against exact combined #584 source
`88fc825daaa969675d4d6d06931bceb00ebbacec` (tree
`5ab1e5b7c612b1cf2077d5d3922dca1e7ab63008`). Live #584 subsequently advanced to
`dccde5ddd8a0539827a194ccdd882c718745c9ce`; its privacy projection is owned by
the integration task. This draft preserves the requested base and targets the
existing `calcifer/m10-m21-m22-same-boot-config-integration` branch. No issue
checkbox or ship-group scope is changed by this review.

The current bodies of [#356](https://github.com/cschadewitz/Project_Orca/issues/356)
and [#328](https://github.com/cschadewitz/Project_Orca/issues/328) were read before
implementation, including #356's 8 October merged-#549 correction. Their issue
comment lists were empty. Relevant future acceptance was read directly from
[#180](https://github.com/cschadewitz/Project_Orca/issues/180) and
[#336](https://github.com/cschadewitz/Project_Orca/issues/336). The checkout has
no `SKILL.md`; `AGENTS.md`, development conventions and the existing security
and operator contracts were reviewed.

## Genuine bounded source gaps

The old operation inventory allowed `config.set` with only `config.write`, even
though an empty validation patch returns the complete unredacted document. Save
now requires additional `config.read`; the guard enforces both before parameter
validation and method discovery. Apply retains its existing write-only grant.

The existing guard supplied current configuration authority to template authoring,
but the core get/set/apply handlers did not consume it. They now pass that authority
through reads, validation, writer locks, staged replacement and the existing
generation activation rechecks. The permission-sidecar writer accepts the same
optional check under its own existing lock and before rename. Local model callers
and explicit legacy loopback retain their established composition. No new grant,
credential, service, editor, secret backend or retry operation is introduced.

An already bound credential that becomes invalid now receives `AUTH_INVALID`
from the daemon's common current-principal seam, consistent with its other
authenticated services. Missing bindings retain `AUTH_REQUIRED`; withdrawn grants
receive `AUTH_FORBIDDEN`. Refused staged writes are cleaned up. Revocation before
replacement leaves file bytes unchanged; revocation before activation leaves the
active generation unchanged. A successful commit followed by a lost/refused
acknowledgement still requires explicit read/reconciliation; there is no rollback
or automatic repeat of a committed operation.

The initial focused regression run reproduced ten behavior failures across HTTP
and WebSocket: write-only raw receipt access, revoked config/sidecar save, revoked
raw read and revoked Apply. Two other initial failures were corrected test audit
field expectations. The final 20-case suite includes grant reduction, staged-file
refusal/cleanup, safe write-only Apply and preservation of untouched legacy inline
credentials and comments during an authorized patch.

## Remaining criterion disposition

| Current issue criterion | Result | Exact evidence and limit |
| --- | --- | --- |
| #356 unsupported adapters clearly reject revision | **PASS — source contract** | Real ACP JSON-RPC refusal in `m10-supported-client-acp.test.ts` preserves an existing protected pause, Requests, admissions, runs, public history and protected writes. Direct CLI `revision-rpc-wiring.test.ts` rejects missing installed methods despite a claimed capability. MCP SDK `mcp-operator-production-contract.test.ts` refuses an absent `revise_input` alias before diagnostics/backend mutation. These reuse merged implementations; no new revision source was needed. |
| #356 applicable exact-current platform/client regression and whole-issue completion | **BLOCKED beyond this bounded contract** | Source client evidence is recorded below. Historical Native87 remains pinned to its recorded source, and this Linux checkout does not establish a current packaged macOS/Windows result. Parent-reported actual revision delivery is retained within that proof's own scope and was not repeated. |
| #328 stable principal, ownership and grants for Request/direct launch, config and gate decisions | **PASS — implemented portion** | Existing `auth/principal.ts`, `auth/operations.ts`, `auth/ownership.ts`, `auth/resources.ts` and authenticated services retain stable principal IDs and current operation/resource checks. HTTP/WS gate/resource tests, operation inventory, retry-authority selection and the new configuration suite pass. This does not assert a workflow draft or secret resolver exists. |
| #328 workflow draft read/edit/publish/ownership and secret-reference-use portion of the same criterion | **BLOCKED — future source absent** | #180 requires a durable draft API and authenticated ownership; #336 requires typed host/provider references, metadata/list/use authorization, execution-boundary resolution and migration. Neither API/model ships at this pin. Template source Save/assignment/Apply is workspace-wide configuration authoring and cannot establish per-principal workflow draft ownership. |
| #328 raw config sensitivity/access restriction and preservation of hidden values | **PASS — present legacy boundary** | `config.get` remains explicitly unredacted and restricted to `config.read`; all Save/validation receipts now require that grant too. Current authority is rechecked after I/O. An authorized patch retains an untouched inline token and comments. The safe operator projection is never an editable raw document. |
| #328 complete #336 migration alignment, including reference-only drafts and no resolved values | **BLOCKED — future feature acceptance** | Legacy `agents[].env` still contains strings. Sensitive-run redaction/protected snapshots and template preview redaction do not implement typed secret references or prove revoked-reference resume behavior. No redacted document is promoted as a replacement editor source. |
| #328 reconnect and idempotency replay re-evaluate authority; existing child/artifact/linked isolation | **PASS — implemented portion** | Existing HTTP resource/gate, socket reconnect/subscription, admission fresh-validation and revision-production transport rechecks pass. Root ownership and grants are checked on replay. Existing artifact-reference and parent-reported child/artifact/fullRequest/plugin-restoration proof are reused within their original scope, without reproducing those happy paths. Event path leakage remains separately assigned. |
| #328 editor draft ownership portion of the replay/isolation criterion | **BLOCKED — future source absent** | No durable per-principal workflow draft exists to reopen, mutate, publish or authorize. A connection-target draft fence or template candidate revision is not that missing ownership boundary. |
| #328 complete deployment/client-migration/error/credential/audit documentation plus applicable checks | **BLOCKED as whole-issue completion** | Core deployment and local-client documentation and focused executable checks are current; root/renderer TypeScript and scoped lint/formatting pass. Full future editor/reference migration and complete deployed/client acceptance remain unestablished. Existing parent actual-client evidence is not relabelled as every deployment or native gate. |

## Security contract retained for future feature owners

Current credential principals are server-verified stable IDs, independent of
credential rotation. Ownership/audit must never use a caller's display name,
parameter-supplied identity, workflow ID, connection ID or old subscription as
authority. Existing Request operations require both `runs.start` and `plan.write`;
direct launch requires `runs.start` and workflow scope. Root attribution is durable;
children inherit root access, and linked resources require their own applicable
authorization. Config remains workspace-wide, with the grants described above.
One-time gate answers require exact pending input/run authority; standing decisions
require separate `permissions.grant` authority.

For #180, the required resource is the workflow plus authenticated draft owner:
one active editable draft per workflow/principal, separately permitted read-only
access to another draft, revision checks for every mutation, and publication bound
to the exact draft/base workflow hash. Read/edit/publish/discard must each enter
the deny-by-default operation inventory with an explicit grant/resource policy
before becoming discoverable. Revocation, changed scope, stale confirmation and
reconnect must re-evaluate that policy. Workspace-wide template/config grants and
hello method availability cannot substitute for the missing draft checks. This
records the current issue's requirement, without inventing new grant names or
claiming those handlers are implemented.

For #336, management/enumeration/metadata validation and execution use require
separately explicit authority over the provider/host/reference. Resolution happens
only at the permitted execution boundary; wrong-host, unavailable and revoked
references fail closed without a fallback. Capture, draft, provenance, notifications
and audit retain reference identity and no resolved secret material. Rotation and
resume must obey the reference lifetime/revocation contract. Legacy inline values
remain sensitive/unredacted until explicitly migrated. A future reference selector
must patch authoritative source without writing a redacted projection over hidden
values. This is a security prerequisite, not acceptance of an unimplemented resolver.

The owner scope question is: **Does M10/#328 require shipping #180 authenticated
workflow-draft read/edit/publish and #336 authorized secret-reference
list/validation/use now, or should the owner explicitly move those executable
future-feature criteria to their existing ship groups while retaining this tested
security contract in #328?** Until that decision, both parts stay open. No scope
transfer or waiver is made by this draft.

## Executed evidence and integration needs

Installed Node 24.19.0, Vitest 5.0.2 and TypeScript 7.0.2 were used. No dependency
installation or lock regeneration occurred. Root TypeScript initially encountered
a missing local app `node_modules/yaml` link; `yaml` was already declared/locked
at the base. Restoring the link to the existing installed 2.9.1 package removed
that environment failure. No app source/manifest or lockfile patch was required.

| Executed selection | Result | Source applicability |
| --- | --- | --- |
| Existing ACP, direct CLI revision wire and MCP contract files before source edits | 59 passes, 3 files | Exact `88fc825…` baseline; merged unsupported-adapter implementation reused. |
| `security-configuration-boundary.test.ts` | 20 passes, 1 file | Final bounded source delta; both real transports, disk-backed synthetic credentials, no provider process. |
| HTTP/WS/deployment security, operation inventory, config methods, generation security, template authoring and agents permission files | 149 passes, 8 files | Bounded source delta; existing locks/guard/template behavior retained. |
| Revision-production transport and admission fresh-validation, `-t 'rechecks\|authority'` | 20 selected passes, 55 excluded by name filter, 2 files | Current grant/root/retry authority; excluded cases are not execution evidence. |
| App/CLI runtime-auth and ACP typed retry-conflict wire files | 67 passes, 3 files | Current client bootstrap/transport/error behavior; no native keychain/platform claim. |

There are **315 distinct executed passing cases**: 59 on the pinned baseline and
256 on the bounded delta. Intermediate repeat runs of the new suite are not added
to that count. Root and renderer no-emit TypeScript, scoped ESLint/Prettier, prose
local-file links and whitespace checks pass. No broad suite, coverage, compiled
production rebuild, Actions dispatch/rerun or native run was performed.

All source edits are in daemon configuration/auth/method dispatch and the existing
agents permission-sidecar writer. Main, preload, Workspace and event projection are
unchanged. Current #584's later privacy delta touches no owned source file here;
integrate this commit without squashing or rebasing away the pinned ancestry, then
record final combined-head evidence separately. No reserved-file patch is needed.
No main-target publication, merge, release, deployment, signing, access change or
live provider operation is part of this handoff.
