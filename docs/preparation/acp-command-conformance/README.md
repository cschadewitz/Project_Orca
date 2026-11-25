# ACP command approval conformance preparation (#506)

Preparation only. Synthetic success does not certify the installed Codex/ACP
profile, a deployed ORCA daemon, the tunnel, or actual Cal behavior. No provider,
model, live daemon, credential, standing grant or network policy is used here.

## Ownership selected before edits

On 2026-10-07, at baseline `794e64344e3d6edb64e80c5920f722ff381fa4a5`,
the unused fixture path was selected and recorded in the task conversation:
`packages/agents/test/acp-command-conformance-506.test.ts`. All other owned files
are new files in this directory. Production and existing test files are reserved.

## Packet

- [#594 native dispatch seam](dispatch-seam/README.md): private offline patch and
  29 actual JSON-RPC/NDJSON dispatch tests, extending merged PR676. Native
  completeness and maintained release-pair support remain unavailable.

- [#594 provider contract proposal](../../archive/implementation/594-provider-evidence-contract.md):
  25 October release/source refresh, smallest binding proposal and remaining
  installed-provider/actual-Cal blockers. The positive handoff stays disabled.

- [Source and capability map](source-map.md): release pins, payload losses and
  support limits.
- [Test matrix](test-matrix.md): assertions, seams and unproved boundaries.
- [Evidence contract](evidence-format.md): versioned, bounded, safe reporting.
- [Evidence regression samples](evidence-v1.samples.json): unexpected effects,
  unknown delivery, native execution without an ACP ask, and invalid pass claims.
- [Later test handoff](live-test-handoff.md): disabled and unexecuted; requires
  separate authorization under [#393](https://github.com/cschadewitz/Project_Orca/issues/393).
- [Validation](validation.md): exact commands, results and blocked checks.

Later follow-up: the [9 October M10 disposition](../../archive/implementation/m10-live-command-evidence-disposition.md)
reuses this completed packet at #589 over #584 and records the unsupported exact
evidence contract, required product decision and still-disabled live handoff.
The original preparation ownership and validation below remain historical; this
follow-up adds no production fix or installed-provider acceptance.

Run the synthetic fixture with existing dependencies:

```sh
pnpm test packages/agents/test/acp-command-conformance-506.test.ts --maxWorkers=1
```

The peer speaks real ACP framing to `openAcpSession`, entirely over in-memory
streams. The production orchestrator creates live inputs with its original
execution lease. The operator projection and answer alias are invoked in process;
authentication/current authority is synthetic and explicit. There are no listeners,
subprocesses, shell effects or host filesystem accesses. Its “executed” observation
is only an in-memory counter in a cooperative peer.

This extends shipped [#237](https://github.com/cschadewitz/Project_Orca/issues/237)
and the [#327](https://github.com/cschadewitz/Project_Orca/issues/327) operator seam.
The launch experience in [#424](https://github.com/cschadewitz/Project_Orca/issues/424)
and #393's acceptance matrix remain their respective owners' contracts.
