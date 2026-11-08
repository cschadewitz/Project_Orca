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
| G2 Journal emission | Open. The producer (`packages/cli/test/controlled-owned-read-producer-expanded.ts`) does not emit the `journal.py` grammar. It must emit it through a dedicated descriptor owned by the supervisor, not stdout. | implementer |
| G3 Independent effect observer | Open. The observer stream must come from outside the candidate (kernel-level trace of the contained process tree by the supervisor, mapped to `effect.observed`). #809's `controlled_replay.py` replays a kernel trace but is bound to the legacy designation and is not on main. | #809 owner |
| G4 Original bootstrap and connected lineage | Open (blocked). Needs an authorized original bootstrap run whose receipt callable and settled graph are retained in the same supervisor (#809 `designate_bootstrap`). | #809 owner |
| G5 Session authority key | Open. Casey generates an Ed25519 key offline; a reviewed change adds only its public key to `authority.PRODUCTION_TRUST_ROOT`. | Casey + reviewer |
| G6 Runtime | Open. The builder targets `node24`; this host has Node v22.23.4. The qualification runtime, its executable digest and the loader manifest must be fixed. | implementer |
| G7 Supervisor integration | Open. `ledger.py`, `containment.py`, `bound-loader.mjs` and `authority.py` are not wired into #809's supervisor. | implementer |
| G8 Independent review of code and this plan | Open. | independent reviewer |

## Concrete plan (to be filled in and frozen before authorization)

1. **Identities.** Fill every null in [`guard-proof-identity.json`](guard-proof-identity.json)
   from the exact reviewed commit: clean tree, build input/output digests from a
   fresh frozen install and build, Node and Python executable digests, loader
   manifest digest for the image modules, containment spec digest, profile
   digest, tool schema digest and versions. `identity.require_exact` must pass
   against a fresh measurement immediately before launch and again at each phase
   boundary. Any drift ends the run with `identity_drift`.
2. **Host.** One disposable Linux VM created for this run only (per #809's Linux
   VM plan), no production data, no credentials, no network route, destroyed
   afterwards. Inside it, `containment.launch_contained` provides the process
   boundary; the VM is the kernel boundary. Kernel release and host id digest are
   bound in the tuple.
3. **Containment.** Allowlisted read-only root (`/usr`, the Node directory, the
   reviewed snapshot), disposable workspace read-write, fresh namespaces, only
   `lo`, exact environment, no inherited descriptors, no capabilities. The
   candidate starts only after the preflight report and the outside namespace
   check pass.
4. **Loaded code.** `node --permission --allow-fs-read=/snapshot
   --disallow-code-generation-from-strings --no-addons /snapshot/bound-loader.mjs
   /snapshot/manifest.json <digest> controlled-child.mjs`. The manifest lists the
   producer bundle and child only; optional native modules are refused, and the
   reviewed `ws` JavaScript fallback must be confirmed in review.
5. **Session authority.** Casey signs one statement binding the frozen plan
   digest, identity digest, session id, principal and owner digests, lanes
   `save`, `human-read`, `rule-read`, and a window of at most ten minutes. It is
   verified and consumed once; the capability is checked at each phase start,
   before each dispatch and at the final boundary. Revocation is a signed
   revocation statement.
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
10. **Evidence.** Raw journal, observer trace and preflight report go to
    `PrivateEvidence` (owner-only, bounded) on the VM, then to a private store
    named in the frozen plan. Public output is `public_summary` with allowlisted
    codes plus digests and sizes only.
11. **Acceptance.** `journal.replay_and_count` over the complete producer and
    observer streams, then `require_lane_counts`: Save 0, Allow Once 1, fresh
    rule 1, each reported as answer recorded, native delivery, execution
    started, execution completed and effects observed. Even a pass is observed
    evidence for this one tuple, not production qualification.
12. **Independent observer and reviewer.** A reviewer who did not write the code
    re-runs the replay from the private evidence and checks the digests.

## Authorization record

Not present. This section stays empty until Casey authorizes a frozen version
of this plan by digest.
