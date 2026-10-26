# #706 composed synthetic acceptance: integration gate

Source inspection on 26 October 2026. This is a bounded integration design and
blocker report, not executed acceptance of the symbolic corpus. The parent owns
dependency review and integration. #706 remains open; use `Refs #706` in a future
draft. No production registration, persisted rule writes or provider calls belong
to this slice.

## Exact inspected sources

| Component | Source inspected | Integration state at inspection |
| --- | --- | --- |
| Canonical vocabulary and bounded local judge | main `670e2358004bcad81896189ecf8a14ee3b7eead3` | Integrated #716/#718 |
| Actual inactive strict policy | #717 `dd8957884b982d34a670719de9b0da0e259d3476` | Parent-reviewed head; merge owned by parent |
| Owned synthetic read fence | #719 `7252d22d85e83187fdb5fe036fd918b54e3f3b2f` | Parent reports source re-approval; exact-head CI pending |
| Symbolic matrix | #707, [corpus.v1.json](corpus.v1.json) | All 52 original cases retain `not-run` |

The repository AGENTS.md, development and architecture guidance were read.
No `.agents/skills` files were present in the checkout or `/workspace/.agents`.
Peer branches were fetched and inspected without merging or editing their files.

## Two seams need parent coordination

1. **A qualified synthetic capture.** The fence's `capture` deliberately emits
   `resources: unknown` and `rawDuplicateKeyValidation: unknown`; its supplied
   owner fixture advertises observation coverage, no negotiated hook and unknown
   protected configuration. The actual strict evaluator requires qualified coverage,
   the profile's facts, and complete resource evidence before an approved rule can
   match. Passing the actual policy into the existing fence therefore cannot prove
   automatic approval. This refusal is correct. A test must not upgrade a copied
   action, omit required profile facts, label a string path physically qualified,
   or replace policy evaluation with a programmed allow.

   A possible bounded repair is an explicit owner-registered in-memory capture
   capability, retaining the exact synthetic resource identity, revision and
   representation before any await. Its qualification must describe only the
   disposable memory executor, remain off by default, and leave string-path and
   installed-provider evidence unknown. The capture owner must distinguish
   inapplicable raw JSON validation from unknown raw JSON evidence. The parent
   should agree the concrete seam before either peer module changes.

2. **Completed delegated review at enforcement revalidation.** The fence's `run`
   stops at `needs-review`. `authorize` accepts only its retained final verdict,
   and authorization/dispatch revalidation calls `PolicyPortV1.evaluate` again and
   requires deep equality with that verdict. The actual strict policy returns a
   fresh pending review for a still-delegated rule; completing a review does not
   make subsequent evaluation return that completed decision. Consequently,
   calling the judge in an external test coordinator alone cannot make a completed
   review reach this fence. Manufacturing a final verdict, removing delegation,
   repeatedly judging to imitate revalidation, or substituting a cached allow
   would obscure the missing contract.

   A possible repair is an owner-local identity-bound review completion path plus
   current-state revalidation of that exact retained completion. It must retain
   original action/request/rule/config/model/projection identities, the original
   deadline, actual normalized result and record reference. Changed or unavailable
   current authority, policy, eligibility or binding must invalidate it. No public
   serialized approval or durable recovery semantics are needed. Any canonical
   contract change requires the contract owner; this harness must not declare a
   competing interface.

These are source-observed composition gaps, not demonstrated unsafe dispatches.
Actual test imports remain gated on integrated exact dependencies or a parent-
supplied reviewed integration contract. No draft claiming composed acceptance is
ready yet.

## Bounded harness after the seam is agreed

Reuse `syntheticReadFixture` for the existing in-memory execution/lease stores,
original owner/lifetime, exact retained codec and separate observation reader.
Supply `createStrictPolicyPort` with a mutable in-process current-state source,
projection authorizer and protected normalized-review recorder. Use
`createLocalReviewJudge` with its existing offline transport and bounded manifests;
only its transport/method are fakes. Do not introduce another policy evaluator.

Use explicit entered/release barriers for judge transport, review recording and
authorization recording. Count current policy reads, projection approvals, judge
calls, review records, authorization records, delivered fake responses, executor
entries and independent memory reads separately. A returned `completed` receipt
does not supply any of these observations. Deliver only through a separate fake
callback and record delivery only after its acknowledgement. Missing observations
remain unknown. Cleanup aborts every disposable original owner.

| Stable #707 IDs | Intended executable subset after repair | Still outside this slice |
| --- | --- | --- |
| `E706-disabled`, `E706-rule-revocation`, `E706-advisory` | Existing approved matching rule proceeds without a human prompt; disabled judge has zero calls; deterministic denial/revocation wins; advisory unavailable fallback follows the approved rule | Native response options, stored grant creation and installed cached approvals |
| `E706-required-timeout`, `E706-checker-outage`, `E706-malformed`, `E706-malformed-checker`, `E706-contradictory` | Required unavailable/timeout/malformed/oversized/contradictory local frames cannot dispatch; late responses cannot reopen the action | Network/provider cancellation or provider conformance |
| `E706-model-config-change`, `E706-policy-epoch`, `E706-authority-race`, `E706-policy-outage` | Change exact identities or availability while judge/review-record/authorization-record barriers are held; assert zero executor entries and independent effects; recovery cannot replay the terminal action | Actual model execution, daemon-backed revocation latency and production policy mutation |
| `E706-final-arguments`, `E706-final-cwd`, `E706-final-resources` | Changed exact capture, owner cwd or memory resource/revision cannot reuse the old permit | Stable physical handles, symlink/rename races and filesystem confinement |
| `E706-identical-concurrent`, `E706-duplicate-answer` | Simultaneous attempts on the same original invocation coalesce; one permit consumes once; distinct invocations require distinct authority | Shared persistent budgets and cross-process exactly-once guarantees |
| `E706-uncertain-record`, `E706-unknown-effect`, `E706-lost-delivery-ack`, `E706-cancel-after-dispatch` | Separate recorded decision, fake callback delivery, executor entry and independent effect; preserve unknown acknowledgements and refuse replay | Native callback delivery, physical effects and crash recovery |
| `E706-native-filesystem`, `E706-native-shell`, `E706-interactive-stdin`, `E706-descendant`, `E706-alternate-mcp`, `E706-client-filesystem`, `E706-client-terminal`, `E706-remote-custom` | Classification only: unexecuted and unsupported by this memory harness | Every listed physical/native/alternate route |

The mapping names intended subsets, not passes or execution of every original
variation. IDs were checked against the original corpus. All
other original cases remain unexecuted by this integration slice. Preserve the
preparation corpus as historical obligations and record future executed subsets
and exact test names in separate evidence.

## Local setup and baseline evidence

Node 24.19.0 and pinned pnpm 12.4.2:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 /workspace/.orca-tools/node_modules/.bin/pnpm install --frozen-lockfile
node_modules/.bin/vitest run packages/agents/test/review-judge.test.ts packages/agents/test/synthetic-read-boundary.test.ts --maxWorkers=2
```

Frozen setup passed, including the existing supply-chain policy check, without
manifest, lock or lifecycle-policy edits. The baseline run passed **2 files / 87
tests**, zero skips, on main `670e235`. These are the existing module tests only;
they do not execute the proposed composed cases. No new executable tests, full
suite, types, lint, build, physical/native smoke, live provider, installation,
signing, release, paid benchmark or crash-recovery acceptance is claimed here.
After implementation, run the composed tests plus actual dependency suites,
root/renderer types, repository lint and build on the exact integrated head.
