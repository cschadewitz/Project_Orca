# Shared v1 acceptance cases — reviewed expectations, execution still pending

Use the [contract](README.md) and [type fixtures](contract-fixtures.ts). Each row is a
synthetic specification for its named implementation owner. Baseline tests exercise
existing code only; no row below is claimed implemented by the new type-only ports.
The #706 owner supplies an independent effect observer when the corresponding path exists.

| ID | Given / transition | Required verdict or receipt / observed behavior | Owner |
| --- | --- | --- | --- |
| C01 | Legacy first allow followed by matching deny; no protected-path conflict | Retain legacy first allow; no deny-overrides migration | #702 |
| C02 | Same rules, strict captured/current ceiling forbids action | deny; zero dispatch, no judge/human bypass | #702/#703 |
| C03 | Current approved typed rule matches; proven invocation-only native option | allow with rule/revision; automatic response, zero extra human asks; one dispatch | #702/#703 |
| C04 | Same native cached grant, second invocation after rule revoke/expiry | Fresh check; deny/indeterminate as applicable; zero second effects | #702/#704/#705 |
| C05 | allow_always only, unknown native effect, or invented option ID | No strict allow delivery/dispatch; unsupported/indeterminate | #702/#705 |
| C06 | Required strict sidecar missing/corrupt despite legacy configured allow | indeterminate; zero dispatch; legacy behavior unchanged | #702 |
| C07 | resources/cwd/credential scope unknown, required complete by profile | indeterminate; judge cannot fill facts; zero dispatch | #702/#703 |
| C08 | Attribute authoritatively absent versus known empty versus missing | Explicit applicability validation; missing never becomes complete/absent | #700/#702 |
| C09 | Hook absent/disabled/config writable, mismatched tool/version/host, or checker outage | Strict admission/dispatch blocked; no silent policy-per-ask downgrade | #703/#704/#705 |
| C10 | Judge fit without delegated rule, expired review, wrong projection/action/rule revision | indeterminate or deny per deterministic ceiling; zero authority created | #701/#702 |
| C11 | Valid delegated fit and matching rule versus mandatory-human class | Rule can automatically allow first; second stays require-human | #701/#702 |
| C12 | Required judge timeout/malformed/oversized result; advisory unavailable | Required: indeterminate. Advisory: only independently rule-authorized path may allow, attributed as unreviewed | #701/#702 |
| C13 | Same toolCallId/request ID reused with changed bytes, cwd, stdin, environment, state or representation | Refuse identity substitution; new trusted invocation and evaluation required | #703 |
| C14 | Two simultaneous dispatches with same permit, or replay after reconnect/restart | At most one dispatch; stale handle refuses; original receipt/state lookup does not replay | #703 |
| C15 | Revocation/cancel/lease loss races with permit consumption | Serialize under owner fence; before dispatch blocks; after dispatch report observed stop/unknown effects | #703/#706 |
| C16 | Accepted live human answer; standing persistence failure or uncertain answer append | Preserve answer-recorded boundary; no unintended delivery, no replay/policy write after uncertain append | #702/#703 |
| C17 | Crash after consume, before completion acknowledgment | execution-unknown; zero blind retries; inspect/reconcile through existing recovery owner | #703/#706 |
| C18 | Symlink/rename after pathname check; file/state mutation before I/O | Stable handle/precondition or enforced boundary required; no false physical-confinement claim | #703/#706 |
| C19 | Native shell descendant, built-in tool, independent MCP, subagent, custom session or SSH path | Unsupported/unknown until exact separately certified path; no inherited universal coverage | #704/#705/#706 |
| C20 | Low-entropy secret, redacted context or unauthorized judge destination | No public raw secret/hash or unapproved egress; insufficient safe projection blocks review | #701/#706/#363 |
| C21 | Concurrent scoped-rule edits; caller has inputs.answer but lacks permissions.grant | Stale/unauthorized standing write refused; Allow once cannot create authority | #702 |
| C22 | Live turn ends while human/model pending; later UI reconnect | Original callback expires; durable evidence cannot restore it or its permit | #701/#702/#703 |
| C23 | SDK-parsed request lost duplicate-key information, profile requires raw validation | Unknown validation; strict profile refuses, no reconstruction claim | #703/#705 |
| C24 | Observation-only type fixture claims verified-per-execution based on source refs | Qualification refused pending exact installed and independent effects evidence | #704/#705/#706 |
| C25 | Policy has not issued needs-review, or an engine invents eligibility/delegation | No judge scheduling or permit; engine never implements a second eligibility evaluator | #702/#703 |
| C26 | Engine changes eligible model/config/destination/requirement, or calls judge before exact request registration | bindReview refuses or scheduling refuses; zero unregistered judge calls; changed config needs new preflight | #701/#702/#703 |
| C27 | Review returns after rule/revocation/state/config changes; completion reused with a different projection/request | completeReview validates retained exact request and current state; no stale allow/duplicate completion | #701/#702/#703 |
| C28 | Receipt says completed but delivery/effect observation is missing; inspection is unauthorized | Separate observations remain unknown; unauthorized inspection refuses; inspection never dispatches/replays | #703/#706 |
| C29 | Transport-unavailable versus valid evaluated abstention; unknown execution label or response-claimed judge version | Preserve execution attribution and approved composition; invalid status/config never yields permissive unavailable or authority | #701/#702 |
| C30 | Approved projection reference cannot be resolved, payload binding/schema/byte bound differs, or adapter asks for general store access | No judge call/egress; supply only validated immutable approved payload; no general dereferencer | #701/#703/#363 |
