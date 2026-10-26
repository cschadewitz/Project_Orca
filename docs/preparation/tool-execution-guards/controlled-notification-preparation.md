# Notification / resource-projection preparation — no acceptance

This separate preparation combines kernel notification commit
`d95a426131ae8072c1c0db3edcececc643ddb01a` with independently source-reviewed
semantic #757 `4c4c52cb693bff2689debab062f3c83fa9640e1b`, preserving both component
histories. The branch-only merge is
`51603784e6d922f6de25d4bf678e812947559959`, on
`cal/controlled-notification-preparation`. #756 contains only the kernel delta;
this preparation does not move #748 or main and does not merge a PR.

Semantic code/tests/scope are byte-for-byte the reviewed owner's head. Kernel
code/tests are byte-for-byte the notification component head. The complete local
Python suite passes **152 tests**; the kernel-only suite at its own component
head passes **143**, including the independent 620-history exhaustive counter
oracle. `git diff --check` passes. No hosted CI or full pnpm pass is claimed.

## First fresh combined attempt

`python3 -B tools/owned-read-proof/controlled_supervisor.py` built a new physical
image of reviewed producer `557f62fbe86fc8371d48f11ec37bf9db71cac436` and retained
the actual tracer clock/namespace/process/image observations. Local raw evidence:
`/tmp/orca-controlled-replay-f5kujuzm`.

