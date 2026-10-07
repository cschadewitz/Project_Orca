# Production MCP credential-admin import experiment (#510)

Scope: the production test fixture's credential-admin subprocess imports emitted
`packages/daemon/dist/auth/bootstrap.js` instead of emitted `dist/index.js`.
Every issue/revoke still launches its own Node process and calls the same
`openAuthDirectory`. No runtime, workflow, selector, timeout or existing assertion
is changed. Implementation was explicitly authorized after the investigation in
[#510](https://github.com/cschadewitz/Project_Orca/issues/510#issuecomment-6032859261).

## Experiment contract (written before measurements)

- Base: verified remote main `d3491cc06b5abc1c5d82f2c685d6f628d9d4b04b`, tree
  `db6e22b47cafb1504ebdab1c3ef9cac0b06cad90`. Recheck before publication.
- Separate base/candidate checkouts, frozen-lockfile dependency preparation with
  pnpm 12.4.2, official Node 24.21.0 verified against official SHASUMS256.txt.
  Delete old emitted output and rebuild each exact checkout. Retain hashes of
  emitted artifacts, fixture, three existing consumer tests, and lockfile.
- One task command/test workload at a time, one Vitest worker, no file parallelism.
  Synthetic workspaces use a task-local `/workspace` scratch directory on overlay
  storage; `/tmp` is tmpfs. Neither is physical-media or cold-storage evidence.
- Measure six alternating-order pairs of fresh-process issue/revoke sequences
  with identical options and independent auth directories. Separately verify the
  two emitted exports have identical function identity. Persist timings, exit
  outcomes and process counts, never credential/token contents.
- Measure three alternating-order pairs of all three existing production MCP
  consumer files. Record supervisor wall time, each file duration, every stable
  test name/status, and zero unexpected skips. Each invocation has a 600-second
  wall limit plus a five-second termination grace. Existing test/hook deadlines
  remain unchanged. Stop on failure and retain it; no benchmark retries.
- Add a focused regression for emitted export identity, fresh completed admin
  processes and revocation observed by the running compiled daemon. This added
  test is outside the fixed 60-case timing workload.
- Run final-candidate typecheck, lint, formatting, design freshness, explicit
  CLI/ACP no-skip acceptance, full ordinary/coverage gates and emitted demo as
  capacity permits. Record unrun/failed/blocked gates explicitly. Local cloud
  measurements cannot establish homelab queue, contention or CI speedups.

## Assertion-preservation matrix

All rows run via both existing `stdio` and `http` MCP transports. The three
consumer files remain byte-for-byte identical to base. Their original fixtures,
negative inputs, fault injection, timing barriers and expectations remain intact.

| Stable IDs | Preserved scenario/oracle | Change impact |
| --- | --- | --- |
| A01, A07 | Current revocation before all ten aliases and late-publication revocation barrier | Fresh admin process uses identical credential store; dispatch/publication unchanged |
| A02, A03, A09 | Grants, workflow/owner scope, deployment/input/caller identity, cross-run artifacts, strict backing HTTP/WS schemas | Same isolated identities and refusals |
| A04, A05 | All live identity fields, original callback, owner death and restart expiry | Same compiled processes, callbacks and restart |
| A06, A08 | Bounded pages, cursor invalidation, exact audit correlations, no secret disclosure | Same ownership/audit stores and disclosure assertions |
| A10, A12 | Missing protected evidence, whole-read failure, safe cold-read uncertainty without hidden retries | Same fault injection, authoritative reads and refusal behavior |
| A11 | All ten aliases over backing HTTP and WS, real receipts/effects | Same production handlers/transports |
| F01–F04 | Authenticated discovery, capability/HTTP/WS parity, preflight, disk admission, gate/live/parent workloads, continuation and scripted execution | Same fresh workspace and emitted daemon/CLI/MCP/ACP processes |
| L01–L05 | Request/direct identities, exact answer without resume, answer+continuation, pinned protected revision exactly once, descendant cancellation | Same durable stores, workloads and expected receipts |
| R01–R05 | Lost acknowledgements, durable replay, daemon death, old-target refusal, separate concurrent writers, answer/continuation/revision recovery | Same process launches, restart/SIGKILL boundaries and replay/fault scenarios |
| Fixture contract | Fresh state per test, sanitized child environment, cleanup, production-required failure, existing polling/read deadlines | Only admin import URL changes |
| Added regression | Direct and barrel emitted export identity; distinct completed issue/revoke PIDs; real daemon rejects revoked token | Additional proof, excluded from comparative timings |

The existing persistence baseline in
[../persistence-baseline/](../persistence-baseline/README.md) supplies the paired-order
and provenance method. No store workload harness is duplicated. Its pinned
`e94bf699` results are historical; physical-media/power-loss, true storage-cold and
private-phase evidence remain open under #408. This fixture change makes no
runtime persistence improvement or durability acceptance claim.

## Results

Pending fresh measurements. Raw evidence and final validation will be added here.
