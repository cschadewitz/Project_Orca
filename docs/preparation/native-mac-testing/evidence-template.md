# Packaged Mac evidence record template

Template only. Copy into the approved private evidence destination at execution time;
do not commit filled user/machine records here. Preparation source:
`7abc2342aa672ee9d2f10d565ca4f8eb546184df`, 2026-10-02. No execution is claimed.

9 October reconciliation: use the [current runbook](../native-mac-beta-readiness/acceptance-runbook.md)
and #416's stricter allowlist. Filled packets/command selections remain private;
no raw tool output, log tails, screenshots, prompts/code/agent output, full paths,
credentials or protected stores enter retained/shared evidence. Earlier proposed
screenshot/log budgets are superseded below. A harmless marker-only launch is not
report-artifact, gate, real-agent or crash-recovery evidence.

## Identity and authorization

| Field | Value to fill |
| --- | --- |
| Evidence/run ID, UTC start/end | `<required>` |
| Executor and mode | `<hosted arm64 VM / controlled Mac / physical M-series>` |
| Tester alias and session approval reference | `<no personal contact details or credentials>` |
| Scope approved | `<installation, disposable state, sleep/restart and real agent separately; no implicit device access or sharing>` |
| Candidate ID, version, source commit | `<exact full SHA, not branch name>` |
| Harness source commit, fixture revision | `<full SHA; mac-safe-v1 or agreed replacement>` |
| Build run URL/ID/attempt | `<credential-free immutable provenance>` |
| Download channel/asset ID/time | `<no bearer URLs, query strings, cookies or headers>` |
| Artifact filename, format, size and expected/actual SHA-256 | `<each tested DMG/ZIP separately>` |
| App bundle ID/version, expected/actual team ID | `<include verification exit codes>` |
| Notary record/status, app/DMG staple result | `<nonsecret IDs and sanitized validation output>` |
| Bundled daemon expected/actual digest/version | `<relative bundle path and digest>` |
| OS version/build, model/chip | `<no serial number, hardware UUID or account name>` |
| Host/app/daemon architecture; translation check | `<observed values and observation method, never runner label alone>` |
| Runner image/label and GUI availability | `<or physical hardware; unknown if unavailable>` |
| Minimum supported OS decision and tested combination | `<unsupported/untested combinations explicit>` |
| Real-agent tool/adapter/version and approval | `<none for harmless sample; no account identifier/token>` |
| Guide revision and participant/coaching notes | `<sanitized; physical usability only>` |

## Isolation and runtime proof

Record root/profile/workspace as aliases such as `<run-root>` and `<workspace-A>`.
Include actual observed path-containment results, fresh/reused profile, disposable OS
account/VM boundary, environment allowlist, production renderer/bundle paths, effective
launch security flags and forbidden override absence. Record app-owned daemon PID and
parentage, loopback-only binding, hello process identity, app/daemon version equality,
exact protocol, required capabilities/methods, store alias and subscription convergence.
Record successful auth and missing/wrong-token refusal as codes only.

Do not include token-file contents, raw authorization headers/WS protocols, encrypted
stores, protected private keys, cookies, provider transcripts, full process environments,
personal files or whole home/Library directories. A generated credential is still a secret.

## Steps and results

Allowed statuses: **not run**, **blocked**, **pass**, **fail**. Use blocked for a missing
prerequisite and name it; use fail for an attempted check that misses its oracle.
No skip, timeout, unsigned fallback, simulator or source-only proof counts as a pass.

| Matrix ID / fixture variant / format | Action and expected oracle | Actual observation | Status | Evidence IDs / blocker |
| --- | --- | --- | --- | --- |
| MAC-01 | `<exact commands and expected identity>` | `<not observed>` | not run | `<fill>` |
| MAC-02 through MAC-16 | `<expand into one row per scenario/variant>` | `<not observed>` | not run | `<fill>` |

For the report: record run/step/artifact IDs, kind/name, expected/actual content digest,
byte count, provenance, terminal status and unchanged isolation sentinel. For gates:
record pending input ID before/after reopen and answer count. For lifecycle: distinguish
window close, Quit, relaunch, disconnect, sleep and OS restart. Log command exit codes
and timeouts with safe arguments; include the first failed attempt even after a rerun.
Link #387's upgrade/restore scenario evidence rather than copying its recovery procedure.

## Evidence inventory and failures

| Evidence ID | Relative file / digest / bytes | Scenario and purpose | Redaction/truncation review |
| --- | --- | --- | --- |
| `<id>` | `<allowlisted status/enum assertion JSON, digest and bytes>` | `<MAC-ID>` | `<reviewer alias; omissions and limits>` |

Retain at most 256 KiB of allowlisted assertion JSON per case. Optional native-validated
#416 manual diagnostic export has its own consent, immutable preview and complete-report
1 MiB cap; it does not upload. No raw trace/HAR/video/log tail/screenshot is retained or
shared. Exceeding a bound is a failed evidence outcome, never silently truncated success.
Record safe privacy/canary-check outcomes without secret values; unsafe evidence is omitted.

| Failure/decision | Reproduction using fixtures only | Severity / owner / existing issue | Acceptance impact and next action |
| --- | --- | --- | --- |
| `<observed or unresolved>` | `<minimal sanitized steps>` | `<launch/security/data loss/usability; issue link>` | `<blocks which rows; no invented pass>` |

Record expected versus actual outcomes, useful app messages and support/feedback route.
Use existing #385/#386/#387/#388/#389/#390 work where applicable; inventory before filing
a separate issue. Do not record a missing prerequisite as an executed product failure.

## Cleanup and disposition

- Ordinary Quit result, owned daemon exit and any forced cleanup/timeout: `<fill>`.
- Owned mount detached, fixture permissions restored, marker/path/PID checks: `<fill>`.
- Disposable paths removed or safely retained for operator cleanup: `<aliases only>`.
- Other workspace sentinel unchanged; no personal state touched: `<evidence, not assumption>`.
- Restricted evidence destination, reviewer, retention expiry (proposed 14 days): `<fill>`.
- Automated scope accepted: `<rows actually passed or none>`.
- Physical scope accepted: `<rows actually passed or none; never inferred from CI>`.
- Unresolved failures, untested OS/chip combinations, remaining approvals: `<fill>`.
- #388/#390 disposition and named reviewer: `<open / blocked / accepted with linked evidence>`.

This template and a completed #403 handoff do not close #388 or #390.
