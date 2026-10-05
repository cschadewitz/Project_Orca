# SwiftUI read-only iPhone pilot preparation

Preparation contract v1 for [#471](https://github.com/cschadewitz/Project_Orca/issues/471).
SwiftUI and Apple first are selected; Android is later, without a schedule.
This handoff freezes a small synthetic read contract for review. It does not add an
app, routes, enrollment, authorization behavior, APNs, signing or deployment.

Read [screens](screens.md), [contract](contract.md), [device acceptance](devices.md)
and [spike/handoff](handoff.md) in that order. The [JSON schema](schema-v1.json),
[fixtures](fixtures/README.md) and offline validator are portable preparation
artifacts, outside the runtime and package graph.

## Evidence and decisions

- Source inspected: main `b9b8807252e39c506c24b17ec0c637701e4a68d1`, protocol 2.0.
  Publication refresh compared main through `49efcc7236ac127c952bb1f7a50fc6ef72f7df84`:
  the new root-worktree isolation changes do not alter these read schemas. No
  exact-new-main runtime acceptance is claimed.
- Reviewed companion [#461 at aa0884b](https://github.com/cschadewitz/Project_Orca/tree/aa0884b228dc8c44772e2d0ea8f8e1e5fa480281/docs/preparation/ios-companion)
  and Watch [#459 at d3dd447](https://github.com/cschadewitz/Project_Orca/blob/d3dd447033d0510c1bbe4f7907b875e5a69db972/docs/preparation/apple-watch-approvals/README.md).
  These are reviewed drafts, not merged specifications. Links are pinned because
  their files are not in this checkout.
- [Owner platform decision](https://github.com/cschadewitz/Project_Orca/pull/461#issuecomment-5976265449):
  SwiftUI, Apple only initially; share backend contracts with future Android.
- Inventory refreshed 2026-10-04: [milestone 24](https://github.com/cschadewitz/Project_Orca/milestone/24)
  is the existing undated `iOS read-only pilot`, primary group
  `ship-group:ios-readonly-pilot`. No issue or milestone is created by this handoff.
- [#415](https://github.com/cschadewitz/Project_Orca/pull/415) merged operator
  composition; [#448](https://github.com/cschadewitz/Project_Orca/pull/448) merged
  continuation repair. The older #459 text still calls #443 unresolved; use the
  corrected #461 review and current source. Continuation writes remain out of scope.

The outcome is an implementable fixture-first phone pilot: inspect authorized run
facts, pending approval summaries and bounded evidence; understand what is current
or last observed; return to the desktop for every action. Server-side mutation
denial is a release prerequisite, not a conclusion of these fixtures. Completion
percentage, ETA and agent cost are unavailable and must not appear as placeholders.

## Verification boundary

Run `python3 docs/preparation/swiftui-readonly-pilot/validate.py` with the isolated
[requirements](requirements.txt). It checks schema examples, negative decoder
cases, fixture references, source vocabulary and bounds. Scenario expectations
are specifications for future client/server tests, not an implemented state
machine or proof of authorization. No runtime suite, Swift build, simulator,
physical device, private connection or notification delivery was exercised here.

Only documentation and synthetic fixtures change. The shared design tokens and
rendered design artifact are unchanged. The native design adaptation, actual
hardware support and connected release acceptance remain explicit follow-up gates.
