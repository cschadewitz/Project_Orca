# Restoration acceptance fixtures (#396)

**Final acceptance remains incomplete.** This suite exercises production bootstrap in
fresh OS processes. The baseline is main `65606fbce827cba914a67b999b1a47c0aab2797a`.
Candidate runtime #546 is `7202a6e06525052f304f4f49abbfd783e163a375`; independent
review found historical callback replacement and two descriptor-bound gaps, with
corrections pending from its owner. Candidate success does not clear those gaps.
JEV #543 is independently reviewed at `e4039a32e4a82aa19cd95b3e98f2813b47486903`
(review `5451051133`). `matrix.ts` separates candidate pins from reviewed pins.
Actual-Cal live acceptance remains parent-owned and **UNRUN**.

Use Node **24.21.0**, pnpm **12.4.2**, and the unchanged frozen dependency/build policy.
The default suite runs baseline cases and leaves candidate cases visibly skipped.
To execute candidate integration, combine the exact runtime and adapter source heads
in a disposable checkout and explicitly select the runtime pin:

```sh
ORCA_RESTORATION_CANDIDATE=7202a6e06525052f304f4f49abbfd783e163a375 pnpm exec vitest run packages/engine/test/restoration-acceptance.test.ts
pnpm run typecheck
pnpm exec eslint packages/engine/test/restoration-acceptance.test.ts packages/engine/test/restoration-acceptance/*.ts
pnpm exec prettier --check packages/engine/test/restoration-acceptance.test.ts packages/engine/test/restoration-acceptance/*.ts
git diff --check
```

The flag selects executable evidence, not independent review clearance. Final ledger
TODOs remain explicit until the parent reviews and binds corrected exact runtime and
adapter heads, resolves remaining contractual assertions, and supplies live acceptance.

## Owned footprint and execution boundary

Exactly six new files: `restoration-acceptance.test.ts`, `fixture.ts`, `harness.ts`,
`matrix.ts`, `worker.ts`, and this README. No runtime, bootstrap, adapter, dependency,
manifest, workflow, host or credential configuration is authored. Parent owns
integration, independent review, CI and merges.

Every case creates a disposable `orca-restoration-acceptance-396-*` root with a unique
ownership marker, configuration, plugin entry, workspaces and protected file stores.
Workers run production CLI bootstrap with separate module caches, PIDs and boot UUIDs.
The harness records Node executable SHA-256/version, supplies a minimal environment,
bounds output and lifetime, and awaits child close before accepting evidence. Cleanup
signals only owned subprocesses. The configured agent command never executes; scripted
sessions return deterministic completed turns. Fixture fetch interceptors open no socket.

Reports contain stable IDs, counters and leak flags. Raw child logs, credential resolver
exceptions and plugin diagnostics never cross IPC. Canary checks inspect diagnostics
inside the worker. Original encrypted generations, workflow records and synthetic owner
keys are hashed before and after restoration. Authenticated descriptor mutation writes
a separate generation ID and preserves all original protected bytes.

## Executable candidate observations

| Boundary | Assertion |
| --- | --- |
| Custom executor closure | Historical effects use captured old inputs; new admissions use changed inputs |
| Schema/version/data | Contract version 1 restores; future/zero versions, missing/malformed descriptors, invalid data, duplicate records/types and wrong spec/digest refuse before effects |
| Identity and trust | Schema/code/dependency/plugin identity mismatch and absent/refused/throwing trusted verifier refuse before factories or provider execution |
| Partial reconstruction | Second factory throwing, omitting or duplicating registration discards historical candidate; current generation and current executor behavior remain intact |
| Unsupported behavior | Host/FS mutation, workspace provider, plan extractor, built-in callback mutation and human-input callback cannot claim executor-only restoration; mixed legacy composition stays bound |
| Capture refusal | Throwing validation, secret-bearing invalid data and closure data produce sanitized refusal |
| JEV defaults | Before-evaluation restart uses recorded model/endpoint; node override remains pinned |
| Durable JEV result | Completed event, artifact content/IDs and original generation/workflow bytes survive without another evaluation, even with revoked current credentials |
| Current credentials | Missing/revoked key, changed account/reference/provider and throwing binding/key accessors fail before HTTP evaluation |
| Unsupported JEV options | Arbitrary injected provider and inline API key refuse during constructor capture, before executor registration/execution; the current constructor throws a sanitized plain Error (`options-unsupported`), rather than a runtime `RUN_STATE` |
| Redaction | Successful credential echo, transport credential echo and raw resolver exceptions produce sanitized failed runs/events |
| Lost responses | Lost admission receipt retries to the same durable IDs; lost JEV response records failure after one synthetic effect, without an exactly-once recovery claim |
| Authority and lease | Restored custom executors remain fenced by revoked/missing/mismatched current admission authority and an IPC-proven live process lease |
| Consent | Restart delivers no prior live permission callback and writes no standing consent |

The synthetic executor's trusted verifier compares identity, owned entry URL, actual
entry bytes and the SHA-256 of the Node executable (its only dependency beyond Node
built-ins) with fixture-owned metadata. JEV identity labels are synthetic attestations;
they do **not** prove the installed adapter's complete dependency closure. Production
verification policy remains the runtime owner's contract and the parent's deployment
responsibility. The verifier is supplied through the actual #394 bootstrap seam;
fixtures define no competing descriptor, loader, provider or retry interface.

A lost admission receipt is suppressed after durable persistence with clean process
exit; this is not a hard-crash atomicity test. A lost provider response remains externally
ambiguous under #297; no inspection or durable-result assertion promises exactly-once
external effects. Synthetic authority exercises accepted local execution boundaries,
not authentication on Cal's actual private MCP connection. UI reconnect, reference
clients and subprocess fixtures cannot replace the separate live proof.

Actual user data restores, live agents/providers, credentials, host changes, deployment
and Actual-Cal private-route inspection/resume are **UNRUN**. Final runtime acceptance
also requires explicit regressions for its pending reviewed corrections before clearing
`implementationPins.substrate394` or removing the relevant ledger obligations.

## Local evidence before the publication hold

Combined candidate run: **88 passed, 2 fixture-diagnostic assertions failed, 15 TODO**
(105 total; 261.70s). Those two assertions expected `RUN_STATE` where the reviewed
adapter's constructor emits a sanitized plain error. After correcting the assertions,
the targeted rerun passed **2/2**. Default-main contract preparation passed **3/3**;
candidate cases remain skipped without the explicit selector.

Main workspace and renderer typechecks, scoped ESLint/Prettier and diff/Markdown
checks pass. Combined checkout typechecking additionally encounters an owner-file
incompatibility at `packages/integrations/test/jev-restoration.test.ts:456`:
`Promise<Record<string, unknown>> | Record<string, unknown>` is passed to a synchronous
mock assertion. That adapter test is untouched. Runtime and adapter source byte checks
against the pins above pass. Publication is held by the parent's reduced-CI instruction;
these changes are local until that hold is released.
