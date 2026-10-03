# Manual diagnostic export contract (draft)

**#416 first implementation revision:** [pretrigger-buffer.md](pretrigger-buffer.md)
now documents an isolated, unwired app-main buffer and revised draft rolling schema.
Only the configurable five-minute default is approved; all other policy decisions remain
pending. The #421 baseline/scope and implementation-status statements below are the
historical preparation record, not the scope or evidence for this later slice.

Design and synthetic fixture deliverable for [#421](https://github.com/cschadewitz/Project_Orca/issues/421),
under [#416](https://github.com/cschadewitz/Project_Orca/issues/416). **Not approved for
capture, retention, export implementation or tester use. Parent acceptance remains open.**

Audited and fetched `origin/main` on 2026-10-03:
`e94bf699d9f3000de8822ed3434c1dce92b6ce19`, the issue's required baseline. Kepler sync
reported no changes/conflicts; no later rebase or peer branch import was performed.
The owned diff is exclusively `docs/preparation/manual-diagnostics-contract/`.

| Artifact | Purpose |
| --- | --- |
| [contract.md](contract.md) and [schema-v1.json](schema-v1.json) | Exact fields, provenance, bounds, serialization, exclusions and unknown semantics |
| [failure-mapping.md](failure-mapping.md) | Typed safe outcomes, current gaps and support stop conditions |
| [preview-and-consent.md](preview-and-consent.md) | Wireframe, consent copy, state transitions, exact-byte and accessibility obligations |
| [privacy-and-storage.md](privacy-and-storage.md) | Threat model, platform storage/key obligations and safe deletion |
| [fixtures/README.md](fixtures/README.md) | Exact synthetic sample bytes, invalid bundles, adversarial cases and consent traces |
| [acceptance-and-handoff.md](acceptance-and-handoff.md) | Review decisions, owners, validation matrix and honest execution status |
| [validate.py](validate.py), [test_contract.py](test_contract.py), [requirements.txt](requirements.txt) | Isolated offline schema/fixture checks; no runtime sanitizer or collector |

Run from the repository root with Python 3.10+ and the isolated `jsonschema==4.19.2`
dependency. It was already available in the preparation environment. If needed, install
`requirements.txt` into a separate tooling virtual environment; no root manifest changes:

```sh
python3 -m unittest discover -s docs/preparation/manual-diagnostics-contract -p 'test_*.py' -v
python3 docs/preparation/manual-diagnostics-contract/validate.py docs/preparation/manual-diagnostics-contract/fixtures/valid/startup-unknown.json
git diff --check
```

Checker exit codes: `0` proposed contract pass, `1` rejected fixture, `2` unreadable
fixture/CLI misuse. A missing Python dependency prevents the check; it is not a pass.
The checker reports fixed reasons only, never exception messages containing input data.
CLI misuse returns `2` and `BLOCKED: invalid_arguments` without echoing supplied arguments;
`--help` remains available with a fixed program name.
It opens only its local schema and the explicitly named fixture; it does not discover
profiles, inspect stores, contact a daemon, collect evidence or send anything.

## Reused foundations and source limits

[#402](https://github.com/cschadewitz/Project_Orca/issues/402)'s
[artifact contract](../native-mac-delivery/artifact-contract.md) supplies the proposed
verified candidate identity. [#403](https://github.com/cschadewitz/Project_Orca/issues/403)'s
[fixture contracts](../native-mac-testing/fixture-contracts.md) and
[handoff](../native-mac-testing/implementation-handoff.md) supply native test ownership
and physical-evidence boundaries. Their recorded baseline and proposed fields are
historical preparation, not current packaged evidence. At this baseline,
[release-compatibility.json](../../../release-compatibility.json) states protocol 1.10
and store epoch `config-generations-v3`; neither is a claim about an untested candidate.
This work does not redo packaging, the general Mac matrix or the portable artifact validator.

Source facts shaping this proposal:

- [daemon-process.ts](../../../packages/app/src/main/daemon-process.ts) carries startup
  errors and exit output with raw stdout/stderr tails, paths/URLs and free text. None is
  safe to serialize; current startup distinctions may remain `unknown`.
- [connection-state.ts](../../../packages/app/src/main/connection-state.ts) owns the
  five connection states, authentication handling and delayed display. Read a typed
  observation from this owner, not a renderer's error or a new diagnostic probe.
- [handshake.ts](../../../packages/protocol/src/handshake.ts) mixes useful version data
  with store paths, process and workspace/instance identifiers. Do not copy `HelloResult`.
- [request-submission.md](../../request-submission.md) distinguishes accepted work from
  recoverable failure; lost transport is not a safe reason to resubmit.
- [protected-file.ts](../../../packages/store/src/protected-file.ts) uses execution keys
  and a generic `RUN_STATE` on several failures. It is not a diagnostic exporter or a
  tested Windows diagnostic ACL implementation.

No current log, audit stream, RPC payload or protected record is an export source.
The future producer must construct this schema from explicitly authorized typed facts.
Unavailable safe facts stay `unknown`; #409's related error precision is not a blocker.
