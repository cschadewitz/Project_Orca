# Controller integration handoff (future work)

Implement only after separate controller authorization and review. This packet
defines no production service or ACP wire method and makes no change to a human
gate. Reuse #460/#462 provisioning, #332 captured generation and #424 launch UX.
#486's inactive installer is not a prerequisite for the first copier backend.

## Copy-ready sequence and interface

1. Resolve approved preparation policy from protected controller-owned storage,
   with approved repository/base, manifests/lock/inventories, exact backend/tool
   bytes, output/check budgets, profile and expiry. Task prose and workflow vars
   are data only. Restore the admitted run's original captured generation.
2. Provision through the captured built-in owned-root provider. Read and verify
   the original v1 receipt, Git-ready record, registration, branch, Git/common
   directories, root stat identities and exact preparation base. Preserve existing
   reserved identities. Missing/torn provisioning evidence blocks; do not add Git
   again or invent a ready record.
3. Acquire trusted exclusive ownership covering source, destination and gate
   answers/continuations for the entire preparation and verification interval.
   Use the existing lease/fence authority and #449's enforced supervisor boundary.
   An attestation flag, directory permissions or observation of a quiet root cannot
   satisfy acquisition. Refuse unsupported ownership coverage.
4. Reread durable attempt/result evidence under that authority. Existing/uncertain
   attempts or partial outputs prohibit another copy. Reserve one attempt in the
   existing protected execution evidence store; sync before any copy effect.
5. Independently revalidate every contract/input pin, no-follow root registration,
   full inventories, complete link allowlist and actual preparation-process
   capacity. Obtain a fresh authenticated nonce-bound checkpoint joining original
   run/step/input, captured generation, principal/scope/target, complete pages and
   still-waiting final gate step. Never recycle historical checkpoint evidence.
6. Invoke exactly the frozen reviewed wrapper/copy helper once, with private
   pinned binding bytes, the existing clean environment and bounded command.
   Preserve all refusal, timeout and partial-effect evidence. There is no alternate
   install/copy/sandbox path on refusal. The wrapper rechecks identity, capacity,
   access and freshness at its existing boundaries.
7. Independently verify complete destination/source inventories, modes/link text,
   independent unique inodes/nlink=1, source preservation, exact permitted shim
   edits and metadata, registration/base/branch and every approved root-local
   check. Use direct pinned tool entries, NODE_PATH unset, compile caching disabled
   and approved private HOME/XDG/temp. Check the same actual profile, then obtain
   a fresh post-verification still-unanswered gate checkpoint.
8. While still owning the fence, publish only a bounded result digest/reference
   and explicit profile/status/expiry into protected execution evidence. Failure
   to prove or publish after any possible effect stays uncertain, never fresh.
9. The existing launcher independently revalidates result/generation/authority/
   expiry and #449 enforcement at its existing start/continuation boundary. It
   proceeds only under approved launch policy. Preparation itself does not call
   inputs.answer, permissions.grant, startRun, resume, cancel or an ACP agent.

Proposed controller interface, deliberately not exported or implemented here:

```text
prepareOwnedRoot(originalAdmission, approvedPolicyRef, acquiredOwnership)
  -> { status: prepared | blocked | uncertain,
       originalBindingDigest, attemptRef, evidenceRef,
       preparationResultDigest?, actualProfileDigest, expiresAt? }
```

`originalAdmission` and `approvedPolicyRef` resolve through protected evidence,
not caller-provided paths or source overrides. `acquiredOwnership` is a live
trusted capability backed by the lease/supervisor, not serializable JSON claiming
ownership. Bounded result references must be integrity-bound and access checked.
`prepared` cannot imply `workerReady`; consumers preserve that distinction.

## Exact-file ownership seams at the source baseline

These are later integration touch points, not files owned or edited by #505:

| Existing file | Reuse / later integration responsibility |
| --- | --- |
| `packages/engine/src/workspace/owned-root-worktree.ts` | `OwnedRootWorktree.provision` and `validate`; preserve original v1 receipt/ready/Git registration; do not replace this provider |
| `packages/engine/src/workspace/git-worktree.ts` | Existing opt-in dispatch to owned roots; no untrusted provider/path selection |
| `packages/engine/src/configuration-generation.ts` | `ConfigurationGenerations.restore` and captured launch material; never swap in current repository configuration |
| `packages/store/src/lease-store.ts` | `LeaseStore.acquire`, `ownsLease`, `keepLease`, `LeaseStore.withOwnership`; reuse resource authority/mutation mutex, not a separate lock-file ledger |
| `packages/engine/src/run-context.ts` | `RunContext.withOwnership` for trusted fenced interpreter writes |
| `packages/engine/src/admission-execution.ts` | Existing first-attempt/start witness and continuation attachment boundaries; preparation readiness preflight must precede consumption/attachment |
| `packages/engine/src/orchestrator.ts` | Existing execution lease and owned-workspace preflight, before pooled/fresh agent sessions; preserve lease-loss refusal |
| `packages/store/src/execution-store.ts` | Existing protected generation/input/payload/policy-marker evidence; agree representation before adding preparation references |
| `packages/engine/src/direct-admission.ts`, `continuation-admission.ts`, `admission-retry.ts` | Original admitted identity and verified receipt/reconciliation; do not synthesize new admissions on uncertainty |
| `packages/integrations/src/acp-facade/orca-acp-agent.ts` | Later ACP facade adapter only after engine/controller contract; no independent preparation authority in prompt handling |

The run lease `run:<runId>` excludes competing interpreters and fences durable
writes. It does **not** exclude a same-UID process mutating source/dependencies or
answering a gate through another authorized route. The short-lived mutation mutex
is not a whole-copy filesystem lock. Heartbeat loss detection alone cannot make an
uninterruptible copy harmless. Later integration must establish source/root/gate
coverage, bounded stop, and publication revalidation using the existing authority
plus the supervisor; resource-key coverage and stop semantics need review. This
packet creates neither a resource namespace nor an additional ledger.

## Required #449 boundary and remaining decisions

[#449](https://github.com/cschadewitz/Project_Orca/issues/449) owns enforced
filesystem/process separation, trusted policy/private-state/credential exclusion,
controlled environment/network/model access, resource limits, principal/profile
allowlists, expiry/revocation and supervisor stop. A local worktree and cooperative
ACP permission check do not implement these controls. The existing deployed profile
is not certified by this packet or #502's historical owner invocation.

Before controller wiring, agree: protected policy administration and result storage;
full inventory streaming/reference format beyond the small synthetic oracle;
exclusive source/root/gate acquisition using existing lease authority; stop and
uncertain-outcome handling across revocation/lease loss; profile-specific required
checks and worker-readiness prerequisites; final first-start/continuation preflight
placement; and independently reviewed ownership of any shared bootstrap/ACP edits.
Controller acceptance must prove two competing owners, drift at each boundary,
process death before/after every effect and same-UID isolation without bypasses.

These decisions block live/controller acceptance, not synthetic packet review.
Keep uncertainty evidence until separately authorized inspection resolves what
happened. No deletion/reset, rollback, second copy, gate decision, terminal recovery,
new run, model session, product publication, merge, release or deployment follows.
