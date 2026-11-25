# Beta feedback triage

> **Superseded diagnostics wording, 27 October 2026**
> ([#786](https://github.com/cschadewitz/Project_Orca/issues/786)): mentions of a #416
> *preview* below predate the owner's 9 October Save/export-only decision. There is no
> in-app report viewer, and current source keeps production capture disabled
> (`DIAGNOSTICS_PRODUCTION_ENABLED = false`). Do not ask testers to preview, enable or
> export diagnostics. For Windows/Linux private candidates use
> [private-candidate-windows-linux](../private-candidate-windows-linux/README.md).
> The content below is otherwise unchanged.

For Casey or the agreed coordinator, after a tester voluntarily submits feedback.
Use [the report template](report-template.md); no report grants permission for
device access or additional collection. Severity below is a triage decision, not
a new repository label scheme or a release commitment.

## Intake and disposition

- [ ] Confirm the permitted recipient and sharing scope. Do not forward attachments
  or publish raw reports. If unexpected private material arrives, restrict further
  sharing and ask Casey to handle it through the agreed privacy process; do not
  copy it into an issue. Record only that material was omitted.
- [ ] Assign a random report alias. Keep identities/contact details outside repository
  artifacts. Record willingly supplied exact candidate and actual hardware/OS, or
  unknown/withheld. Never infer hardware from another participant's result.
- [ ] Separate intended outcome, observed behavior, checklist stage, actual attempts,
  hints received and whether an agent helped. Missing evidence stays unknown.
- [ ] Classify by the rubric below. A suspected security/data-loss problem does not
  need reproduction before escalation. Ask only for the minimum missing safe fact;
  declining it leaves the report incomplete, not invalid.
- [ ] Search open and relevant closed issues/PRs before filing. Reuse existing work
  under [CONTRIBUTING](../../../CONTRIBUTING.md); preserve metadata. Public issues
  contain only a reviewed synthetic reproduction or content-free summary. Private
  security details stay with Casey through the agreed private contact.
- [ ] Record category, severity, evidence limit, related issue, named owner, next
  action and next review point. If no owner is assigned, Casey owns routing; do not
  leave an unowned “needs investigation.” No response-time promise is implied.
- [ ] Close only with a reason: duplicate link, guidance correction, separately
  verified fix with exact candidate, or explicitly deferred idea. Preserve original
  failures and mark verification not tested if the tester declines a retest.

## Rubric

| Category / severity | Minimum safe evidence | Owner and next step |
| --- | --- | --- |
| Launch blocker / B0 | Candidate if known, S1-S3 stage and a paraphrase of inability to install/open/connect. No repeated risky launch required. | Casey routes to delivery/onboarding owner; block affected journey and wider cohort sign-off pending disposition and candidate verification. |
| Suspected security or data-loss blocker / B0 | Stage, safe impact description, candidate if known; occurrence once is enough. No secret, file contents or raw diagnostics required. | Escalate privately to Casey immediately; stop affected work. No retry, store repair, restart or update under feedback consent. Resolve blockers before expanding the cohort. |
| Reproducible product bug / B1 | Expected vs observed, safe steps, candidate, actual attempt count and safe code if available. Unknown fields remain explicit. | Relevant product owner reproduces with synthetic data in an authorized environment and links a fix/verification step. Nonreproducible failures remain investigation candidates; no forced tester reproduction. |
| Confusing guidance / B2 | Step, misunderstanding in the tester's words, and type of hint needed; no transcript. | #389 guide owner corrects guidance and asks for a later optional unassisted check. A UI defect goes to the product owner too. Promote to B0 if confusion prevents safe launch or approval. |
| Feature request / B3 | Desired outcome and why existing behavior does not meet it; no personal task content. | Casey/product owner compares existing plans, records an explicit defer/accept decision and a bounded next step. Do not promise a release. |
| Success / observation | Intent, S1-S8 states, result comparison, evidence limits and any help received. | Coordinator records qualitative learning. Required untested steps remain open; no issue needed unless a gap is found. |

“Run succeeded but intent was wrong” is **not** a success disposition. Check whether
the agreed requirement was violated (product bug), misunderstood (guidance), or
unsupported (feature request). Until known, keep it under investigation with an
owner; do not blame the tester or silently count it as successful. Possible damage
still takes B0 precedence over a green run status.

## Evidence and cohort boundaries

The only diagnostic path is
[#416 manual preview/export](https://github.com/cschadewitz/Project_Orca/issues/416)
after candidate validation, with separate voluntary sharing. Do not request raw
logs, private execution stores, screenshots, prompts, code/diffs, paths, credentials,
agent output or workplace data. Do not attach a bundle to an issue by default.
If diagnostics are declined/unavailable, work from the safe text report. #416's
proposed retention budgets are not an approved feedback-retention policy; agree
access, retention and deletion with the coordinator before collecting real reports.

The planned **two Mac and two Windows participants** are a small qualitative cohort.
Report individual stages and observations, not success-rate statistics, population
claims or platform certification. Even without names, OS/model combinations may
identify a participant. Keep actual volunteered hardware/OS in the agreed restricted
record; publish only reviewed nonidentifying summaries. Withheld values stay withheld.
Record supported versus actually tested combinations separately. No physical checks
or real-user walkthroughs have been performed by this preparation.

[#390](https://github.com/cschadewitz/Project_Orca/issues/390) retains physical and
unassisted acceptance. #416 is a hard pre-beta gate; later uploads and remote
requests (#417/#418) are not prerequisites for this feedback process.
