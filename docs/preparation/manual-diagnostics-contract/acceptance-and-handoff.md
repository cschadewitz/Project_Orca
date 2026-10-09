> **Owner-approved save-only scope, 9 October 2026:** Casey directed, "Okay lets skip the in app preview, just let them save and export." The active crash-diagnostics flow prepares a main-owned frozen report, lets the user choose a destination, and requires a separate Save. No report contents, text-selection surface or report-byte transport is exposed to renderer/preload. Earlier viewer requirements below are historical and superseded for this flow; consent, canonical validation/redaction, expiry, exact saved output, privacy and numeric resource gates remain. See [save-only implementation and acceptance](../crash-recovery/windows-save-only-followup.md). Production capture stays disabled and Mac stays held.

# Review decisions and implementation acceptance

This preparation stops at a draft PR for review. #416 remains the pre-beta gate; #390
consumes its accepted evidence. Proposed budgets and copy must be reviewed before any
capture implementation or use with a tester. No new credentials, runtime changes,
installation, deployment, release, main merge or diagnostics transmission is authorized.

## Decisions requiring explicit review

All are **pending**. Proposed reviewers below are responsibility roles, not recorded
approvals or newly assigned GitHub assignees.

| ID | Decision | Proposed reviewer / implementation consequence |
| --- | --- | --- |
| D1 | Accept/change 256 KiB export, 2 MiB rolling, 24-hour expiry, 32/256/2,048 event caps, 60-second one-shot, 10-minute preview, 2-second preparation and 512-byte event limits | Casey + runtime owner; benchmark isolation and memory overhead before enabling capture |
| D2 | Approve one-shot disclosure and separate rolling grant; conservative off/purge on restart, clock uncertainty and expiry | Casey + UX/privacy reviewer; no durable opt-in until separately reviewed |
| D3 | Approve exact field/code/enum inventory, metadata identifiability and provenance, public source revision policy and alias remapping | Protocol/privacy owners; unknown stays unknown where safe observations are missing |
| D4 | Independent diagnostic key algorithm/storage, nonce/rotation/deletion policy, Windows DACL rights and POSIX owner verification | Platform/security reviewers; packaged proof mandatory, no execution-key reuse |
| D5 | Freeze safe producer/daemon projection ownership and auth/resource semantics without competing with active runtime/MCP work | #416 integration owner; no private-store imports in renderer, no control capability escalation |
| D6 | Review immutable preview, local destination policy including synced folders, save/cancel commit point, keyboard/reader behavior and consent wording | #386/#389 + target-like participant; no new menu/shortcut/focus implementation |
| D7 | Confirm support contact Casey and stop guidance for uncertain admission, failed resume and unavailable protected state | #389 owner; diagnostics never becomes a recovery/control workflow |
| D8 | Confirm native candidate, fixture hooks, Mac/Windows executors, physical session consent and acceptance ownership | #385/#388/#390 owners; missing hardware is blocked, not a synthetic pass |

An accepted format should freeze a reviewed revision of this directory and schema before
runtime work. Changes to the proposal can still be made here without pretending v1 shipped.
Record the approval revision/date/decisions in the implementation PR; do not mark these
review decisions approved merely because the fixture checker passes.

## Implementation acceptance matrix

