# First volatile pre-trigger slice (#416)

Implements the configurable five-minute default requested under
[#416](https://github.com/cschadewitz/Project_Orca/issues/416), following
[#436](https://github.com/cschadewitz/Project_Orca/issues/436) and
[PR #438](https://github.com/cschadewitz/Project_Orca/pull/438) at
`5201922e795e6e614f427d35ffba1ee8bee82337`. Runtime baseline is main
`e8678ebaa06f4deb883143df288275300f762b3e`; no MCP integration branch is imported.

## Implemented boundary

`packages/app/src/main/diagnostics/` is an isolated module with **no production
imports, producers, subscription, IPC, preference, UI or startup wiring**. A new buffer
is off. The programmatic `start()` seam is for future consent-gated main-process use
and tests; it is not evidence of tester permission. `stop()` purges references and
cancels the expiry timer. Restart constructs an empty, disabled buffer. No filesystem,
network, logger, audit, RPC payload, execution store or key API is used. No upload or
disk persistence is added. A crash loses the buffer and unsaved snapshots.

`record(phase, code)` accepts only primitive strings from the contract's closed,
phase-specific enum sets. It does not take arbitrary metadata objects, timestamps,
names, IDs, errors, messages or callback payloads. Unknown values are refused without
coercion, traversal, scanning or echo. No source objects or original identities are
retained; entity aliases stay `unknown`. All version/current-state/evidence fields
remain `unknown` until separately reviewed producers can establish them. Enum validity
does not prove source provenance or authorization: those hooks remain future work.

The bounded ring evicts oldest records on count/byte pressure and expires records at
the configured age, both on access and with one unreferenced timer while nonempty.
Decreasing the window expires immediately; increasing it never resurrects history.
The clock is monotonic, timestamps never leave as wall time, and backward/nonfinite/
throwing clocks turn collection off and purge. The future owner must call `stop()` on
suspend or elapsed-time uncertainty, since platform clocks do not uniformly include
sleep. No platform sleep integration or consent-session duration is claimed here.

The append path uses precomputed enum byte reservations, bounded counters and ring
operations, with no full-buffer serialization. A snapshot serializes at most one bounded
ring synchronously into immutable canonical text; later recording/configuration/expiry
cannot change it. It returns the complete JSON and its byte length, without an event
cutoff at snapshot time. This is not a preview/save grant: future main-process preview
ownership must limit copies, expire/revoke them on opt-out and bind save to those bytes.
No UI, local save implementation or preparation deadline is included.

## Reconciled draft limits

| Dimension | Earlier unshipped schema/proposal | This disabled implementation and revised draft |
| --- | --- | --- |
| Rolling window | 24 hours | Five minutes by default; whole-minute configuration 1–15 |
| Retention / export count | 2,048 / newest 256 | Shared ceiling of 4,096; no additional preview/export truncation |
| Rolling storage / export bytes | 2 MiB disk / 256 KiB report | 1 MiB complete canonical rolling report; no disk storage |
| Envelope overhead | Separate from retained event bytes | Maximum envelope, UUIDs, formatting, offset digits, coverage and saturated omission fields reserved inside report ceiling |
| One-shot | 256 KiB, 32 events, 60 seconds | Unchanged draft, not implemented |
| Preview | Ten minutes | Still proposed; lifecycle and UI not implemented |

The schema remains **unshipped draft v1**, not a claim of wire compatibility with a
released format. `schema-v1.json`, `validate.py` and the rolling fixture are revised
together: rolling permits 4,096 events, 900,000 ms and requires coverage; the parser
has a 1 MiB outer limit and applies the older one-shot byte limit after bounded parsing.
Older rolling fixtures without coverage must be regenerated, not silently truncated
or accepted under a fallback schema. The old draft's 24-hour encrypted persistence
and newest-256 assumptions no longer apply to this volatile slice. Historical consent,
privacy and state-oracle docs still describe that earlier proposal; their persistent
storage cases remain deferred, not passed or waived.

Tests align runtime enums/count/time caps with the schema. Python tests exercise both
profiles, byte edges, coverage consistency and 3,000-event reports above both old
rolling export ceilings. `snapshot.ts` derives a conservative reservation from the same
report builder; an exact size check fails closed if a future edit violates it. The
fixed narrow event vocabulary currently reaches the count ceiling before 1 MiB;
independent lower-byte-budget tests prove byte eviction. Serialized size is not a heap
guarantee. Future envelope producers must re-establish the reservation proof.

## Visible omissions and coverage

The canonical snapshot exposes requested duration, observed duration, age of the oldest
retained event (zero if empty) and whether capacity loss intersects the represented
horizon. The age is useful effective event coverage, not continuous recording or a
guarantee of complete evidence. Sparse/empty history and a newly started session must
not be labelled as five minutes of events. Increasing the configured duration cannot
extend the observed horizon backwards over records already expired.

`budget`, `expired` and `invalid` count events over the current collection session,
saturating at `at_least_65535`. Counters are bounded scalars; no dropped-event ledger is
retained. Capacity loss and normal expiry remain distinct. `capacityLimited` clears
once the latest capacity loss is outside the horizon, while cumulative counts remain.
`unavailable` stays unknown because this module has no inventory of safe producers.
The later UI must display these fields and explain their scopes.

## Approval and validation still required

Only the configurable **five-minute default** is approved. The user authorized this
implementation and draft PR, not production collection or the rest of D1–D8.

- **D1:** 1–15-minute range, 1 MiB complete report and 4,096 events are reversible
  implementation assumptions from #438. Benchmark event rates, peak heap including
  frozen previews, expiry and snapshot latency under paired execution load before
  enabling. Final preview/deadline/alias limits still need review.
- **D2/D4:** explicit per-session opt-in, volatile-only handling, suspend invalidation,
  session lifetime and preview revocation remain for consent/privacy review. Persistent
  storage, encryption and keys are deferred; native local-export permissions still apply.
- **D3/D5:** review this reduced phase/code input and full allowlist/provenance policy;
  connect only authorized typed producers. No daemon/MCP/control boundary is changed.
- **D6/D7:** implement accessible exact-byte preview, explicit local destination/save,
  cancellation/revocation and support wording. Diagnostic consent never permits recovery.
- **D8:** packaged Mac/Windows network, sleep/restart, permissions/accessibility tests
  and physical participant acceptance remain unrun. No pre-beta sign-off or #416 closure.

Local commands: `pnpm exec vitest run packages/app/test/pretrigger-buffer.test.ts`,
`python3 -m unittest discover -s docs/preparation/manual-diagnostics-contract -p 'test_*.py' -v`,
`pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run build`.
Exact executed outcomes belong in the draft PR. Synthetic tests do not establish safe
producer integration, consent, measured runtime budgets or native acceptance.
