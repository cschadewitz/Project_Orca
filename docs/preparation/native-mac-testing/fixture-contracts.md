# Synthetic fixture and candidate contracts

Proposed interfaces for #388, not shipped schemas. Baseline/date:
[test matrix](test-matrix.md). All examples contain invented data; placeholders must
be resolved and validated before execution. No fixture contains a real project,
provider account, signing key or persistent access token.

## Candidate input from delivery

The consumer targets the proposed v1 contract from
[#405](https://github.com/cschadewitz/Project_Orca/pull/405), read on 2026-10-02 at
`6de26739aea2a376a394c39448916f666f309da7`, for
[#402](https://github.com/cschadewitz/Project_Orca/issues/402)/#385. Its
[pinned artifact contract](https://github.com/cschadewitz/Project_Orca/blob/6de26739aea2a376a394c39448916f666f309da7/docs/preparation/native-mac-delivery/artifact-contract.md)
is pending review and absent from audited main. No peer branch was imported.
Use that schema rather than creating a competing test manifest. Required inputs:

| Input | Consumer requirement |
| --- | --- |
| `native-mac-artifact.json` | `schemaVersion: 1`, `kind: candidate`; required `identity`, `identitySha256`, `artifacts`, `minimumMacOS`, `signing`, `notarization`, `stapling`, `evidence` |
| `identity` | Exact object from signed `Contents/Resources/orca-build.json`: release/app/plist versions, bundle ID, `platform`, `arch`, full source SHA, `buildId`, `builtAt`, daemon path/hash/version, protocol, store epoch and exact toolchain versions |
| `artifacts` | Exactly one DMG and one ZIP: `ORCA-V-mac-arm64.dmg` and `ORCA-V-mac-arm64.zip`, each with format, safe relative path, final SHA-256 and positive byte size |
| `SHA256SUMS` | Sorted digest list covering both containers, manifest and referenced evidence, delivered through trusted access; trusted promotion record retains manifest digest |
| `signing` | Expected team/certificate/authority, hardened runtime true, verification passed and referenced nested-code report; compare actual signature, not declarations alone |
| `notarization` / `stapling` | Accepted app/DMG submissions, submitted digests and logs; passed tickets on app-in-DMG, app-in-ZIP and DMG. ZIP container has no staple |
| `evidence/*` | All referenced records have verified digests/sizes and safe paths; no credentials or private build paths |

Select by `identity.buildId` + `identity.sourceCommit` + artifact format +
`identity.arch`. Require `darwin`/`arm64`, compare both formats' sealed identity bytes
with `identitySha256` (never reserialize to compute it), and compare that parsed object
with external `identity`. Compare the actual bundled daemon with `identity.daemon`.
Compare `minimumMacOS` with the app plist and execution host. Missing fields, duplicate
JSON keys/paths, unknown schemas, placeholders, x64-only payloads, unresolved publisher
expectations and traversal/symlink escapes fail validation before launch.

Protocol 1.9 is the audited baseline, not a permanent pin: use `identity.protocol` for
candidate equality and separately check client compatibility. Compare runtime app
version and hello `orcaVersion` with `identity.releaseVersion`; compare plist strings
verbatim with their identity fields. Current hello has no source SHA: verified sealed
identity, daemon bytes and process/resource association establish source linkage.
`storeEpoch` identifies compatibility, never permission to roll back data.

Capabilities are a test-side expectation, not extra delivery-manifest fields. For the
sample require `runs.read`, `runs.subscribe`, `runs.control`; require methods
`runs.start`, `runs.get`, `inputs.list`, `inputs.answer`, `artifacts.list`, `artifacts.get`
and add those needed by cancel/reconnect assertions from the accepted protocol schema.
Require hello `processId` for owned-process proof even though the current schema makes
it optional. No test may invent the identity API from pending #397.

Delivery's `kind: fixture` distinguishes parser fixtures from real candidates. This
intentionally incomplete negative fixture parses as JSON but must fail candidate mode:

```json
{
  "schemaVersion": 1,
  "kind": "fixture",
  "identity": null,
  "identitySha256": null,
  "artifacts": [],
  "minimumMacOS": null,
  "signing": null,
  "notarization": null,
  "stapling": null,
  "evidence": []
}
```

Build complete synthetic parser fixtures during implementation, with `kind: fixture`;
never promote them or treat synthetic signature/notary fields as verification. Negative
cases: missing format, x64 masquerading as arm64, wrong team/version/protocol, modified
sealed identity or daemon, digest/size mismatch, pre-stapling digest substituted for a
final digest, absent ZIP app ticket, rejected/timed-out notarization, missing report,
unsafe path, unknown schema, duplicate JSON key and revoked download access. Submission
hashes and final stapled-container hashes describe different bytes; test both stages
without requiring them to be equal. Checksums alone do not authenticate a publisher.

## Safe sample input/output

Fixture family `mac-safe-v1` is a proposal for #386's shipped, credential-free sample.
The selected app must carry everything it needs to execute it. Do not call the current
checkout-based `orca demo`, invoke `tsx`, use a globally installed Node/agent or install
test executables into the signed bundle. #386 must agree on sample availability, launch
selection and resource paths; their absence blocks MAC-06 rather than authorizing an
external replacement daemon.

Input file `input/message.txt` is UTF-8, LF, exactly:

```text
Hello from the ORCA Mac acceptance fixture.
```

It has one final newline. Proposed collected artifact name is `sample-report`, kind
`report`, logical output `output/sample-report.md`, also UTF-8/LF with final newline:

```markdown
---
fixture: mac-safe-v1
result: success
---
Hello from the ORCA Mac acceptance fixture.
```

Compare these exact bytes and SHA-256 computed from the agreed fixture bytes; no
timestamps or machine paths in the artifact body. Record generated artifact ID, run ID,
producing node/step, kind/name, byte count and content digest using the actual artifact
API. The engine may insert its `.orca-attempts/<runId>/<stepRunId>/` output path; the
logical path above does not override attempt isolation. Assert output/store containment
and current-run provenance, so a stale file cannot satisfy a rerun. Exact metadata field
mapping is to be frozen against the accepted #386 sample and protocol, not invented here.

Expected semantic progression: run starts, sample executes, artifact is recorded,
run succeeds. Random run/step IDs and timestamps vary; content and outcome do not.
Only fixture input, output and declared runtime state may change; `Other β/sentinel.txt`
contains `Do not change this workspace.\n` and its hash must remain unchanged.

## Gate, permission and failure fixtures

The following gate uses the current schema demonstrated in
`packages/app/test/smoke/daemon.ts`. It is a documentation example to validate again
at implementation time. Installation/launch through #386's supported workflow route
is still unresolved; writing a YAML file is not proof the packaged UI can start it.

```yaml
id: mac-acceptance-gate
name: Mac acceptance gate
version: "1"
start: start
nodes:
  start: { type: start }
  confirm:
    type: gate
    question: Finish this disposable sample?
    options:
      - { id: finish, label: Finish sample, consequence: Only this test run completes. }
      - { id: stop, label: Stop sample, consequence: This test run ends without success. }
  done: { type: end, outcome: success }
  stopped: { type: end, outcome: failure, message: Sample stopped by tester. }
edges:
  - { from: start, to: confirm }
  - { from: confirm, to: done, when: "choice == 'finish'" }
  - { from: confirm, to: stopped }
```

Expected gate output: one pending input, waiting run, no auto-answer; Quit/reopen
preserves the same input; selecting `finish` records one answer and success; selecting
`stop` records failure. A separate cancellation while waiting ends `cancelled`, without
crediting success or producing the report. A deliberately failing workflow is simply
start → end with `outcome: failure` and message `Synthetic failure for Mac acceptance.`

| Fixture | Synthetic setup | Required result |
| --- | --- | --- |
| Permission ask | Shipped scripted agent requests an explicitly ask-governed operation on `<run-root>/scratch/permission-target.txt`; initial text `unchanged\n` | Deny leaves bytes unchanged and grants nothing; allow-once writes `allowed once\n`; second identical ask still requires a decision, no standing rule added |
| Missing tool | Dedicated agent config selects nonexistent executable under scratch | Preflight names missing tool and recovery; no install or paid call |
| Tool/version/sign-in failure | #386-reviewed synthetic preflight responder, outside the signed app | Actionable classified errors; proves preflight handling only, not a real provider sign-in |
| Denied workspace | Remove write permission from owned workspace child while idle | No writes outside target; error/retry works after restoring owned permissions |
| Auth denial | Absent token, then random invalid token in independent HTTP/WS probes | Refusal, no data; valid production bootstrap still works; no credential in evidence |
| Isolation/retry | Fresh profile, then same profile; select `Sample α` and `Other β`, cancel/back/retry | Workspace/store identity follows confirmed choice only; old results cannot count for new run |
| Diagnostic canary | Known synthetic marker `ORCA_TEST_REDACTION_CANARY_DO_NOT_UPLOAD` sent through a sensitive-field test | Raw value absent from retained evidence; omission/redaction noted |

Gate choice and agent permission are distinct flows. A gate alone cannot satisfy
permission testing. Permission and preflight responders are proposed fixtures for
#386/#388 review, not existing shipped agent features. Use an explicit ask rule because
ORCA's workspace defaults may allow an operation; never weaken production defaults.

## Reconciliation register

| Decision/gap | Owner and next action | Execution affected |
| --- | --- | --- |
| #405 v1 proposal now reviewed as input, not yet shipped; signing disabled on main | #402/#385 freeze D1/D4/D5/D6; consumer adopts sealed identity and manifest, confirm publisher/access/support policy | MAC-01/02, all final candidate execution |
| No agreed writable first-run/sample contract | #386 freeze sample bytes/resources, workspace chooser and launch route | MAC-03/06/07/08 |
| Profile/endpoint discovery and effective path isolation | #386/#388 agree production bootstrap observations and test-account setup | MAC-02/04/05/09/10 |
| Pending #397 may change identity/admission/workspace APIs | #388 re-audit merged production code, record exact candidate commit | MAC-03/04/09/10/16 |
| Signed fuses/entitlements may prevent Playwright control | #385/#388 prove unchanged candidate automation or controlled native executor | All automated launch cases |
| Standalone desktop CI hello lacks current token bootstrap | #385/#388 reconcile existing probe with current auth; no legacy-mode workaround | Packaging prerequisite, MAC-04/05 |
| Supported OS/chip matrix, budgets, evidence retention | #385/#390 confirm support floor; #388 confirm executor and limits | Reporting and coverage |
| Paired versions, protected backup/key set and restore oracle | #387 provides canonical fixtures/procedure; #388 consumes, does not redesign | MAC-16 |

No row blocks this preparation PR. Missing prerequisites block the dependent execution
row; failed assertions against available prerequisites are failures, not blockers.