| Evidence | Actual value |
| --- | --- |
| Producer exit / supervisor exit | **0 / 2 (incomplete evidence)** |
| Process elapsed | **11225124488 ns** |
| Trace bytes | **112843449** |
| Trace SHA-256 | `12ca550199ee00f79ac869197e04e29a032035b65849d177955615a68f52b0fa` |
| Producer image SHA-256 | `c81477f96d56bdc89e56d96aaf35fa8c62c418080406c07c63db9f75b56585fd` |
| Child image SHA-256 | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` |
| Build manifest SHA-256 | `d1fcc114c726ef11d77c31d9a862e7b407d03bf82b5c195a2270add15b0d0ad0` |

This first combined fresh attempt includes **one actual notification overlap**,
not a selected nonoverlapping schedule. Its typed notification proof reconciles
**901** original unit writes with **893** original-leader drains and final counter
**0**. The original zero-counter factory entry is raw index **420** and the
qualifying leader epoll ADD entry is **4024**. Counter proof remains
`authority: none`; it is a raw-interval counter witness, not measured absolute
linearization/completion times or proof of callback/work identity.

Kernel replay records 12 settled threads and exactly one detached service pread
(offset 2, length 4, bytes `73706f73`). The complete required physical publication
provider is available for the actual semantic files. Four semantic records
independently authenticate/correlate under the corrected enrollment-authority
versus resource-projection predicates. The necessary integer expiry check uses
resource create-entry **1793045669578986738 ns** (one-based raw line **23015**)
and authenticated expiry **1793045724577000000 ns**, without changing the
55-second source owner bound or the independent 60-second process timeout.

The supervisor has no remaining modeled refusal in this attempt, but its status
is deliberately **`unavailable-effect-audit-and-source-review-pending`** and its
exit remains **2**. No accepting exit, connected launch or connected token exists.
All raw traces/private originals remain local. The five earlier timestamped runs,
including their original eventfd refusal reports, remain preserved and were all
checked against the proposed counter grammar; none was deleted or rewritten.

## Precise limits and remaining gates

The notification contract is the separate
[counter draft](controlled-notification-counter-contract.md). It applies only to
the exact kernel-created, original-leader/epoll/handle-bound unit counter role.
General descriptor/path intervals, publication, close/reuse/control and phase
checks remain unchanged. No producer/runtime or Node/libuv instrumentation was
needed for the observed fully decoded initialization and counter histories.
Unknown shapes or missing observations must refuse.

The semantic result checks source-approved necessary predicates, not a full
canonical-schema/acceptance theorem. Original managed enrollment remains in the
authority revision; the actual owned resource tree remains a separate projection.
The logical resource UUID is source-owned and is not derived from its inode.
Its correspondence depends on the reviewed exact image, authenticated records
and physical-stamp checks. The observer does not independently measure random
UUID issuance or recover the unprojected in-memory owner snapshot. Trusted source
and kernel, stable clocks/mounts/hostname, and the cooperative same-UID owned-group
assumptions remain explicit; this is not arbitrary same-UID memory containment.

Independent review of the new notification proof and of the exact combined
preparation, broader effect/semantic audit closure, and any later gate decision
remain with the parent. A passing model/control suite or this fresh partial
bootstrap must not promote the draft to acceptance. Candidate verifier, security
settings, real access/services, user workspaces, Mac work and all existing bounds
remain untouched.

## Reviewed finite-schema integration and fresh observation

The separate preparation now combines independently source-approved semantic
#758 `722e6248b96e6c2deb0d5cbb5372c80c57e38846` through branch-only merge
`d53288a6ca19c3d928fcaeea7f6ee15bf5d408b4`. Semantic code/tests/scope match
that exact owner head; kernel/provider/notification code and tests match `d95a426`.
Both original histories remain intact. This does not move #748 or main or merge
a PR. The new notification component has parent-reported bounded independent
source approval for its finite single-reader/unit-write model.

The complete Python suite passes **166 tests** (3.112 seconds), including the
44 semantic controls. The six affected TypeScript files pass **147 tests**:
`controlled-owned-read.test.ts`, `controlled-owned-read-fdinfo.test.ts`,
`owned-file-read-controlled-supervisor.test.ts`, `owned-file-read-service.test.ts`,
`synthetic-read-fence.test.ts` and `owned-file-read-required-judge.test.ts`.
They ran with `node node_modules/vitest/vitest.mjs run` and those exact paths
(installed Vitest 5.0.2; 69.23 seconds). The initial `pnpm exec vitest run` wrapper
attempted automatic dependency setup and failed with ENOENT creating its home
store. No setup/security change or install retry was used; invoking the existing
local runner completed the affected checks. No full pnpm/hosted CI pass is claimed.
`git diff --check` passes.

The fresh image/run is `/tmp/orca-controlled-replay-2g8h3hs1`. Producer source and
the producer/child/build SHA-256 values remain exactly the three source/image
bindings above. It ran the combined tree
`d65be8effc03ce0fc658bc86cce5fd51fe3a5964`; correcting only the unpublished merge's
author to Cal preserved that exact tested tree. Actual results:

| Evidence | Actual value |
| --- | --- |
| Producer / supervisor exit | **0 / 2 (incomplete)** |
| Elapsed monotonic process interval | **13795040008 ns** |
| Trace bytes | **112905714** |
| Trace SHA-256 | `6439f3cfa76fdf4b653747569e61cb24cac3729ff0109a9e4a686f4377a83e56` |
| Settled threads / service preads | **12 / 1**, offset 2, length 4, bytes `73706f73` |
| Notification counter | **901 writes / 893 drains / final zero**, one actual overlap |
| Authenticated closed-grammar records | **4**, `authority: none` |
| Supervisor status | `unavailable-effect-audit-and-source-review-pending` |

The unchanged necessary expiry operands, in integer UNIX nanoseconds, are
`S=1793046926095108031`, `C=1793046928459455051`,
`F=1793046939890146618`, `E=1793046983457000000`.
`S <= C <= F < E <= C+55000000000` holds; C is the resource's original validated
exclusive-create entry, one-based raw line 23012. It is still not independently
measured owner issuance. The process bound remains 60 seconds and trace bound
256 MiB; there is no accepting exit or connected token.

### Preserved-run replays in the current execution environment

All six preserved timestamped traces were attempted with this combined code and
their unchanged original supervisor observations: `itopmgup`, `23z4v0qu`,
`k3k1qgxr`, `0844smhv`, `bxhnugvl`, `f5kujuzm` (each with the
`/tmp/orca-controlled-replay-` prefix). Every attempt progressed through raw
syscall/event replay to final named-object comparison, then refused:
**`RuntimeError: final named inode differs/missing physical observation: /dev`**.
The tool execution sandbox creates its own `/dev` mount for each invocation;
the current named-object observation cannot replace the retained original.
No comparison, original observation, mount setting or report was changed to
obtain a replay pass. These attempts do not complete the final kernel proof or
semantic authentication, and are not a new passing result for the historical
images. The fresh run above performs its original retention and final physical
comparison within its own supervised invocation and completes those checks.

The six original trace hashes remain those in the preceding counter/checkpoint
notes. All original traces/images/private records and attempt reports remain
local and intact; the new local replay-results file is separate. The current
historical-replay action is **blocked by unavailable matching live physical
context**, not denied and not awaiting approval. Recreating or weakening that
context is outside this bounded validation.

The finite schema closes the enumerated authenticated-field/type/coverage/
rule-verdict gaps under exact reviewed source. It does not independently observe
in-memory permit/callback/dispatch identity or random UUID issuance. Trusted
kernel/source/native runtime, stable clocks/mounts/hostname and cooperative
same-UID owned-group assumptions remain. Aggregate independent review and broader
effect/semantic audit closure remain with the parent. Connected commands remain
unsupported; production, alternate providers/exec, native shell, Mac/Windows,
remote hosts, restart recovery and hostile same-UID/root containment are not
qualified by this bootstrap.
