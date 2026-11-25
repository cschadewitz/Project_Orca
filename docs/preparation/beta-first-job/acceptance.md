# First coding success acceptance

Preparation for [#420](https://github.com/cschadewitz/Project_Orca/issues/420), a bounded
slice of #386 consumed by #389's guide and #390's consented walkthrough. Exact audited
main baseline: `e94bf699d9f3000de8822ed3434c1dce92b6ce19` (2026-10-03).
The initial origin/main fetch and Kepler sync matched that SHA; no rebase was needed.
A later non-force branch merge incorporates reviewed main
`3e895c7ea60f367ef1199a1044613dbd0ebc9d6e` (#433's artifact-shortcut fix);
the fixture implementation and recorded offline source hashes are unchanged.
Owned paths are only `examples/beta-first-job/` and `docs/preparation/beta-first-job/`.
No runtime, app, adapter, permission, manifest, CI or release behavior changes here.

## Reuse and incremental scope

Build on completed #402/#403 preparation on this baseline:

- [Candidate artifact contract](../../archive/preparation/native-mac-delivery/artifact-contract.md): candidate
  identity, trusted download, signature/notary/staple and architecture verification.
- [Fixture contracts](../../archive/preparation/native-mac-testing/fixture-contracts.md): disposable
  `Sample α`, independent `Other β` sentinel, exact output and current-run provenance.
- [Harness design](../../archive/preparation/native-mac-testing/harness-design.md): isolated account/profile,
  owned processes and production bootstrap, evidence limits and cleanup.
- [Manual checklist](../../archive/preparation/native-mac-testing/manual-checklist.md) and
  [evidence template](../../archive/preparation/native-mac-testing/evidence-template.md): retain their
  install/lifecycle/authentication/physical-hardware tests and identity fields.

This adds `beta-first-job-v1`, a coding-bug scenario alongside the proposed
`mac-safe-v1` report fixture. It does not replace that fixture, its permission/gate
variants, the general MAC matrix or the portable artifact validator. The existing
`packages/testing` scripted ACP playbook writes deliverables; it is not a packaged
coding-fix route. This issue does not extend it. Offline patch application proves only
that this coding task and its oracle are repeatable.

## Tester task prompt

After preflight and explicit real-agent authorization, paste only this prompt into
the approved request entry point with `Sample α` selected:

> Fix the shipping-fee bug in this disposable repository. Shipping costs 499 cents
> below a subtotal of 5000 cents, and is free at 5000 cents or more. Inputs are
> nonnegative integer cents. Run `node shipping.test.js` before and after the
> smallest change to `shipping.js`; leave the tests and README unchanged. Report
> the diff, both test outputs and exit codes, and whether the work completed.
> Work only here. Do not install, use network tools, change permissions, commit,
> push or open a PR. Stop if the selected workspace or runtime is wrong.

“No network tools” forbids agent tool network operations; the separately authorized
provider inference connection may still transmit the synthetic prompt/code and incur
cost. Local checks require neither that connection nor a provider account.

## Checklist and result rules

Record **pass**, **fail**, **blocked** or **not run** per row, using #403's evidence
record with this fixture revision. Missing prerequisites are blocked; attempted
checks that miss an oracle are fail. A source check cannot pass a packaged-app row.

| ID | Action | Required evidence / stop condition |
| --- | --- | --- |
| BF-01 offline | Coordinator runs the two commands in the [fixture README](../../../examples/beta-first-job/README.md). | Initial exit 1 with exactly the threshold failure; reference patch exit 0 with five passes; two identical baselines/diffs and unchanged sentinel. A mismatch stops the session. |
| BF-02 install | Follow #402 delivery and #403 MAC-01/02/03 using the approved candidate and guide. | Exact build/source/artifact identities and verified normal installation. Missing enrollment/publisher evidence or signed delivery blocks this row. No unsigned fallback or terminal security bypass. |
| BF-03 workspace/connect | Coordinator initializes a fresh copy. Through #386's supported first-run flow select that exact `Sample α`, verify connected app-owned daemon/store and selected agent. | Actual canonical workspace, profile/store containment and runtime identity under #403's contract. Do not use an override, developer checkout daemon or unsupported API to simulate onboarding. Wrong workspace, unavailable route or unknown store path: stop before launch. |
| BF-04 inputs/permissions | Review the prompt, all injected workflow inputs, workspace, available runtime, effective permissions and agent/tool/adapter/model. | No personal code, patch leakage, automatic permission grants or unnecessary broad write access. Node/Git already provisioned for their respective roles; missing tool stops, no install. Real-agent preflight below must pass. |
| BF-05 launch | Launch once through the accepted #334/#386 product route. | Record actual request/run ID and selected workflow/version/agent from production observations. Admission alone is not success. Unavailable supported route is blocked; do not invent a launcher or RPC. |
| BF-06 inspect | Inspect the minimal diff, test evidence and terminal status for this run; coordinator runs `verify` on its root. | Exactly the reference one-character change, unchanged tests/README/sentinel, test exit 0 with five passes and a successful terminal run with no pending input. Explanation-only, stale artifacts, altered tests, unrelated files or a still-running/waiting run fail. |
| BF-07 cancel/retry | On a separate fresh attempt, cancel using the supported UI; wait for confirmed cancellation and owned execution to stop. Inspect any partial edits before retry. | Cancellation is not success and need not revert files. Preserve original run ID/output, create a new copy with `reset`, re-select it and launch a new run; old outputs cannot satisfy BF-06. If completion wins the race, record it and repeat the cancel case; do not call it a cancellation pass. |
| BF-08 wrong workspace | Before launch, deliberately select the separate `Other β` sentinel workspace; review and correct the selection. | Do not submit a coding task there. Confirm selected target before launch and sentinel hash afterward. A mismatch stops; preserve evidence rather than repair the wrong workspace silently. This checks operator prevention, not a promise of automatic product rejection. |
| BF-09 finish | Quit normally, retain reviewed evidence and remove only approved disposable state after owned processes stop. | Use #403 cleanup and evidence limits; no personal folders or unrelated processes touched. |

Current protocol definitions in `packages/protocol/src/control.ts` expose `runs.cancel`
and `runs.resume`; cancellation/resumption remain execution controls, not a promised
“reset fixture” API. Check candidate capabilities and the actual supported UI. Do not
resume a cancelled run as a retry or break leases/claims to force progress. If cancellation
cannot be confirmed, stop and report; do not start a competing attempt in that workspace.

## Required real-agent preflight

The coordinator records explicit tester authorization for this one run **before**
connecting/launching the real agent: approval reference, synthetic workspace and allowed
operations, provider/tool/adapter/model versions, existing sign-in readiness, possible
code/prompt transmission, who pays, an agreed monetary limit and time limit, and how the
operator will stop. Use the provider's supported hard limit if available; otherwise
explain that a manually monitored time limit is not a guaranteed monetary cap and obtain
agreement before proceeding. Missing approval, credentials, tool availability or an
acceptable spending plan blocks the run. Never record credential values or auto-sign in.

Inspect the effective policy; a gate is not an agent permission request. Deny an
unexpected request; do not choose “always”, alter standing rules or grant broad access
for convenience. Requesting network tools, installs, unrelated reads/writes or publication
is a stop condition. Preserve a failed/cancelled attempt even if the later retry succeeds.
No live provider, tester-machine install, release or deployment is authorized by this
fixture implementation.

## Artifact and handoff contract

For each attempt retain the measured diff, original and final test commands/output/exit
codes, file digests, unchanged sentinel digest and the final run state. In a real ORCA
run also capture run/step IDs and artifact ID/kind/name/bytes/digest through supported
production interfaces, bound to that attempt. Store reports outside the agent's three
working files in the accepted isolated artifact store/evidence directory; use the actual
attempt paths, never a made-up artifact API or stale local report. If the chosen workflow
cannot produce that evidence within these constraints, BF-05/06 are blocked pending
#334/#386/#388 integration. The offline `validation.json` is coordinator evidence, not
an ORCA artifact or proof of terminal run state.

Append fixture-specific rows BF-01–09 to #403's evidence template; retain its candidate,
OS/architecture, authorization and sanitized evidence inventory rather than creating a
second candidate manifest. The normal form for test output is the exact text in the
fixture README. Reject extra code/test changes, dependencies, secrets, remote URLs,
permission edits, commits or external PRs made by the sample agent.

End-to-end beta proof waits for #385/#386/#334 and the explicitly consented #390
candidate. #389 can consume this prompt and expected output now. These existing issues
already own the integration gaps; no duplicate issue is needed. Mac current-OS M3–M5
physical tests remain separate from hosted/source validation. Windows needs its own
recorded results. Neither platform is certified by this preparation, and parent
acceptance remains open.

Invited-beta sign-off also requires accepted #416 previewable manual diagnostics,
consumed by #386/#389/#390. This does not block offline fixture preparation. Keep
synthetic code, diffs and test output in the separate fixture evidence record; #416's
diagnostic export excludes those contents and still requires its own consent and preview.
