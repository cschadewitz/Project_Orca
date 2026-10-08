# Synthetic matrix and acceptance limits

Fixture: `packages/agents/test/acp-command-conformance-506.test.ts`.
Every case uses production ACP framing, permission evaluation, orchestrator input
creation, lease fencing and live callback registry. Reads use the bounded
`OperatorReadModel` event projection; answers use `methodsFor`'s real
`operator.answer` alias and `ControlModel`. Host effect methods fail if called;
the artifact collector's empty `existsMany([])` is permitted without actual I/O.
All stores, peer traffic and actor/current-authority checks are in memory.

| Case | Assertion | Evidence / limit |
| --- | --- | --- |
| S01 ordinary allowed action | Workspace read with offered `allow_once` gets selected automatically; no live question or human answer | Exercises production defaults, not native auto-review |
| S02 exact eligible ask | Original run/step/request/boot/session/turn/invocation reaches the operator; remembered choices filtered; protected context retains tool input | Only offered one-shot options appear; synthetic raw command/cwd/scope are omitted from operator projection, a review blocker |
| S03 allow once / duplicate | One selected option, one attributed answer, one synthetic counter increment; duplicate refuses | “Executed” is a cooperative peer counter, not real effect proof |
| S04 reject / cancel | Original rejection option delivered; zero counter increments | Native refusal mapping is source evidence, not executed bridge testing |
| S05 seven identity mismatches | Each wrong run, step, request, boot, session, turn or invocation refuses; original remains pending, no answer written | Exact identities, not equality of tool title/ID |
| S06 next invocation | Same tool ID reused in same turn and in a second pooled-session turn gets a fresh request/invocation; old response refuses | New turn also changes turn identity; every invocation needs its own decision |
| S07 concurrent responders | Exactly one answer succeeds, one event and wire response | Original lease and owner registry serialize acceptance |
| S08 cancel / timeout / agent death | Active invocation aborts; late answer refuses and no authorization counter increment | Agent death is a stream/process-handle closure, not an OS provider kill |
| S09 owner death / restart | Owner registry shutdown expires original; a new boot registry cannot answer copied identity | Owner death modeled by closing owner-local registry. Abrupt actual daemon death/restart is unexecuted |
| S10 execution authority revoked | Owning execution signal abort expires pending input; no answer | Signal injection tests engine binding, not credential-monitor implementation |
| S11 responder revocation | Current responder denied before acceptance and during under-lease recheck; callback remains pending | Synthetic server-bound authority; no credentials created/read |
| S12 reader revocation | Bounded projection refuses after current read authority is revoked | Current authority injected in process; HTTP auth/tunnel untested |
| S13 lease loss | Release original synthetic lease, then answer; fence refuses with `RUN_LEASED`, callback expires, no answer event | No standing writer configured; cannot write policy |
| S14 reconnect before answer | Repeated original-state reads do not settle callback; one subsequent explicit answer | Simulated observer reconnect, not a network reconnect |
| S15 lost acknowledgement | Discard original response, inspect original state, refuse duplicate; still one event/response/counter increment | No automatic retry; delivery can be ambiguous outside the fixture |
| S16 missing command/cwd/scope | Missing raw payload or incomplete raw fields stay visible as a capability gap; test rejects instead of approving | Current production seam does not require these fields; fixture does not add an approval engine |
| S17 remembered-only | Unsupported ask returns ACP cancelled; no live card/answer/policy write | Does not certify automatic-policy remembered fallback |
| S18 update-only path | Tool update produces observation history but no live input or authorization | Models missing native→ACP routing; actual installed routing unknown |

The fixture has 31 expanded cases (parameterized rows account for the difference).
No changes to production or existing tests are needed to pass. Existing
`engine/test/live-input.test.ts`, `agents/test/live-input-session.test.ts`,
`daemon/test/mcp-operator-reads.test.ts` and
`daemon/test/live-input-authority.test.ts` cover related shipped seams. Their
coverage is not installed-profile or actual-Cal acceptance either.

## Separate blocked/unexecuted rows

| Case | State | Owning handoff |
| --- | --- | --- |
| G01 native→ACP emission for installed 0.159.1/2.1.1 | Unknown; source expectations mapped, installed path unexecuted | Bridge/profile evidence under #393 |
| G02 exact command review via actual Cal | Blocked: operator projection omits command/cwd/scope; bridge command transform is lossy | #327 operator projection and bridge fidelity; no fix in this slice |
| G03 managed sandbox denies loopback | Blocked by existing policy evidence from #502; not rerun | Keep denial, no permission/network workaround |
| G04 generic permission-profile grant | Unsupported for one-command acceptance, even if ACP kind is `allow_once` | Scope-aware native/bridge contract required |
| G05 real cancellation, owner death, restart, revocation and tunnel reconnect | Not run; synthetic lifecycle assertions only | Separate per-mutation authorization under #393; do not disrupt existing services |
| G06 full repository suite, production MCP/CLI lanes, Electron smoke | See validation for exact not-run/blocked checks | Requires a permitted test environment and appropriate authority; preparation does not enable a live lane |

This is the existing #393 live/stale/duplicate/unauthorized-answer criterion's
preparation packet, not an expansion or completion of its actual-Cal matrix.
