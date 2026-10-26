# Typed sidecar persistence compatibility gate (#702)

Inspected base: `df2e623175f58f2031efb0bb7386d2de1cae8990`. This is a
preparatory writer-refusal slice. **Typed persistence is blocked by the existing
replacement writer's downgrade behavior.** No typed schema is registered, no typed
writer is implemented, no production registration is enabled, and no migration or
user policy write was performed. The existing
[read adapter](strict-rule-read-adapter.md) and canonical `StrictPermissionRule`
remain the shared types. The proposed `StrictScopedRuleWritePort` stays a proposal;
peers must not interpret it as a supported storage capability.

## Reproduced compatibility failure

`PermissionPolicyFileSchema` accepts only version 1, but that alone is insufficient:

| Actual path at the inspected base | Existing version 2 bytes | Result |
| --- | --- | --- |
| `readPermissionPolicyFile` | Schema rejects version 2 | Refuses |
| `recordAlwaysDecision` | Reads existing document under sidecar lock | Refuses and preserves bytes |
| `replacePermissionPolicyFile`, no expected revision | Valid v1 replacement input; never reads existing version | Overwrites version 2 |
| Same replacement with matching expected revision | Hash compares bytes, without understanding their schema | Overwrites version 2 |
| Daemon `config.set` with explicit v1 text | Validates replacement text, then invokes the same replacement writer | Can overwrite version 2 |
| Daemon patch that retains version 2 | Prospective v2 document fails v1 validation | Refuses |
| Daemon patch replacing version with 1 | Prospective v1 document validates; unknown fields are stripped when serialized | Can discard typed material |

The [regression file](../../packages/agents/test/permission-writer-compatibility.test.ts)
executed against unchanged base source produces **6 failed, 8 passed**:
[failing-before output](strict-rule-persistence-evidence/older-writer-before.txt).
The two replacement variants and four unknown explicit version cases resolve
successfully when they should refuse. Reader/append refusal, stale compare, legacy
repair and authorization refusal pass already. The fixture uses opaque synthetic
restrictions, not an approved typed schema. No real policy is involved.

Putting typed fields into version 1 is also unsafe: the Zod reader strips unknown
keys and `serialize` writes a fixed key set. Neither field names nor timestamps can
make legacy heuristics typed authority. This inspection does not assert every
historical release has identical code: one supported current-main writer that
overwrites the document is enough to disprove the required compatibility property.

## Narrow hardening in this slice

`replacePermissionPolicyFile` now reads the existing document **inside the existing
sidecar lock**, after the original authorization callback and revision comparison.
A parseable object carrying an explicit version other than numeric 1 is refused
with `CONFIG_INVALID`, including unconditional replacements. No temporary policy
file is written in that case. The final authorization callback immediately before
rename remains unchanged. This protects upgraded binaries only; it does not alter
old executable behavior or make downgrading safe.

Version 1, absent files, omitted version, empty files and the operator's explicit
repair of malformed JSON retain their existing behavior. This distinction is
deliberate: malformed/truncated future typed bytes cannot be reliably distinguished
from malformed legacy bytes. **This preparatory guard is not itself a sufficient
minimum writer for a future typed format.** A typed-capable writer must refuse
malformed/empty existing material and offer a separately reviewed explicit recovery
procedure. No recovery bypass is introduced here.

## Concrete candidate contract, pending compatibility decision

If the parent accepts a minimum supported writer and no-downgrade requirement, the
candidate is **version 2 at the existing `orca.permissions.json` path**. Version 1
is never automatically upgraded. The candidate envelope is:

```text
{
  version: 2,
  agents: <unchanged v1 legacy agent/rule map, retained as legacy only>,
  scopedRules: {
    version: 1,
    records: [
      {
        rule: <canonical StrictPermissionRule>,
        approvalRecordRef: <protected reviewed-scope approval reference>,
        scopeEvidenceRef: <protected explicit-scope review reference>,
        actor: <existing MutationActor attribution>,
        authorityRevision: <original-principal grant check revision>
      }
    ]
  }
}
```

This notation describes a candidate, not a public parser, API, migration format or
second rule type. Unknown envelope/record keys and versions must refuse writes;
unsupported, corrupt, missing required or truncated material is indeterminate for
the enforcing source. Rule revision uses the canonical rule content binding;
file revision hashes the exact bytes. Ordering, revoked/expired entries, unique rule
identities and audit references are retained. Public hashes/references do not
authenticate their contents. Only the trusted owner may verify protected review
records and produce `StrictRuleRead` provenance bound to the current boundary.

The retained `agents` map cannot feed typed evaluation or supply omitted predicates.
An explicit Create scoped rule review must bind the full principal, host, runner,
operation, qualified resources, effective cwd/workspace, environment, coverage,
lifecycle and rule contents. Path, title, kind, `addedAt` and `grantedFor` never
supply those facts. Retaining a legacy entry does not reapprove it. A deliberate
v1-to-v2 transition must preserve legacy bytes/semantics and have explicit opt-in
and recovery acceptance; it cannot be hidden inside an append. No such transition
is implemented by this slice.

