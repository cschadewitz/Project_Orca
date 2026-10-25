# #594 provider evidence and callback binding proposal

Investigated 25 October 2026 from ORCA main
`0f45181c52dfc4bf1edd0e4469ff688dedef9189`. This is a source-backed decision
proposal and offline loss witness, not an approved provider contract or runtime
implementation. Exact-command approval remains unsupported and blocks the
pre-beta acceptance required by [#594](https://github.com/cschadewitz/Project_Orca/issues/594).

The [latest #594 comment](https://github.com/cschadewitz/Project_Orca/issues/594#issuecomment-6150016812)
also assigns actual-Cal live-callback lifetime acceptance here.
[#393's final disposition](https://github.com/cschadewitz/Project_Orca/issues/393#issuecomment-6150032868)
passed durable gates and deferred that live row; it does not establish native
command correspondence. Preserve the [earlier disposition](m10-live-command-evidence-disposition.md)
and [#506 source map](../preparation/acp-command-conformance/source-map.md) as
dated evidence.

## Current release and compatibility findings

Release discovery used upstream GitHub release pages, followed by source reads
through Cal's GitHub connection. No provider executable or package was installed,
replaced, started, or asked to approve a command.

| Source | Exact pin | Meaning |
| --- | --- | --- |
| [codex-acp latest: 2.2.2](https://github.com/agentclientprotocol/codex-acp/releases/tag/v2.2.2), published 10 October | `202e66e63343ec4f5a5e35ab590251d813d129ca` | Current released bridge source reviewed below; not an installed artifact claim |
| [Codex 0.160.1](https://github.com/openai/codex/releases/tag/rust-v0.160.1), published 5 October | `d27764b82f7118f674371e6d6e76271d9d606edb` | Declared native dependency floor of bridge 2.2.2 |
| [Codex latest: 0.164.0](https://github.com/openai/codex/releases/tag/rust-v0.164.0), published 23 October | `6aaac694803004a63c6f393d153c96d22521a6b9` | Separately reviewed native candidate, not a declared-compatible bridge pair |

Bridge 2.2.2's [manifest](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/package.json)
declares `@openai/codex: ^0.160.1`. For a pre-1.0 package this means
`>=0.160.1 <0.161.0`, excluding 0.164.0. A dependency range is neither an
installed selection nor a support certification. The two latest releases must
not be reported as a tested or declared-supported pair.
[Codex npm latest metadata](https://registry.npmjs.org/@openai/codex/latest)
also reported 0.164.0; adapter npm publication and installed artifact
correspondence were not established.

### Native evidence is richer, but incomplete and not carried through

The native [0.160.1 request type](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1549)
and [0.164.0 request type](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1560)
both retain thread, turn, item, action kind, start time, optional distinct approval
ID and nullable environment identity. Command and cwd are optional. Subcommand
and stdin callbacks can share an item but have distinct approval IDs. A null
approval ID for a regular command does not eliminate the need to bind the actual
pending JSON-RPC request.

The [0.160.1 emission](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server/src/bespoke_event_handling.rs#L668)
and [0.164.0 emission](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server/src/bespoke_event_handling.rs#L676)
preserve a shell-quoted representation of the native command vector on the
regular command branch. The network branch supplies network context with
command/cwd absent. Additional permissions and available decisions are
experimental fields; both reviewed request types' stripping helper removes
additional permissions. Missing scope remains unknown, not inferred empty.
These sources do not prove effects, installed routing, or that every execution
emits a permission request.

Native [0.160.1 permissions](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs#L773)
and [0.164.0 permissions](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs#L773)
still define turn/session grants. Strict auto-review applies to later commands
in the turn; it is not a one-command scope.

### Bridge 2.2.2 still loses the required correspondence

All bridge links below use `202e66e63343ec4f5a5e35ab590251d813d129ca`.

| Source | Finding |
| --- | --- |
| [CommandReporter.permission](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/tool-calls/reporters/CommandReporter.ts#L96) | Applies `stripShellPrefix`; forwards selected command/cwd/URL/additional-permission fields and uses item ID as tool-call ID. Does not carry native turn, distinct callback, kind, or environment identity in this permission evidence |
| [CommandUtils](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/CommandUtils.ts) | Same 300 bytes and SHA256 as historical 2.1.1: `ca8042763f4bb36a2cbf9641beb647fed95338a4f4f827ddecaeb143b2628890`. Distinct shells/flags collapse to one display string |
| [CodexApprovalHandler](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/permissions/CodexApprovalHandler.ts#L44) | Captures native command decisions and maps the ACP selected option back, but sends the lossy reporter facts. Internal response routing is not exported reviewable native evidence |
| [Decision contract](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/permissions/command-decision-contract.ts#L14) | Validates supplied decisions; missing/null decisions still fall back to bridge defaults. Defaults do not attest an authoritative native offer |
| [Profile options](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/permissions/options.ts#L130) and [response mapping](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/permissions/CodexApprovalHandler.ts#L139) | Two profile choices have ACP kind `allow_once`, but grant a turn, including the strict-auto-review variant |

Neither the historical pair nor the reviewed current bridge establishes an
end-to-end exact-command contract. Native 0.164.0 alone does not repair bridge
loss. This investigation does not certify other providers or unreleased branches;
none is selected as a fallback.

## Decision proposal for Casey

Implementation/coordination remains with Cal. Casey retains the provider/product
choice and the choice of principals allowed to review private evidence. No
provider implementer or approved replacement version is inferred here.

| Option | Work and consequence |
| --- | --- |
| Keep existing profile unsupported | Safe current behavior and disabled positive handoff remain. This temporary blocked state cannot satisfy #594 or the Mac beta gate |
| Commission a versioned codex-acp evidence extension, with its native dependency explicitly pinned and supported | Recommended next decision: reuse ACP/live-input, preserve native evidence before presentation, then add ORCA's bounded private projection and binding checks. Upstream or another explicitly maintained bridge build must own the contract. Native work may also be needed to make complete scope reliably available |
| Commission a separate direct-native adapter or another provider investigation | Additional product choice, not a proven shortcut. Adds adapter/lifecycle ownership and must meet the same evidence, privacy, installation and actual-Cal requirements; no such adapter is implemented or selected |

The concrete decision needed is the supported provider/bridge implementation and
exact version pair, who owns that maintained contract, and who may review its
allowlisted private fields. An upgrade instruction, generic ACP option kind, or
agreement to this proposal alone cannot enable approval.

## Smallest proposed binding and lifetime contract

These are proof obligations for the provider implementer, not a wire schema,
accepted capability flag, or new authorization API. A field named `trusted`, an
opaque token, a hash, or signed arbitrary model text cannot create native authority.
The trusted boundary is the verified native process plus the source-reviewed
bridge and ORCA adapter; the proposal protects against model/client substitution,
replay and lifetime races, not a compromised trusted provider.

1. **Capture at the native request boundary.** The bridge captures the original
   JSON-RPC method and pending request ID on its owned native connection, before
   display transforms. Freeze native thread/turn/item/distinct callback identity
   (including explicit null semantics), action kind, environment identity,
   original command representation with shell/flags, cwd, complete
   decision-relevant scope and native offered decisions. The same callback
   closure owns that envelope and its response mapping. Never synthesize missing
   fields from titles, parsed actions, history, request text, arbitrary `rawInput`
   or `_meta`.
2. **Prove completeness and scope.** Distinguish missing/stripped/unknown scope
   from authoritative absence. Eligibility requires a source-validated ordinary
   command request and an explicitly offered native one-command decision.
   Network, stdin, subcommand, permission-profile, turn/session and policy-amendment
   requests need separate semantics; initially exclude them from exact-command
   eligibility. Nullable environment identity needs a source-backed
   local-environment interpretation or remains incomplete. Legacy default
   decisions are insufficient.
3. **Attach through a trusted seam.** ORCA accepts evidence only from the
   source-validated, versioned provider adapter attached to that live transport
   invocation, not a caller-supplied metadata validator. The adapter must prove
   native request-to-ACP callback correspondence. ORCA mints an owner-local review
   identity for an immutable snapshot, linked to that provider connection/callback
   and the existing seven fields: run, step, request, daemon instance, session,
   turn and invocation. Native IDs alone are insufficient; regular approval IDs
   can be null and parent item IDs repeat. The review identity is an opaque
   reference, never a bearer permission or private payload digest.
4. **Project privately and completely.** Only an explicitly authorized reviewer
   sees the narrow allowlist needed for command/cwd/scope and option mapping.
   Bind that projection and selected option to the snapshot. Preserve the 12 KiB
   row and 256 KiB result limits, UTF-8/JSON framing and existing transport
   overhead budgeting. Missing, redacted, truncated, oversized, unsafe-to-disclose
   or unverified evidence gets explicit unavailable/incomplete/unsupported state
   and no positive exact-command choice. Do not export full protected context,
   environment values, credentials or private digests. Shell text can contain
   secrets; a regex is not disclosure authorization. If safe full review is
   impossible, this route remains blocked.
5. **Recheck and consume under original ownership.** Revalidate current
   credential, run scope, review authority, unchanged snapshot/option mapping
   and native pending callback on the original connection at answer time. Use
   the original interpreter lease/mutation mutex, existing seven-field identity
   and execution-authority checks. No replacement lease, recovered callback,
   synthetic re-request or new turn inherits approval. Claim once before awaits;
   retain durable-record-before-delivery semantics. Abort, turn end, owner
   death/restart, lease loss, revocation or changed evidence invalidates the
   binding. Lost acknowledgement or uncertain append/delivery never justifies a
   second native response.
6. **Keep proof stages separate.** Record native request, bridged request,
   authorized review/selection, callback delivery and independently observed
   command effect separately. Accepted once does not prove execution; a recorded
   answer can have `delivered:false`. No standing grant follows from a one-command
   decision; existing separately authorized standing writes remain separate.
   Generic ACP callbacks retain their existing supported behavior.

### Existing ORCA seams to reuse

[ACP session](../../packages/agents/src/acp-session.ts) already mints a fresh
invocation in an active turn. [Orchestrator](../../packages/engine/src/orchestrator.ts)
retains the tool call privately and builds the original live binding, but filters
options by ACP kind rather than native scope. [LiveHumanInput](../../packages/engine/src/live-input.ts)
snapshots answers/options, checks all seven fields, claims before awaiting,
rechecks authority under ownership, records before delivery, and refuses replay
after uncertain persistence. Preserve those semantics rather than adding another
gate engine.

[Protected events](../../packages/store/src/protected-event-store.ts) hold originals;
[operator reads](../../packages/daemon/src/operator-read-model.ts) omit context
and enforce row/result budgets. [The closed protocol](../../packages/protocol/src/operator-reads.ts)
has no approved exact-command review projection. Arbitrary fields cannot establish
provenance. Production code and these support boundaries are unchanged here.

## Verification required before positive handoff

| Layer | Required evidence and negative cases | Current disposition |
| --- | --- | --- |
| Source/pure helper | Exact source pin/digest; distinct wrappers collapse without executing commands | Offline loss witness in this PR |
| Bridge contract | Native method/request-ID/callback-to-ACP correspondence; missing/experimental scope; original command/cwd/environment; explicit decision mapping; profile/network/stdin/subcommand separation | Proposed obligations; not implemented or accepted |
| ORCA synthetic integration | Seven wrong-field cases, same item/new callback or turn, forged metadata, changed command/cwd/scope/options, concurrent answers, revocation, lease loss, abort/expiry, owner death/restart, uncertain persistence and lost acknowledgement; no positive delivery for each ineligible case | Existing generic #506 lifetime suite is separate; it does not validate this proposed extension |
| Private projection/transport | Exact 12 KiB/256 KiB boundaries, multibyte JSON/framing budget, complete safe fields, authorized/unauthorized reader and answerer, omission/redaction/oversize with no positive choice | No new projection implemented |
| Installed provider | Privately verify resolved launcher/native executable, dependency selection, artifact/source identity, effective managed routing and offered scope on the selected build | Unknown; no installation or activation changes |
| Actual Cal, including C6b | Separately authorize exact shell/wrapper/cwd/effect/target/profile/lifetime/budget; observe one original callback delivered once and effect independently; scoped duplicate/wrong-field/death/restart/revocation/lost-response cases | Unexecuted; no live approval or disruptive action authorized by this preparation |

The [disabled live handoff](../preparation/acp-command-conformance/live-test-handoff.md)
and [safe evidence format](../preparation/acp-command-conformance/evidence-format.md)
remain the entry points after prerequisites. Do not enable the handoff from
source/synthetic success. Link final installed and actual-Cal evidence to
#327/#393, #385/#390 and #602 before claiming beta acceptance.

### Reproduce the offline witness

With the repository's existing supported dependencies:

```sh
node node_modules/vitest/vitest.mjs run \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/acp-command-conformance-506.test.ts --maxWorkers=1
```

The [new test](../../tools/test/acp-command-evidence-source.test.js) verifies the
vendored helper's exact 300-byte SHA256 before stripping TypeScript annotations
and importing that pure helper in memory. Five cases cover five-to-one shell
presentation collisions, two unrecognized-wrapper controls, quote loss and
uninterpreted multiline data. No native CLI, bridge, model or command runner is
started. The #506 suite uses synthetic ACP peers and memory counters; successful
generic callbacks do not prove exact-command acceptance.

The direct shell lookup of GitHub's public releases API was refused by the
environment's proxy (CONNECT 403), without retry or escalation. Available
GitHub connector and web source reads supplied the release/source evidence;
adapter npm metadata and installed artifacts remain unverified. No denial was
used as grounds to relax provider or sandbox policy.

### Local validation and review scope

On Node 24.19.0 with existing Vitest 5.0.2 dependencies, the focused command above
passed 36 tests with zero skipped (five new source cases and 31 unchanged generic
#506 cases). Scoped ESLint and Prettier passed for the new test. Changed Markdown
was checked for UTF-8, LF, final newline, trailing whitespace, balanced fences
and local file links; upstream release pins and source claims were reviewed.
No dependency install or lockfile edit was needed.

Self-review checked the release-pair mismatch, native/bridge identity loss,
profile grants, model/client forgery boundary, immutable review/callback binding,
seven-field identity, original lease, uncertain delivery and projection bounds.
This is self-review, not independent security or installed-provider acceptance.
Full suite, build, global typecheck/lint, native platform proof and live acceptance
were not run for this docs/offline-test preparation. Final-commit checks and remote
CI disposition are reported with the draft PR, separately from these source claims.
