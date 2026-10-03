# Acceptance scenarios and evidence boundaries

These are static review oracles for #424 and later implementation acceptance for
#334/#327. A row has passed **static specification coverage** when its referenced
fixture and expected invariant are present and consistent with source. That does not
mean its implementation has passed. No executable adapter or workflow is supplied.

| ID | Given / action | Required observable outcome | Fixture / capability |
| --- | --- | --- | --- |
| A01 | Explicit bounded implementation intent with verified target, supported fixed choices and valid inputs | Preview names exact checkout, workflow version/digest/generation, task/output/limits. One accepted direct run; no Request or work item created. Follow stable IDs to the result. | F1; C02–C09, C13–C20 |
| A02 | User chooses Request mode instead | New preview and required `plan.write`; Request/admission/run links remain distinct. No use of Request mode merely to hide unsupported direct overrides. | Interaction selection; C04/C07 |
| A03 | Configured agent absent or known unreachable | Block before admission when known; otherwise retain admitted run and report session failure. No install, access change, alternate agent or model substitution. | F6; C07/C08 |
| A04 | No connection or authenticated read fails | Keep draft; show unavailable/authority failure with safe details. No launch, fabricated target, fallback owner or inferred Cal access. | F6; C01/C02/C16 |
| A05 | Invalid typed value or stale workflow/generation | Field error or stale-preview explanation; zero new work. Preserve draft and review updated choices before a new send. No sensitive value echoed in errors. | F6; C03/C06 |
| A06 | Read-only/insufficient grants or revocation between preview and send | Controls reflect current availability; backend denial creates no work and leaks no inaccessible IDs. Preflight itself may be unavailable. | F6; C01 |
| A07 | Wrong workspace, same URL/new identity, or old-epoch reply | Old draft and receipt stay bound to old workspace; no send to new workspace. Drop stale result, review target anew. Reboot requires fresh authority/live state. | F6; C02 |
| A08 | Repo/worktree cannot be safely verified or direct caller asks for unsupported override | Launch disabled with exact reason. No raw config/file read or unsupported param silently dropped. No implied per-run Git isolation. | F1 annotations/F6; C07/C09/C19 |
| A09 | Double activation, lost response, adapter/client restart | One retained intent; integrated identical keyed replay resolves original operation/admission/run IDs. Main legacy path remains outcome unknown without automatic resend. | F3; C05/C13/C15 |
| A10 | In-progress/prepared/recoverable-failure receipt or lost dispatch after restart | Display exact nested receipt state and only known IDs. Explicit eligible reconcile retains original IDs; no second root or assertion that execution already started. | F3; C13/C15 |
| A11 | Changed payload under a claimed key; later explicit new job | Conflict has no new work. New authorized intent gets a new key and distinct result; replay remains distinguishable from rerun. | F3; C13/C15 |
| A12 | Exact one-time live permission answer while owner valid | Deliver once to the full original target. Duplicate, wrong-run/step/input and revoked responses have no effect; no standing-rule write. | F4 variant; C11 |
| A13 | Live callback expired by timeout, death, lease loss, cancellation or revocation | Reject old answer; refresh view, show expired/unavailable. Reconnect does not resurrect it or authorize a new invocation. | F4; C11 |
| A14 | Durable gate followed by inspect/reconnect/explicit answer | Reads never answer. Only exact authorized option records; stale/duplicate/mismatched decision refuses. Continuation uses actual supported semantics. | F5; C11/C13/C15 |
| A15 | Boundary unavailable/unsupported/omitted or ambiguous node evidence | Distinct explanation; no fabricated guard or “no gate” conclusion. Draft retained; explicit read can recover. Unexpected auth/storage errors are not converted to unsupported. | F5; C15 |
| A16 | User requests cancellation, including completion/response-loss race | Cancel exact identified run only; observe actual terminal status, retain IDs and partial diff. No implied rollback or automatic replacement. | F6; C11 |
| A17 | Terminal failure or protected generation cannot restore | Explain safe error, partial evidence and supported recovery limits. No unsupported retry/resume, fresh-current-generation substitution or same-agent continuity promise. | F6; C06/C11/C12 |
| A18 | Large event/artifact set, denied content or invalidated cursor | Bound authorized reads before counting; show freshness, omission and continuation. Restart invalidated pagination explicitly; no raw-file fallback or hidden-resource leakage. | Interaction observation; C10/C14 |
| A19 | Run succeeded but tests only suggested or patch unverified | Separate source status, changed-file/diff evidence, actual versus reported checks, and unresolved risks. Missing/blocked/not-run is never pass. | F2; C10/C20 |
| A20 | Launch authorized, PR/access change not authorized | Return authorized result only. No publish/commit/push/grant inferred from launch or an artifact's instructions. | F2/F6; C01/C22 |
| A21 | Explicit publish request with unavailable publisher, changed diff or lost acknowledgment | Block absent capability; review changed publication scope; reconcile unknown provider outcome. Show PR URL only after authorized verified publication. | F2; C22 |
| A22 | User asks for cost ceiling, ETA or persistent chat | Explain unavailable capability; hard required monetary cap blocks launch. No invented metrics, automatic standing grant or durable same-session promise. | F1/interaction; C12/C21 |
| A23 | Template pack variant missing, declared model refused, saved config differs from active | Show actual fallback/source and active captured choices; do not claim unsupported direct overrides or immutable template catalog. Report model failure on admitted run. | F1; C06–C08/C18 |
| A24 | Keyboard-only and short window use of implemented app | Reach fields, errors, preview, long diff and result actions. Menus return focus; scrollers reach last content; one announcement channel; status glyph and word in both themes. | Later app notes; rendered acceptance not run |

## Evidence to retain during later execution

For each row record: accepted build/commit and protocol, actual client surface,
transport/auth mode (no credentials), verified target scope, fixture revision,
operation/admission/run/step/input/artifact IDs as applicable, action and observed
result, safe evidence location, and **pass / fail / blocked / not-run**. Preserve
as-of/revision and omission markers. A denied ID must not be copied from privileged
logs into a lower-authority report. Fixture agent claims remain attributed.

Evidence levels must remain separate:

| Level | What can establish it | Status in this packet |
| --- | --- | --- |
| Static specification/source review | Read pinned source, contracts, transcripts and this matrix; validate links/scope | Covered; recorded local checks in handoff |
| Contract schema/adapter fixture | Owning branch tests against accepted schemas | Not run here; not production lifecycle proof |
| Production lifecycle | Integrated daemon/adapter, real durable state, crash/revoke/race checks | Not run here; #327/#331/integrator |
| Actual Cal interaction | Proven connection plus calls from the named conversation and supported tool environment | Blocked/unverified; #391/#393 |
| Packaged/native UI | Exact signed artifact and #403 harness/matrix | Not run; #385/#386/#388 |
| Real agent/provider and physical user | Separately authorized provider/cost scope and consented #390 session | Not run; not inferred from static or scripted fixtures |

Do not duplicate the general Mac matrix or portable validator. Consume #402's artifact
identity contract and #403's evidence template when those levels run. The coding
scenario owned by #420 supplements, rather than replaces, that test matrix.