| ID | Requirement / test oracle | Evidence type | Status here / later owner |
| --- | --- | --- | --- |
| C01 | Closed schema; unsupported versions, duplicate keys, wrong types, extra nested fields rejected | Offline schema/fixture test | Executed by local command; #421 |
| C02 | Exact safe bytes; event/alias/order/window bounds; canonical serialization and byte ceiling | Offline schema/semantic test | Executed by local command; #421 |
| C03 | Nested/encoded/fragmented secrets, paths, error objects, huge single-line input cannot occupy output fields | Synthetic schema injections only | Executed by local command; #421; does not prove producer exclusion |
| C04 | Default/denied, one-shot, separate rolling, opt-out/restart/expiry/clock/full-disk/key/scan cases documented | Design oracles; declaration consistency only | Present, runtime traces **not run** |
| R01 | Every safe field comes from the approved typed source; zero reads of excluded sources including logs/audit/RPC payloads | Actual producer tests with spies and seeded canaries; permissive scan cannot bypass boundary | **Not run**; #416 |
| R02 | Authorized projections refuse unauthorized/foreign/revoked access without private-store bypass; pre-handshake unknown remains available | App/daemon integration, no raw fallback | **Not run**; #416 |
| R03 | Schema/scan exception/hang, oversized source and load are bounded; runtime state/progress unaffected | Fault injection, CPU/memory/time/disk budget measurements with paired execution oracle | **Not run**; #416 |
| R04 | One-shot scope and full state-cases trace suite, opt-out versus save race, repeated exports and no cross-report IDs | Actual state-machine/IPC/concurrency tests | **Not run**; #416 |
| R05 | Preview text exactly equals saved bytes, all fields visible, omissions/unknown/destination/sharing copy, cancel/back/retry | App UI and filesystem tests | **Not run**; #416/#386 |
| R06 | Owner-only POSIX storage and Windows protected DACL, separate keys, encryption, cleanup/revocation and unsafe-path rejection | Two-account native tests with actual ACL/key APIs, crash/failure injection | **Not run**; #416 |
| R07 | No external diagnostics traffic in off/declined/preparing/rolling/save/failure states | Network observation of actual packaged app/daemon; independent of this offline checker | **Not run**; #416 |
| R08 | Startup-before-handshake, offline, disconnect, sleep/wake and restart on exact Mac and Windows candidates | Packaged tests bound to candidate digests | **Blocked pending implementation/candidates**; #416 + #388 |
| R09 | Keyboard, focus, scroll, both themes, VoiceOver/Windows reader and uncoached comprehension | Native accessibility and target-like participant walkthrough | **Not run**; #386/#389/#390 |
| R10 | Uncertain admission, resume failure, damaged protected state give safe evidence and Casey escalation, never retry/repair/update | Harmless synthetic runtime failure fixtures, actual integrations | **Not run**; #416/#389 |
| R11 | Actual physical Mac model/OS/build, supported hardware coverage and tester consent recorded | Physical acceptance; M3–M5 certification never inferred | **Not run**; #390 |

## Validation record for this slice

Use the commands in [README](README.md). Unit tests check schema, semantic/byte rules and
synthetic fixture declarations. They do not launch ORCA or execute retention, sanitizer,
network, ACL, preview, packaged or physical tests. Repository app tests, app build, signing,
portable artifact validation, and native installation are not required for these isolated
preparation artifacts and remain **not run**. `git diff --check` and local Markdown link
resolution check only the owned documentation diff. Actual command results and exact
commit SHA are recorded in the draft PR to avoid self-referential commit metadata here.

## Next implementation slice and ownership

1. Review D1–D8 and freeze this proposal under #416. Re-read current main, issue state and
   task context before planning runtime ownership; do not import active peer branches.
2. Implement safe typed producers/projections under #416 with isolated budgets and
   auth/resource checks; start with R01–R04, preserving unknown startup/protected-state
   distinctions if the necessary observation is still absent. Bind to current source,
   not a future API invented in this document.
3. Implement protected temporary storage plus immutable preview/local-save flow, including
   R05–R07. Integrate entry/disclosure and support stop guidance with #386/#389.
4. Use #402 delivery identity and #403/#388 native test foundations for R08–R10, then pass
   exact evidence to #390 for R11. Keep general Mac packaging/harness work in its owners.

Hard ordering: **reviewed contract → safe capture/projection → preview/manual export →
focused native evidence → #390 acceptance**. #386/#389 integration can be designed in
parallel, but final integration needs #416's reviewed flow. #390 consumes evidence; it
must not become a prerequisite to implementing #416. #409 is related error precision,
not a hard blocker; it does not justify broader collection.

No additional issue is needed for gaps already owned by #416, #386, #389 and #390.
Related [#422](https://github.com/cschadewitz/Project_Orca/issues/422) owns the beta feedback
guide/report template; its privacy wording should consume this reviewed contract without
copying runtime or recovery ownership. It can prepare independently and is not a blocker.
[#417](https://github.com/cschadewitz/Project_Orca/issues/417) (uploads) and
[#418](https://github.com/cschadewitz/Project_Orca/issues/418) (remote requests) remain
separate later gates. No backend, service/authentication setup, adapter/projection work
for active MCP integrations, or general connection research (#391) is part of this diff.
Do not edit `tools/deploy/native-mac-verify.py`, `tests/native-mac/`, shared manifests/CI,
runtime APIs or existing preparation directories in this slice.
