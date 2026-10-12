# Restoration acceptance fixtures (#396)

**Final acceptance remains incomplete.** Provider-free restart assertions now consume
corrected runtime #546 `3054319b37ae61ba22b62ba2f519dc50bf3c0ebc` and adapter #543
`879bedcf701f4eaad2e8da47bac8feb2444c2d9d`, first combined with evidence baseline
`10834758e49a5e84b9ac06e3bca85f87be923dac`. Publication integrates main
`93aa9d1352bb25a24e9fb84940674c3e5dcd78f9`, which contains merged #542/#543/#546.
Runtime and JEV source bytes match the tested dependency heads exactly; the 80-case
evidence is reused without a broad repeated suite. Original fixture baseline was
`65606fbce827cba914a67b999b1a47c0aab2797a`; local extension `76718433` is preserved.
Implementation pins record the merged dependencies. Root minimal review of this
bounded fixture change remains pending, separately from dependency integration.

**One Vitest TODO remains:** parent-owned Actual-Cal private-route inspection and
explicit permitted resume. Two external claims are explicitly unverified rather than
simulated: installed whole-code/dependency attestation plus real credential authority,
and real-provider in-flight reconciliation. Exactly-once external effects remain
unsupported under #297. Synthetic fixtures cannot clear these claims.

Use Node **24.21.0**, pnpm **12.4.2**, and the unchanged frozen dependency/build policy.
The corrected cases automatically execute when the canonical descriptor reader is
available from the engine. On a baseline without that dependency they remain visibly
skipped. An optional exact candidate selector checks the expected pin and requires the
real seam to exist; it does not manufacture support or independent review clearance.
Combine the exact source heads in a disposable checkout before collecting evidence:

```sh
ORCA_RESTORATION_CANDIDATE=3054319b37ae61ba22b62ba2f519dc50bf3c0ebc pnpm exec vitest run packages/engine/test/restoration-acceptance.test.ts -t 'corrected contract integration'
pnpm run typecheck
pnpm exec eslint packages/engine/test/restoration-acceptance.test.ts packages/engine/test/restoration-acceptance/*.ts
pnpm exec prettier --check packages/engine/test/restoration-acceptance.test.ts packages/engine/test/restoration-acceptance/*.ts
git diff --check
```

`matrix.ts` records 14 exercised capability/refusal obligations, the one live TODO,
and the two external unknowns. Root owns review clearance and final acceptance. Local checks dispatch or rerun no
CI workflows; the authorized normal publication push may start ordinary PR checks.

## Owned footprint and execution boundary

Exactly seven new files: `restoration-acceptance.test.ts`, `fixture.ts`, `harness.ts`,
`launch.ts`, `matrix.ts`, `worker.ts`, and this README. No runtime, bootstrap, adapter, dependency,
manifest, workflow, host or credential configuration is authored. Parent owns
integration, independent review, CI and merges.

Every case creates a disposable `orca-restoration-acceptance-396-*` root with a unique
ownership marker, configuration, plugin entry, workspaces and protected file stores.
Workers run production CLI bootstrap with separate module caches, PIDs and boot UUIDs.
The harness records Node executable SHA-256/version, supplies a minimal environment,
bounds output and lifetime, and awaits child close before accepting evidence. Cleanup
signals only owned subprocesses. The configured agent command never executes; scripted
sessions return deterministic completed turns. Fixture fetch interceptors open no socket.

Under Vitest each worker is a fresh `node` process running a bundle of `worker.ts` that
`launch.ts` builds once per run; the JEV adapter is built into the same bundle, so a
generated plugin and the worker share one `@orca/core`. With no run directory
(`ORCA_TEST_BUNDLES=0`) the worker starts from its TypeScript sources through tsx instead.

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
| Canonical limits | Oversized encoded bytes, UTF-8 strings, value count and depth refuse at capture and fresh protected recovery; exact supported byte/value/depth boundaries restore without effects |
| Non-JSON capture | Small/huge sparse arrays, non-index properties, accessors, non-finite numbers, class instances and symbols refuse before expansion, getter execution or effects; validator mutation cannot exceed bounds |
| Historical/current plan replacement | Direct, prototype and nested method replacements remain bootstrap-bound; introducing any unsupported current callback refuses historical executor recovery before factories/provisioning |
| Identity and trust | Schema/code/dependency/plugin identity mismatch and absent/refused/throwing trusted verifier refuse before factories or provider execution |
| Partial reconstruction | Second factory throwing, omitting or duplicating registration discards historical candidate; current generation and current executor behavior remain intact |
| Unsupported behavior | Host/FS mutation, workspace provider, plan extractor, built-in callback mutation and human-input callback cannot claim executor-only restoration; mixed legacy composition stays bound |
| Capture refusal | Throwing validation, secret-bearing invalid data and closure data produce sanitized refusal |
| JEV defaults | Before-evaluation restart uses recorded model/endpoint without resolving credentials during capture/restore; node override remains pinned and new admissions use current defaults |
| Durable JEV result | Completed event, artifact content/IDs and original generation/workflow bytes survive without another evaluation, even with revoked current credentials |
| Current credentials | Missing/revoked key, changed account/reference/provider and throwing binding/key accessors fail before HTTP evaluation |
| Unsupported JEV options | Arbitrary injected provider and inline API key refuse during constructor capture, before executor registration/execution; the current constructor throws a sanitized plain Error (`options-unsupported`), rather than a runtime `RUN_STATE` |
| Redaction | Successful credential echo, transport credential echo and raw resolver exceptions produce sanitized failed runs/events |
| Lost responses | Lost admission receipt retries to the same durable IDs; lost JEV response records failure after one synthetic effect, and fresh terminal resume preserves that failure without another effect or an exactly-once recovery claim |
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
and Actual-Cal private-route inspection/resume are **UNRUN**. The fixture review status remains pending until root completes its minimal review.
It is separate from the one executable-test TODO.

## Local evidence and author review

The corrected combined checkout preserves the exact runtime and adapter source bytes.
Focused partitions exercise **80 distinct provider-free restart cases**: 41 runtime,
refusal and authority cases (including three overlapping credential cases), 15 JEV
cases, 20 new callback/descriptor regressions, and seven follow-up cases. Two nested
callback cases in the first regression run used an incorrect fixture store property;
the fixture path was corrected and those cases passed in the follow-up. No runtime or
adapter defect was hidden or patched by this fixture owner.

Final focused checks pass **6/6 with one Actual-Cal TODO**, covering JEV
pre-acceptance credential-read absence, current-default admissions, terminal
lost-response resume and the exact pin ledger.
Main-baseline and combined workspace typechecks pass; the corrected adapter test fixes
the previous async-capture assertion type incompatibility. Scoped lint on the owned source tree, formatting,
protected-byte checks and diff/Markdown checks pass. The scratch checkout reuses linked
dependencies, so its inherited ESLint package resolves the original project root;
scoped lint runs in that original owned checkout and combined typechecking runs in the
corrected checkout.
The existing baseline cases were not broadly rerun on this combined head.

Author self-review checks the six-path footprint, capability detection on an unbound
baseline, original protected-record preservation, per-process ownership and cleanup,
canonical bounds versus the intentionally permissive synthetic validator, and accurate
external unknowns. Fixtures use no competing restoration or retry API. Root authorized one normal push to existing draft #547 after dependency integration.
No manual CI rerun or merge is performed by this owner; root controls the remaining
minimal review and integration.
