# #706 enforcement acceptance preparation

Prepared 26 October 2026 from main
`32f92cc16b9faf1748059e930c3f77b3934151ae` for
[#706](https://github.com/cschadewitz/Project_Orca/issues/706), coordinated by
[#699](https://github.com/cschadewitz/Project_Orca/issues/699).
This is a source/test inventory, isolated adversarial data and a reusable plan.
It implements no enforcement adapter, policy port, judge, gate or receipt ledger.
Every corpus case is unexecuted and awaits the parent-agreed
[#700](https://github.com/cschadewitz/Project_Orca/issues/700) interface before
executable conformance integration. A scenario's expected invariant is a proposed
acceptance obligation, not evidence that current production satisfies it.

## Existing tests first

Paths below were inspected at the baseline. Their assertions establish only the
named source/synthetic boundary. Local reruns are recorded in [validation](validation.md).

| Foundation | Existing test and assertion | Reuse / remaining boundary |
| --- | --- | --- |
| #237 live owner/lifetime | [engine live input](../../../packages/engine/test/live-input.test.ts): original lease, actor, one answer, recheck after authority await, seven-field identity, cancellation, owner loss/restart, uncertain append, standing-write ordering | Reuse `LiveHumanInput`; no second live registry. Callback delivery does not establish dispatch/effect. |
| #237 session and upstream | [agent session](../../../packages/agents/test/live-input-session.test.ts): same tool ID/new invocation, agent death, cancelled old turn; [upstream](../../../packages/integrations/test/live-input-upstream.test.ts): replaced target and authenticated fallback | Preserve original callback object and connection incarnation; client labels are not authorizers. |
| Existing permissions | [sidecar session](../../../packages/agents/test/permission-sidecar-session.test.ts): reread on next ask and corrupt-sidecar fallback; [permissions](../../../packages/agents/test/permissions.test.ts), [protected paths](../../../packages/agents/test/protected-paths-session.test.ts) | Reread per ACP ask is not a check on a native cached action without an ask. Existing fallback behavior is not fail-closed strict-profile proof. |
| #328 current authority | [live authority](../../../packages/daemon/test/live-input-authority.test.ts): idle/child revocation, broken credential store; [socket](../../../packages/daemon/test/security-socket.test.ts): revocation, expiry, reconnect | Reuse authenticated owner-local authority and resource checks; do not create credentials for fixtures. |
| #328 config/privacy | [configuration boundary](../../../packages/daemon/test/security-configuration-boundary.test.ts): raw-read revocation and Apply recheck; [sensitive integration](../../../packages/daemon/test/security-sensitive-integration.test.ts): no sensitive echoes over HTTP/socket replay | Reuse protected originals and safe projections; literal canaries do not prove general secret detection. |
| #331 replay | [retry](../../../packages/engine/test/admission-retry.test.ts), [multiprocess](../../../packages/engine/test/admission-retry-multiprocess.test.ts), [supported clients](../../../packages/integrations/test/m10-supported-client-retry.test.ts), [app intents](../../../packages/app/test/admission-retry-intents.test.ts) | Retained intent/current-authority replay is admission recovery, not permission to reissue an uncertain external action. No new ledger. |
| #474 boundary | [issue #474](https://github.com/cschadewitz/Project_Orca/issues/474) defines durable answer/cancel revision, lookup and writer-fence work | Planned extension, not a shipped generic durable answer/cancel receipt guarantee. Live approvals and durable workflow gates retain different lifetimes. |
| #594 exact command | [offline v1](../../../packages/agents/test/command-evidence-v1-594.test.ts), [reference fixture](../../../packages/agents/test/fixtures/command-evidence-v1.ts), [generic #506](../../../packages/agents/test/acp-command-conformance-506.test.ts), [source-loss witness](../../../tools/test/acp-command-evidence-source.test.js) | Reuse identity, scope, unsafe/omitted evidence, budget, record-before-delivery and lost-ack cases. The v1 reference is synthetic and accepts no supported installed pair. |

Current production [permissions](../../../packages/agents/src/permissions.ts)
evaluate adapter-reported kind/title/locations per ask. See the
[source boundary inventory](../../research/tool-call-safety/current-state.md)
and [offline #594 contract](../../implementation/594-command-evidence-v1.md).
Neither telemetry nor lack of an ACP ask establishes complete mediation. The
research matrix is not a runtime support registry.

## Isolated corpus and provisional interface needs

[corpus.v1.json](corpus.v1.json) contains symbolic traces, variations and expected
invariant IDs, with no executable command, live identifier or provider request.
[corpus.schema.json](corpus.schema.json) validates preparation data only; it is
not the #700 action/evidence schema. `trace` entries are ordered stimuli, not
observations. `checks` are assertions a future harness must implement against real
ports; no corpus loader, dispatch function or production import is supplied.
`variations` require separate cases when eventually executed, with barriers at
each named await. Synthetic canaries are public test strings, never credentials.

The parent/contract owner must resolve these seams before wiring:

| Needed observation or control | Acceptance purpose / owner boundary |
| --- | --- |
| Exact action snapshot before transformations and at final dispatch, with explicit representation/completeness | Detect final argv, cwd, resource, stdin, executable or scope change; no reconstruction from display text. #700 owns names/types. |
| Distinct action/callback/connection and run/agent/host identity; original expiry and ownership | Distinguish identical concurrent invocations; consume one authorized permit at most once. Reuse #237 identity/fence. |
| Current rule/revision, authority and revocation generation at the enforcing boundary | Race revocation/epoch changes after every await and immediately before dispatch. Captured execution config cannot freeze current authority. |
| Trusted capability negotiation and hook/config integrity, including failure state | Separate observation, policy-per-ask and verified-per-execution claims. Unknown/missing hook must not inherit a strict supported claim. |
| Separate policy, optional judge and enforcer adapters, plus a controlled clock/barriers | Replace judge without changing deterministic ceilings or action identity; inject failure without real providers or services. |
| Distinct recording, native callback delivery, dispatch and independently observed effect | Avoid false exactly-once/cancellation claims; retain unknown states and inspect original receipt without redispatch. Reuse #331/#474 boundaries. |
| Approved disclosure projection, serializer and protected persistence/logging seam | Assert exact field and UTF-8 frame budgets, credential exclusion, safe retention and authorized inspection. No private review policy is invented here. |

These are observation requirements, not frozen TypeScript signatures or a demand
for peer-branch dependencies. Rename/map corpus tokens only after the agreed
interface; preserve stable case IDs and record the mapping revision. Preserve
generic supported ACP behavior while a stricter capability remains unsupported.

## Reusable per-path conformance plan

1. Pin the exact ORCA head, provider/native/bridge/tool versions, public build
   identities, negotiated hook contract, host/OS, effective modes, policy/judge
   revisions and containment assumptions. Label the evidence source: source,
   synthetic, installed correspondence or separately authorized live acceptance.
   Never put private request hashes or raw command evidence into the public packet.
2. Select the claimed path and its applicable corpus families. Classify each row
   as observation/UI only, policy per ask, verified per execution, unsupported or
   unknown using the reviewed #700 vocabulary. Record why any case is inapplicable;
   an excluded or unobservable path cannot become a pass. An unsupported adapter
   remains unsupported even if a cooperative fake checker passes every scenario.
3. Start in memory/disposable local fixtures with a fake clock and deterministic
   barriers. Seed distinct invocations with identical arguments and separately
   seed same-item/new-callback and new-connection cases. Record expected effect
   before executing. Failures must be observable even when no approval record
   exists; never require invented allow/delivery facts to report an unsafe effect.
4. Bind the real adapter only after interface agreement. Test native cached grants
   by establishing the cache in the fixture, changing ORCA authority, then making
   the second action without an ACP ask. Observe the final dispatch seam directly.
   A test that merely calls the checker twice cannot prove native hook coverage.
5. At every authority/judge/persistence/delivery await, release the barrier after
   changing the relevant identity, policy generation, expiry or owner. Check zero
   new dispatch for the stale action and no late positive callback. If dispatch
   already occurred, preserve it and its unknown/observed effects; cancellation
   cannot claim rollback. Never repeat a non-idempotent action to recover proof.
6. Exercise required/advisory/disabled judge modes and at least two interchangeable
   synthetic judges on identical inputs. Deterministic deny/authority ceilings
   always win. Required failure stays fail-closed; advisory fallback follows the
   reviewed policy explicitly and cannot supply missing authority. Injected text
   cannot change mode, policy, tool routing or disclosure. Block cross-provider
   disclosure until the exact projection/destination is authorized.
7. Inspect authorized private evidence separately from UI, public audit, logs,
   errors, notifications, replay, crash output and retained files. Assert canary
   exclusion per destination, complete necessary disclosure or unavailable with
   no positive choice, and protected storage handling. For #594 preserve its
   12 KiB row / 256 KiB framed-result limits; use reviewed path-specific budgets
   elsewhere instead of inventing universal values or latency targets.
8. Publish an exact-scope receipt only for checks actually run. Record rule/revision,
   authorizer, one-shot/stored grant, original expiry, observed revocation latency,
   coverage tier and residual paths through existing safe surfaces. Do not add a
   policy UI. Measure latency/resource use only under an approved bounded plan;
   no measurement or numerical target is supplied by this preparation.

The bypass family includes agent-native fs/shell, child processes, subagents,
interactive stdin, alternate MCP, client filesystem/terminal, custom transports,
remote execution and config/hook tampering. Classify actual confinement assumptions
for each. A hook is not an OS sandbox; a local kill does not prove remote or
descendant termination. Compare physical-path/symlink behavior and effect boundary
separately from command identity. #449 retains unattended host containment;
#600/#601 retain their separately deferred operational experiments.

## Reporting and handoff limits

Keep four independent observations for each invocation: approval recorded, native
callback delivered, dispatch started, effect independently observed. Each can be
yes/no/unknown/not-applicable with its evidence source. No callback is legitimately
not-applicable only when the path itself is established; missing telemetry is
unknown. A lost acknowledgement stays unknown unless read-only evidence resolves
it. An unexpected effect fails the scenario even if authorization/delivery is
unknown. Absence of a marker alone is not proof of prevention without a bounded,
independent effect observer. Do not turn any of these fields into one success bit.

Reuse the existing [safe evidence rules](../acp-command-conformance/evidence-format.md)
where applicable. Their closed v1 schema is specific to #506/#594: do not squeeze
new judge/dispatch facts into it or silently extend its accepted values. A future
versioned receipt mapping needs separate review; this draft creates no acceptance
store and supplies no fabricated pass records.

[#594](https://github.com/cschadewitz/Project_Orca/issues/594) remains the sole owner
of C6b and installed/actual-Cal exact-command proof. Its
[live handoff](../acp-command-conformance/live-test-handoff.md) stays disabled;
[current unsupported mode](../../implementation/m10-live-command-evidence-disposition.md)
and #602/#390 beta gates remain intact. This preparation cannot close that issue,
and no all-provider beta gate is introduced. Each ready adapter can be assessed
for its named scope independently. #363 privacy, #338/#357 recovery/storage and
#408/#423 persistence measurements retain their existing ownership.
