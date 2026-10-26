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
