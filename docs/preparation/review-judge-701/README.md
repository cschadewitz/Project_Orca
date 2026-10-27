# ReviewJudge offline preparation (#701)

Status: **offline preparation archive; inactive source adapter now follows the accepted contract**.
The historical proposal and feedback below describe the pre-review preparation.
[Source implementation and validation](source-implementation.md) records the scoped
follow-up using merged #708/#712 and the reviewed canonical type dependency #716.
[Injected-endpoint transport](endpoint-transport.md) records a separate inactive
transport seam with a fake provider; it is not a hosted/BYOK implementation.
[Connection preparation](connection-preparation.md) records the inactive seam between that
adapter and proposed disclosure-grant/credential-reference contracts, with fake services only.
This directory is standalone preparation for [#701](https://github.com/cschadewitz/Project_Orca/issues/701),
coordinated under [#699](https://github.com/cschadewitz/Project_Orca/issues/699).
It does not complete either issue or define a parallel canonical action schema.
Source inspection baseline: main `32f92cc16b9faf1748059e930c3f77b3934151ae`.
The proposed #700 interface at [draft #708](https://github.com/cschadewitz/Project_Orca/pull/708),
commit `e08bc96ab3250718c93f77057b5560e7b6421dcd`, has now been inspected.
It is **not frozen or accepted**. [Compatibility feedback](contract-708-feedback.md)
records the required mapping and review questions; this draft imports none of its code.

Run the preparation suite with Node >=24, from the repository root:

```sh
node --test docs/preparation/review-judge-701/offline.test.mjs
```

No install, dependency changes, workspace build, provider, keys or network are needed.
The root Vitest configuration does **not** discover this suite. Run it explicitly;
ordinary CI success alone is not proof that these preparation checks ran.

## Existing seams and interface finding

- [Research architecture](../../research/tool-call-safety/architecture.md) proposes
  the optional isolated reviewer port and its deterministic coordinator. It is research,
  not an implemented `ReviewJudge` API or universal enforcement capability.
- [ACP session](../../../packages/agents/src/acp-session.ts) creates a
  `PermissionInvocation` containing session/turn/invocation identity and cancellation.
  It evaluates permissions at `session/request_permission`; that does not establish
  every actual tool dispatch, subprocess or alternate route was intercepted.
- [Permission resolver](../../../packages/agents/src/permissions.ts) already selects
  native choices when a policy rule allows a request. The preparation retains the
  approved automatic response requirement; an eligible existing rule does not require
  an extra human confirmation merely because a judge is configured.
- [Live input owner](../../../packages/engine/src/live-input.ts) keeps original
  callbacks owner-local and rechecks live-answer authority. A stored recommendation
  must never restore a callback or become a one-use permit.
- [#700](https://github.com/cschadewitz/Project_Orca/issues/700) owns immutable action
  evidence, coverage, deterministic outcomes and permit/enforcement contracts. None
  is imported, redefined or exported to core, engine, agents or protocol here.
  `baseline` values in test vectors are symbolic prerequisites supplied by a test,
  not a trusted authority claim that runtime callers may submit.

## Deliverables

- [Port and integration proposal](port-proposal.md): versioning, methodology/transport
  separation, evidence/disclosure controls and explicit future hosted/BYOK limits.
- [Offline experiment](offline.mjs): pure reference method, deterministic fake method,
  injectable offline transport, bounded runner, minimal synthetic projection and
  symbolic composition harness. All exports remain local to this directory.
- [Test vectors](vectors.json) and [contract tests](offline.test.mjs): automatic rule
  response, abstention, escalation, denial, unavailable/malformed/timeout/cancelled
  outcomes, ceilings and no fallback broadening.
- [Validation evidence](validation.md): exact checks and their limits.
- [#708 compatibility feedback](contract-708-feedback.md): differences in delegated
  judgment eligibility, result vocabulary, projection delivery and failure attribution.

The sole implemented destination is `offline:fixture`. Small models, JEV, ensembles,
isolated workers, hosted services and BYOK remain adapter design options. No provider
implementation, connection, secret resolution, activation or production policy is added.
The in-process fixture runs trusted test code and is not a sandbox for hostile plugins.

## Next owner handoff

The parent coordinating #700 must supply the reviewed interface and fixtures for:

1. Immutable action/evidence identity and the approved projection capability, including
   complete/absent/unknown fields and which boundary can attest enforcement coverage.
2. Verified current authority, mandatory denial/human classes, approved rule/delegation
   match, revocation/state generations and allowed native response scope.
3. Cancellation/deadline and exact live-owner lifetime, including post-review revalidation,
   audit durability, permit issue/consume ownership and missing-hook failure.
4. Version negotiation and error/outcome mapping, with explicit unsupported migration.

Until then, stop at this preparation. Do not wire synthetic enums into production or
create an action schema on a peer branch. After review, replace symbolic prerequisites
with imports/mappings to the agreed #700 interface and retain these semantic vectors.
Production registration, default profiles, remote egress and native execution acceptance
need separate reviewed implementation and authorization.

This work preserves the current unsupported [#594](https://github.com/cschadewitz/Project_Orca/issues/594)
exact-command/C6b acceptance state and live/sandbox/privacy gates. It runs no native
agent, live model, JEV, hosted service, paid evaluation, release or deployment.
