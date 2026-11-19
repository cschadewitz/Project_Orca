# Exact-run plan — DRAFT, NOT AUTHORIZED

This is the plan a live observation of the Save / Allow Once / fresh-rule lane
would follow. **It has not been reviewed or authorized and must not be
executed.** Executing it requires (1) an independent review of this plan and of
the code it names, (2) the gate items below closed, and (3) Casey's separate
written authorization of the final concrete plan, recorded with its digest. No
part of this draft removes the existing observer refusals, launches the
historical unreachable observer, activates a guard, deploys or publishes.

## Gates that are still open

| Gate | State | Owner |
| --- | --- | --- |
| G1 Exact source fixed | Open. A reviewed commit that contains the producer, the journal emitter and the integration below does not exist yet. The tuple's `source.commit`/`tree` are null. | implementer + reviewer |
| G2 Journal emission and supervisor answer channel | Open. The supervisor must send human answers itself and record them in its own stream (`human.answer.sent`); until that exists `require_lane_counts` refuses non-simulated input. The producer (`packages/cli/test/controlled-owned-read-producer-expanded.ts`) does not emit the `journal.py` grammar. It must emit it through a dedicated descriptor owned by the supervisor, not stdout. | implementer |
| G3 Independent effect observer | Open. The observer stream must come from outside the candidate (kernel-level trace of the contained process tree by the supervisor, mapped to `effect.observed`), start before the session, end after settlement, name the session's statement, and emit `observer.alive` at least once a second while tracing. #809's `controlled_replay.py` replays a kernel trace but is bound to the legacy designation and is not on main. | #809 owner |
| G4 Original bootstrap and connected lineage | Open (blocked). Needs an authorized original bootstrap run whose receipt callable and settled graph are retained in the same supervisor (#809 `designate_bootstrap`). | #809 owner |
| G5 Session authority key | Open. Casey generates an Ed25519 key offline; a reviewed change adds only its public key to `authority.PRODUCTION_TRUST_ROOT`. | Casey + reviewer |
| G6 Runtime | Open. The builder targets `node24`; this host has Node v22.23.4. The qualification runtime, its executable digest and the loader manifest must be fixed. | implementer |
| G7 Supervisor integration | Open. `ledger.py`, `containment.py`, `bound-loader.mjs` and `authority.py` are not wired into #809's supervisor. | implementer |
| G8 Independent review of code and this plan | Open. | independent reviewer |

## Concrete plan (to be filled in and frozen before authorization)

1. **Identities (pre-authorization).** Fill every null in
   [`guard-proof-identity.json`](guard-proof-identity.json) from the exact
   reviewed commit: clean tree, build input/output digests from a fresh frozen
   install and build, Node and Python executable digests, loader manifest digest
   for the image modules, containment spec digest, profile digest, tool schema
   digest and versions, and the host fields including `host.requirements`. The
   tuple has no session, plan, authorization or envelope field, so it can be
   measured and digested before anything else exists. `identity.require_exact`
   must pass against a fresh measurement immediately before launch and again at
   each phase boundary. Any drift ends the run with `identity_drift` or
   `identity_mismatch`.
2. **Host.** One disposable Linux VM created for this run only (per #809's Linux
   VM plan), no production data, no credentials, no network route, destroyed
   afterwards. Inside it, `containment.launch_contained` provides the process
   boundary; the VM is the kernel boundary. Kernel release, host id digest and
   host requirements (Linux 5.12+ `mount_setattr`, `pidfd_open`, readable
   `/proc/<pid>/stat`, unprivileged user namespaces; the `/proc/.../children`
   interface is not needed) are bound in the tuple.
3. **Containment.** Allowlisted root built on a tmpfs inside the private mount
   namespace: `/usr` and the Node directory bound and made read-only
   recursively; the reviewed snapshot (bundle, loader, manifest) copied into a
   private tmpfs and checked against the reviewed per-file digests before
   release; disposable workspace read-write; fresh namespaces, only `lo`, exact
   environment, no inherited descriptors, no capabilities. `/proc/self/mountinfo`
   is checked from inside: every mount except `/workspace` read-only. The
   candidate starts only after the preflight report and the outside namespace
   check pass.
4. **Loaded code.** `node --permission --allow-fs-read=/snapshot
   --disallow-code-generation-from-strings --no-addons /snapshot/bound-loader.mjs
   /snapshot/manifest.json <digest> controlled-child.mjs`. The loader refuses if
   any of those flags is missing. The manifest lists the producer bundle and
   child only; optional native modules are refused, and the reviewed `ws`
   JavaScript fallback must be confirmed in review. The current main-built
   producer bundle references `Module._extensions` 15 times and is refused by
   the loader's static check (`loader_compile_reference`); that must be resolved
   in reviewed source before this step can work.
5. **Session authority.** The order is fixed and acyclic:
   (a) the pre-authorization identity of step 1 is measured and digested;
   (b) the frozen plan names that identity digest;
   (c) Casey signs one statement binding the plan digest, the pre-authorization
   identity digest, the designated consumption ledger id, session id, principal
   and owner digests, lanes `save`, `human-read`, `rule-read`, and a window of at
   most ten minutes;
   (d) after the verifier has checked and consumed the statement (it re-measures
   the identity itself; no caller supplies a digest), it issues the outer run
   envelope naming the identity, plan and consumed statement digests, the
   ledger and the session. Journals and evidence cite the envelope digest.
   No earlier object contains a later digest. The capability is checked at each
   phase start, before each dispatch and at the final boundary. Revocation is a
   signed revocation statement written to the designated ledger; a ledger on
   another host is not reachable, so the statement is only accepted by
   verifiers using its designated ledger.
6. **Lanes and data.** One disposable target file with fixed synthetic content
   in the workspace. Save of one concrete-action standing rule; one Allow Once
   invocation reading the target; one fresh invocation in a new turn reading it
   under the saved rule. No other tools, providers or routes (see the
   unsupported list in the gap matrix).
7. **Bounds.** Unchanged: 55 s owner, 60 s run, 256 MiB runtime assets, 1 MiB
   report/metadata/clock trace, 39 cleanup resources, 1 s worker join, journal
   limits from `bounds.py`. No retries of an uncertain execution.
8. **Allowed effects.** Exactly two independently observed reads of the target
   (one per execution phase), zero in Save, no writes, no network, no process
   creation beyond the candidate tree.
9. **Cleanup and settlement.** All resources through `AcquisitionLedger` in
   subreaper mode in a dedicated supervisor. Success requires settlement
   `settled`; otherwise the run is reported uncertain and the workspace is
   preserved for private inspection.
10. **Evidence.** Raw journal, observer trace, supervisor stream, run envelope and preflight report go to
    `PrivateEvidence` (owner-only, bounded) on the VM, then to a private store
    named in the frozen plan. Public output is `public_summary` with allowlisted
    codes plus digests and sizes only.
11. **Acceptance.** `journal.replay_and_count` over the complete producer,
    observer and supervisor streams (the observer continuously present from
    before session start to after settlement, never silent for more than 1 s;
    every producer boundary check and human answer matched by the supervisor's
    own records), then `require_lane_counts`. Today `require_lane_counts`
    refuses every non-simulated call because no reviewed supervisor-side human
    answer channel and no authenticated stream custody exist; both are
    prerequisites of this step. When they exist, it must report: Save 0, Allow Once 1, fresh
    rule 1, each reported as answer recorded, native delivery, execution
    started, execution completed and effects observed. Even a pass is observed
    evidence for this one tuple, not production qualification.
12. **Independent observer and reviewer.** A reviewer who did not write the code
    re-runs the replay from the private evidence and checks the digests.

## Authorization record

Not present. This section stays empty until Casey authorizes a frozen version
of this plan by digest.
