# Broader tool-execution guard proof — gap matrix and offline prerequisites

Status: **preparation only. The broader proof is not complete.** Nothing here
designates an image, authorizes an observation, activates a guard, or makes any
path production eligible. The existing live refusals (the four current-image
observation entry points on draft PR #809) are untouched and remain in force.

Base: main `c41c878170767f122107558d2d719e428661eb73` (tree
`a1c46ed56074ddd7cfdcb16e97d500e9f072ed35`), fetched 8 November 2026. Branch
`claude/project-thread-7med65`. The implementation lives in
[`tools/guard-qualification/`](../../../tools/guard-qualification/), a new
directory that does not overlap the files of draft PR #809.

## Coordination and current state

| Item | Verified state (8 November 2026) |
| --- | --- |
| Draft PR #809 | Head `b77e0703a7a0661aa2a1045dad0b3b2d76271843` on `prep/706-current-main-nonlive`, base `f9e7225e`, `mergeable_state: dirty` (conflicts with main). Its description still names head `7c4113d1`. Last commit 3 November 2026. No newer commits. |
| Draft PR #785 | Head `6936e629e5230102af7d653cf8401f209d971b63`, historical SOURCE `3fce8bcc`. Its rebuild comment establishes byte consistency for that historical candidate only. |
| Other active guard work | None found: no branch touching `docs/preparation/tool-execution-guards/` or `tools/owned-read-proof/` has commits after 3 November. The only branch updated on 8 November is `cal/desktop-windows-linux-tyler` (#821, desktop validation, unrelated files). |
| Overlap handling | This work does not modify #809's branch or any file #809 changes, and does not edit existing guard documents. New files only. Integration with #809's `tools/owned-read-proof/` modules is an open step for whoever owns #809. |
| #809 reviewed image vs current main | Rebuilding with main's unchanged builder produces a different image: producer 2,248,585 bytes `b145543e…` and child 5,254 bytes `a58036e5…` versus #809's reviewed 2,248,652 / `1c0bffce…` and 5,713 / `17fdd509…`. #809's image evidence does not describe current main. |
| Denials | The #779 archive-investigation denial and the #793/#794 merge/formal-approval denials are unchanged. This work does not depend on them and did not retry, reconstruct or route around them. |

## Gap matrix

Status vocabulary: **implemented** (code and offline tests exist on this
branch), **simulated** (exercised only with synthetic inputs), **observed**
(seen in an authorized exact run; none yet), **production-qualified** (none).

| # | Obligation | Implementation location | Current status | Evidence | Missing work | Trust assumptions | Acceptance criterion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Exact identity binding and drift invalidation | `tools/guard-qualification/identity.py`; reviewed matrix [`guard-proof-identity.json`](guard-proof-identity.json) | Implemented (checker). Matrix deliberately incomplete | `test_identity.py`: every one of 42 leaf fields drifts → refusal; missing/unknown/malformed refuse; dirty tree detected; unsupported routes enumerated | Measured values for the exact build, loader manifest, containment spec and session do not exist until an authorized run plan is fixed; tool schema digest and provider/bridge versions must come from reviewed source | Git, the Python interpreter, on-disk executables (pathname snapshots are not loaded identity) | `require_exact(reviewed, measured)` passes for one complete tuple; any field difference refuses |
| 2 | Preventive disposable containment before loading candidate code | `containment.py`, `contained_preflight.py` | Implemented and exercised with synthetic probes on this host | `test_containment.py`: allowlisted read-only root via pivot_root, fresh user/mnt/pid/net/ipc/uts/cgroup namespaces, only `lo`, no credentials/home/tmp/etc visible, exact env, no inherited FDs, all capabilities dropped with no_new_privs, verified from inside and namespace identities re-checked from outside before the release byte; violations refuse before the candidate runs | No seccomp filter, no cgroup memory/pids limit, no VM boundary against the kernel. Not yet run with the real producer image (that is execution of candidate code and needs authorization) | Host kernel and namespaces, util-linux `unshare`, Python stdlib, preflight bytes (bound in spec digest) | Candidate executes only after preflight report and outside namespace check pass; any failure leaves the candidate unexecuted |
| 3 | Loaded-code binding to immutable reviewed bytes | `bound-loader.mjs`, `loader.py` | Implemented; tested with synthetic ESM/CJS graphs | `test_loader.py`: static import, `createRequire`, dynamic import served from verified in-memory bytes; disk rewrite after verification not loaded; tamper, unlisted module, native addon, denied builtins, eval, WebAssembly, hook re-registration and symlinks refuse; works inside containment | The producer image has not been run under the loader. Its optional `bufferutil`/`utf-8-validate` externals will be refused (deterministic fallback in `ws` must be reviewed). Node 24 runtime required by the builder target is not the Node 22 on this host | Node/V8 binary and builtins, the loader file bytes, cooperative same-process realm (`process.binding` remains reachable), Node permission model | Every evaluated module equals a manifest entry by SHA-256; anything else refuses before evaluation |
| 4 | Independent exact-session authority | `authority.py` | Implemented. `PRODUCTION_TRUST_ROOT` is empty, so it refuses all real authorizations | `test_authority.py`: Ed25519 statement bound to plan, identity, session, principal, owner, lanes and ≤10-minute window; forged/untrusted/modified/non-canonical statements, booleans, dicts, digests, environment switch, rebuilt/lookalike objects, copies and pickles refuse; single use via durable exclusive ledger; signed revocation honoured at every boundary; monotonic and wall expiry | Casey must generate a signing key offline and a reviewed source change must add its public key. Integration with the TypeScript owner (`live-input-authority.ts`) is not done | Signer's key custody, Python `cryptography`, same-process integrity, host clocks | Only a statement signed by a trusted key, unrevoked, unexpired, unconsumed and matching plan/identity/context yields a live capability |
| 5 | Original supervisor ownership and bootstrap-to-connected lineage | #809 `controlled_supervisor.py` (`designate_bootstrap`, receipt callable) — not on main | **Not implemented here.** Remains blocked | #809's own synthetic fixture only; no original current-source bootstrap receipt exists | Run an authorized original bootstrap, retain the original receipt callable and settled graph in the same supervisor process, then connect | Same-process capability retention | Connected phase accepted only through the original live receipt object of a settled bootstrap in the same supervisor |
| 6 | Acquisition-scoped cleanup and safe process tracking | `ledger.py` | Implemented and tested with real processes | `test_ledger.py`: registration inside acquisition, LIFO cleanup that attempts every item after failures, pidfd-only signalling, subreaper sweep of orphaned/setsid descendants, numeric `kill`/`killpg` never called, directory preserved and success refused when a process is unsettled, dedicated-supervisor and SIGCHLD checks, budget refusal | Not yet wired into #809's supervisor; descendants started by an outside service are out of scope (containment must prevent) | Linux pidfd/waitid(P_PIDFD); no other code in the supervisor reaps children | Settlement `settled` only when every cleanup returned and every owned process and descendant was reaped |
| 7 | Preserve limits and fail-closed checks | `bounds.py` | Implemented | `BoundsTests`: 55 s owner, 60 s run, 256 MiB, 1 MiB report/metadata/clock trace, 32 assets, 39 cleanup resources, 180 s / 60 s outer bounds, 1 s worker join pinned; new bounds only restrict | #809's selector and fixture are not on main; their 180 s bound and four real-tracer exclusions are unchanged by this branch | — | No existing bound widened; no skip; missing tool is failure |
| 8 | Currentness/authority/revocation at pre-dispatch, phase, final; private evidence; safe public output | `authority.py` `check()`, `journal.py`, `reasons.py` | Implemented | Journal requires a `phase` check at every phase start, `pre-dispatch` before each dispatch and `final` before settlement, all naming the session statement; `public_summary` accepts only allowlisted codes and bounded values; `PrivateEvidence` is owner-only and bounded | Wiring to the real producer journal | — | Missing/forged boundary check refuses; raw exceptions never reach public output |
| 9 | Complete current-source trace replay before aggregates | `journal.py` (correlation journal); #809 `controlled_replay.py` (kernel trace, not on main) | Implemented for the proposed correlation journal; simulated only | `test_journal.py`: unknown kinds/fields, gaps, reordering, duplicates, truncation, oversize, floats, missing completeness trailer, unattributed or mismatched effects all refuse; counts exist only from `replay_and_count`, which replays both whole streams itself | The producer does not emit this journal yet; kernel-level replay of a current-source raw trace remains #809's open obligation | Same CLOCK_MONOTONIC for producer and observer | Counts are produced only after every record of both streams is consumed |
| 10 | Save = 0 | `journal.require_lane_counts` | Checker implemented; **simulated** | Synthetic journal: zero invocations, reads, executions, answers, deliveries, effects in Save; any of those injected into Save refuses | Observed run | — | Independent observer shows zero target effects in the Save window and producer shows zero answers/deliveries |
| 11 | Allow Once = 1 | same | Checker implemented; **simulated** | Requires `require-human` with no rule, one `allow_once` answer, one ack, one native delivery, one `human-once` permit consumed once, one dispatch of the exact action, one independently observed read; `allow_always`, remembered-rule verdicts or rule permits refuse | Observed run | — | Exactly one of each fact, correlated by invocation, callback, permit and action digests |
| 12 | Fresh standing rule = 1 | same | Checker implemented; **simulated** | Requires a different invocation and turn, `allow` attributed to the saved rule id and revision, zero callbacks/answers/deliveries, one consumed `rule` permit, one dispatch, one observed read; stale revision, other rule or human confirmation refuses | Observed run | — | Attribution names the actual rule and revision; no human answer involved |

## Unsupported routes

Qualification of the one lane (`controlled-owned-read-connected`, execution path
`orca-owned-file-read-service`) says nothing about any other route. The list is
fixed in `identity.UNSUPPORTED_ROUTES` and tested: ACP native shell and terminal,
provider built-in tools, provider cached native approvals, native `allow_always`,
remembered native denials, shell descendants, subagents, independent MCP servers,
custom sessions, remote/SSH execution, ACP `fs.writeTextFile`, unowned ACP
`fs.readTextFile`, the Claude, Codex, Gemini and Pi providers, Windows and macOS
hosts, pending-intent replay, judge-delegated review, product UI permission flows,
any other tool/schema/codec and any other profile.

## What none of this proves

- No candidate image was executed. Synthetic probes ran inside containment; the
  producer did not.
- Synthetic journals are simulated evidence. Passing them shows the checker's
  behaviour, not ORCA's.
- Ordinary CI and the app smoke workflow are not guard qualification.
- The historical #785 rebuild and #809's independent rebuild establish byte
  facts about those historical images only.
