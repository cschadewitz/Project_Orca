# Native Mac delivery implementation handoff

Prepared **2026-10-02** for [#402](https://github.com/cschadewitz/Project_Orca/issues/402)
and parent [#385](https://github.com/cschadewitz/Project_Orca/issues/385).
Source baseline: **`7abc2342aa672ee9d2f10d565ca4f8eb546184df`**.
This preparation owns only `docs/preparation/native-mac-delivery/` and changes no runtime,
CI, package manifest, credential, distribution access or release state.

The review packet is [current state](current-state.md), [delivery design](delivery-design.md),
[prerequisites/decisions](prerequisites.md), and [artifact contract v1](artifact-contract.md).
Accepting this packet closes the preparation child only; #385 remains open until signed
delivery and physical acceptance have actual evidence.

## Proposed ownership and file changes

These are reservations to agree at integration review, not permissions to edit shared
files now. Freeze exact paths/owners after the delivery and test handoffs are reviewed.
Re-audit main and pending [PR #397](https://github.com/cschadewitz/Project_Orca/pull/397)
before implementation. No change below depends on importing its branch.

| Path / proposed addition                                                                                                                        | Intended change                                                                                                                                                                                                                                                                                                                                     | Proposed implementation owner / coordination                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/electron-builder.yml` and proposed `packages/app/build/native-mac-signed.*` overlay                                               | Keep existing platform targets, add an explicit signed arm64 lane with required identity, hardened runtime, reviewed entitlements and build identity resource. Prove overlay merge/schema against locked builder; ordinary unsigned development outputs must never qualify as candidates.                                                           | #385 packaging owner; shared config reviewed with release integrator.                                                                  |
| Proposed `packages/app/build/entitlements.mac.plist` and helper policy                                                                          | Pin and explain effective entitlement sets; avoid broad exceptions; verify all embedded code. Exact per-helper configuration chosen under D2.                                                                                                                                                                                                       | #385; review daemon RunAsNode compatibility with runtime owner without editing that runtime.                                           |
| Proposed `packages/app/scripts/native-mac-identity.js`                                                                                          | Generate the v1 identity from clean source/root version/protocol/lockfile and actual daemon bytes before signing; reject inconsistent override/stale output.                                                                                                                                                                                        | #385; no new hello fields or app bridge imports.                                                                                       |
| Proposed `tools/deploy/native-mac-candidate.py`                                                                                                 | Orchestrate explicit app → notarize/staple → ZIP/DMG → notarize/staple DMG stages; emit manifest, checksums and sanitized evidence; fail closed. Use the existing builder rather than invent a second app packager.                                                                                                                                 | #385; shared contract agreed with #388/#403.                                                                                           |
| Proposed `tools/deploy/native-mac-verify.py` and focused tests                                                                                  | Portable manifest/hash/path validation plus macOS-only signature/architecture/ticket verification. Keep fixture and candidate modes distinct.                                                                                                                                                                                                       | #385 produces verification interface; #388 owns packaged execution/negative fixtures. Agree exact test paths at D6.                    |
| `.github/workflows/desktop.yml`                                                                                                                 | Add explicit Mac signing mode/arm64 execution assertion and named secret inputs/environment; invoke candidate stages. Replace standalone unauthenticated hello probe with authenticated client use in an isolated workspace; never disable daemon auth to pass CI. Upload contract files and bounded evidence separately from private scratch data. | Release integrator, with #385/#388. Authentication probe uses the integrated runtime's public client/token contract after #397 review. |
| `.github/workflows/release-publish.yml`                                                                                                         | Preserve existing platform/smoke gates. Route approved Mac credentials only to signing, require verified Mac contract and test result for the same source/build/digests, then promote exact bytes. Do not publish a signed beta via the old unsigned path.                                                                                          | Release integrator; explicit environment/secret plumbing and publication authorization.                                                |
| `tools/deploy/release-assets.py`, proposed Mac promotion entry point                                                                            | Require valid Mac pair/manifest in signed-beta mode alongside existing Windows checks. Add Mac-only immutable catalog promotion without depending on Windows metadata or changing Windows channel pointers.                                                                                                                                         | Release/distribution integrator; coordinate with existing `publish-feed.py` rather than weakening its checks.                          |
| `packages/app/package.json`, root `package.json`, `pnpm-lock.yaml`                                                                              | Only if the reviewed implementation needs scripts/dependencies. No dependency/version bump is assumed; root version assignment is D5.                                                                                                                                                                                                               | Shared manifest owner after coordination.                                                                                              |
| `docs/RELEASING.md`, `docs/UPDATING.md`                                                                                                         | Replace obsolete unsigned-Mac instructions when proven; document explicit signed invocation, secret scope, candidate identity, private download route and manual update limits.                                                                                                                                                                     | #385 with #387 upgrade owner and #389 guide owner. Outside this preparation directory until implementation.                            |
| Runtime/connection/protocol files (`src/main/index.ts`, `daemon-process.ts`, workspace/connection/client/bridge code, daemon/engine/core/store) | No delivery-owned changes. Report required seams to #397/#386 owners; preserve authenticated daemon, admission and generation boundaries.                                                                                                                                                                                                           | Reserved to runtime/onboarding integration, not #402/#385 packaging work.                                                              |

## Ordered slices and parallel work

1. **Next implementation slice:** agree D2/D6 and build the identity generator, portable
   contract validator and negative fixtures against the locked builder schema. Inspect
   actual hooks/entitlements and prove a local unsigned app-directory packaging sequence
   only as development evidence. This can start without Apple credentials, but requires
   separate implementation authorization beyond #402. No unsigned output passes candidate
   mode. Resolve D1/D4/D5 before generating a real candidate.
2. Add the protected Mac signing lane and sanitized evidence collection, after the owner
   verifies credentials/runner. Validate app/container identity and both stapled app copies.
3. In parallel, #388/#403 develop the consumer harness from contract v1, #386 develops
   onboarding, #387 defines safe manual replacement and #389 drafts user instructions.
   No testing preparation is hard-blocked by a signed artifact; real artifact acceptance is.
4. After D3 and explicit access/deployment authorization, implement and test the private
   download catalog. Promote only a complete, accepted candidate; run the physical Mac
   walkthrough against those exact downloaded bytes before invited-beta sign-off.

This ordering is acyclic: contract review → producers/consumers in parallel → candidate
tests → authorized promotion/physical acceptance. Existing issue dependencies still apply
to final acceptance; this handoff does not reverse #388's dependency on #385/#386.

## Automated acceptance for implementation

| Gate                            | Required result / negative cases                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable contract tests         | Valid synthetic shape parses only in fixture mode; missing fields/pair, unknown schema, duplicate/path traversal, size/hash mismatch, mismatched version/protocol/source/build and fixture-as-candidate are rejected. Check baseline protocol against the selected source, not a hardcoded future version.                                                                      |
| Locked build plan               | Frozen install resolves recorded tools; root/app/daemon version checks fail mismatches; expected output names and arm64 targets remain stable. Existing Windows target tests and feed checks continue to pass.                                                                                                                                                                  |
| Signing preflight               | Absent/invalid/expired identity, wrong team, missing notary access or non-arm64 executor blocks clearly. Failure/cancellation cleans temporary keys and does not upload them. Do not test by revoking live credentials.                                                                                                                                                         |
| Final containers                | Inspect all Mach-O code for arm64 support; validate nested signatures, approved team, hardened runtime, timestamps and entitlement policy. Notary rejection/timeout is failure/pending, not acceptance. App extracted from each format and DMG have valid staples. Tampering with daemon or signed resources fails verification.                                                |
| Exact packaged execution (#388) | On actual arm64 macOS, launch final app without developer checkout, developer shell PATH, external daemon or `ORCA_DAEMON_URL`. Establish authenticated owned daemon association and compare hello/version/protocol/capabilities with sealed identity; exercise isolated safe sample, artifacts, gate flow, quit/reopen and failure reporting. Redact tokens and private paths. |
| Delivery                        | Authorized download returns exact final hashes. No/expired/revoked access, partial upload, corrupt copy and missing evidence cannot expose/promote a candidate. HEAD/Range and catalog have the same authorization; no token-bearing URLs or source access needed.                                                                                                              |
| Repository integration          | Run relevant focused tests plus required typecheck/lint/format/build and CI checks for the final implementation scope. Source smoke and type proof remain distinct from packaged-Mac execution.                                                                                                                                                                                 |

Candidate reports record source SHA, build ID, artifact digests, OS/Xcode versions,
hardware/architecture, stage, timestamp and result. Use `passed`, `failed`, `blocked`, or
`not-run`; skipped/unavailable Mac checks never become passes. Keep logs bounded and
remove authorization headers, tokens, private account paths and personal workspace data.
Fixture tests must assert behavior, not reproduce constant strings from implementation.

## Manual acceptance still required

Owner-only Apple/account/secret and distribution provisioning is still unknown. Physical
Mac checks are **not run**. An approved tester must download both formats through an
invited non-repository account on the selected macOS matrix, retain quarantine, install
and open normally in Finder, and confirm publisher/Gatekeeper and offline ticket behavior.
Then verify dedicated workspace selection, actual local daemon, TCC/tool permissions,
sample execution and useful failures with #386/#388. Follow #387 for N-to-N+1 and recovery;
do not claim those from a fresh-install test. No security bypass counts as acceptance.

## Failure handling and rollback limits

| Failure                                                  | Required behavior                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Missing secrets/account or signature/entitlement failure | Stop before candidate upload; preserve a sanitized reason. No unsigned fallback, automatic account purchase or identity substitution.                                                                                                                                                                                                      |
| Apple timeout/outage                                     | Keep submission ID and submitted digest; query the same request with bounded retries. Only `Accepted` plus valid signatures/staples allows continuation. Expired CI retention may require a new build/candidate, not invented evidence.                                                                                                    |
| Notary rejection/stapling failure                        | Retain sanitized log, fix cause and rerun affected stages. A changed signed payload requires a new submission/identity/evidence; final hashes must be regenerated. Do not redistribute pre-staple outputs as complete.                                                                                                                     |
| Test or upload failure                                   | Keep prior catalog selected; quarantine incomplete candidate from discovery. Retry transferring already verified bytes when intact; rebuilt bytes require a new build ID and full verification. Never overwrite an immutable candidate or released tag.                                                                                    |
| Post-promotion bad candidate                             | Owner may withdraw catalog pointer and restore a previously verified candidate after review. This stops future discovery only; existing downloads remain. Credential/certificate revocation is a separate, consequential owner action.                                                                                                     |
| Installed app startup/upgrade failure                    | Stop further replacement and use #387's documented recovery. A previous signed binary may not read a newer store. Preserve configs, credentials, encryption keys and protected execution data; restore a consistent supported backup into isolation before any data rollback. Never delete stores or force-kill active work as “rollback.” |

Mac automatic updating remains outside scope: the existing driver is Windows-only.
Signing does not fix version/store compatibility or preserve live agent callbacks across
replacement. Consult [UPDATING.md](../../../docs/UPDATING.md),
[release-compatibility.json](../../../release-compatibility.json) and the integrated
runtime's protected-storage rules before authorizing an upgrade.

## Preparation verification and PR requirements

For this documentation change, check Markdown formatting, relative link/path existence,
the quoted source values, JSON example syntax, owned-directory scope and whitespace.
Executable tests/installers/signing are not needed to validate prose and were not run as
Mac evidence. The draft PR must link #402 and #385, identify D1–D6 and unperformed owner/
physical actions, report exact commit SHA and checks, and keep the parent's acceptance
open. The five files here are the project documentation update; broader release docs
remain reserved for the implementation owners.