The compatibility alternative is to **exclude all incompatible binaries from the
supported writer set before opt-in**, including this preparatory v1 writer for
corrupt typed material, and prevent their concurrent use or downgrade while v2
remains. A new reader alone, lock, content hash, `minimumWriterVersion` field or
version bump cannot enforce that against the existing executable: it never checks
them before replacement. Parent must review the exact upgrade/deployment enforcement
and recovery procedure, including binary rollback and whole-root restoration.
Keeping old writers supported means typed persistence must
remain disabled. A separate store would change that tradeoff but is not authorized
and is not proposed as an implicit fallback. Changing file permissions, credentials
or host security to manufacture refusal is outside this work.

## Writer/source and UI handoff obligations

Keep one internal command: `createScopedRule({ rule, expectedRevision,
approvalRecordRef }, authority)`. The existing source's type seam is not a wire
contract. This port only persists: it cannot answer or dispatch the current invocation.
The separate UI's save capability must preserve that separation. No optional
judge/provider hook or credential is required for this path.
The trusted owner must snapshot the command before any await and bind its authority
closure to the original principal, credential, exact run/ask and captured ceiling.
The closure must verify the protected review's exact scope, actor and rule digest;
a client-supplied approval reference is not authorization. Derived source provenance
must remain bound to the exact ordered projection and fresh current boundary.

After compatibility is resolved, the writer must use the existing sidecar lock and
require a byte revision (`""` only for an explicitly reviewed absent-file state).
It must recheck current original-principal `permissions.grant` under the lock and
again immediately before rename, preserve unrelated legacy/typed records and actor
attribution, refuse stale edits without merging, and distinguish an uncertain
publication from a refusal. Current authority never widens captured authority.
Revocation/expiry and current policy are reread for every invocation and phase by
the existing source/evaluator; no cached rule or native option bypass is introduced.

Allow once and Deny have no standing-write command. If a future owner combines
rule persistence with an explicit standing answer, the existing
`LiveInputRegistry.performAnswer` ordering is the boundary to retain: authorize,
claim the exact callback under ownership, record `human.answered` with the existing
actor, then attempt the authorized standing write, then deliver the offered answer.
A failed standing write disposes/parks the callback without approval delivery. An
uncertain answer append consumes the identity without writing policy or reopening
it. An uncertain policy publication must not automatically retry or deliver; inspect
the exact retained record/revision under current authority before any explicit
recovery. Restart must not recreate a live callback from an audit record.

No new UI/protocol field is added here. The approval/UI worker must keep Create
scoped rule unavailable until a typed writer is actually supported; it cannot route
it through legacy `always`, infer a review from an ordinary answer, or report Saved
on an uncertain/refused write. Parent owns wire naming, review and activation.

## Actual source/writer inventory and remaining acceptance

- `core/src/model/agent.ts`: configured `PermissionPolicySchema`, recorded legacy
  rule schema, v1 read/write sidecar schemas. They contain no qualified typed scope.
- `agents/src/permissions.ts`: normal sidecar edit filesystem writer mechanics:
  append and replacement, shared lock/revision, fixed-key serialization and rename.
  The existing stale-lock recovery semantics are unchanged; this slice does not
  claim to strengthen their cross-process ownership guarantee.
- `agents/src/acp-session.ts`: per-ask legacy policy loading; unreadable sidecars
  cap later allows to ask, while configured rules retain their precedence. That
  legacy behavior cannot substitute for strict per-execution source enforcement.
- `agents/src/strict-permission-source.ts`: inactive, refuses legacy promotion and
  unknown versions; owner-qualified material and boundary double read only.
- `cli/src/bootstrap.ts` and `commands/index.ts`: wire the existing sidecar path,
  protected paths, ControlModel and config notification; no second writer.
- `daemon/src/config-model.ts`: full-text and patch replacement funnel into the
  shared writer. `methods.ts` and `auth/guard.ts` bind config authority separately
  from live-answer authority. Config edits use current config read/write permission;
  this slice does not relabel them as `permissions.grant`.
- `daemon/src/control.ts`: prepares legacy grants and appends after accepted answers.
  `auth/guard.ts` binds actor and original-principal live `permissions.grant` checks;
  `engine/src/live-input.ts` owns record-before-write/delivery and uncertain append.
  The legacy append does not receive the final in-lock authorization callback; a
  future typed writer must not copy that gap.
- App permission editor/approval projections and protocol schemas are v1 consumers,
  not independent filesystem writers. Test fixtures and demo/recovery scaffolding
  writing synthetic v1 files are not live typed migration paths.
- Generic recovery is a separate potential replacement path, not a version-aware
  policy editor. `store/src/recovery-inventory.ts` is read-only and includes a
  configuration/permissions component in its inventory schema. App
  `mac-fixed-path-recovery.ts` can restore complete protected roots and a binary
  through its closed-window tree port; `mac-replacement-recovery.ts` specifies
  exclusive complete-pair selection and refuses newer-write restoration. Neither
  establishes a typed sidecar schema or upgrades an incompatible writer. Any future
  supported restore/rollback including configuration must preserve the exact typed
  generation, respect revocation/no-replay, and keep incompatible binaries from
  reopening it. This slice changes no recovery or native implementation.

The local regression suite establishes parseable version refusal/preservation and
retained v1 behavior, with existing stale/concurrent edit and both authorization
recheck tests. It does **not** establish typed restart/migration/revocation,
corrupt/truncated typed recovery, uncertain typed publication, or end-to-end no
replay. Those remain blocked with typed creation; passing legacy tests cannot stand
in for them. No main CI success is claimed: combined main run `40276580664` was
pending at delegation. Parent owns exact-head acceptance, activation and merges.
