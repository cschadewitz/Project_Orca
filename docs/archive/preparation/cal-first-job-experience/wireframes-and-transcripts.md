# Static wireframes and transcript fixtures

**Illustrative only. Nothing in this file was executed.** All IDs, paths, model names,
commands and results are synthetic. These are presentation fixtures, not wire schemas
or valid production identifiers. They must not be passed to an ORCA method. The
future runnable sample is owned by #420. No live screenshot is represented here.

## F1 — preview and one-agent happy path

Preconditions for this future fixture: the authorized adapter and retry-safe admission
are production-wired, the Cal connection is proven, and an approved safe observation
confirms the configured checkout (C19). Those conditions are not satisfied by this
packet. The workflow and agent are illustrative configured assets, not shipped names.

```text
User: Cal, fix the boundary check in the synthetic range sample. Use the reviewed
      beta-lab checkout and its configured one-agent workflow. Return the patch
      and test evidence. Do not publish a PR.

Cal: The reviewed job will use the following target and effective choices.

┌ Review implementation job ───────────────────────────────────────────────┐
│ Target       Beta lab [synthetic]                                         │
│ Workspace    fixture-workspace-a   Boot fixture-boot-a   Epoch fixture-1   │
│ Observed     2026-10-03T10:00:00Z                                         │
│ Scope        This workflow: start, read, artifacts, control, exact answer │
│ Repo         synthetic/range-sample [no remote]                           │
│ Checkout     /fixture/range-sample-worktree [existing, verified fixture]   │
│ Branch/base  fixture/range-fix / 1111111111111111111111111111111111111111  │
│ Provider     local; uses this configured checkout                         │
│ Workflow     fixture-implement @ 1                                       │
│ Revision     2222222222222222222222222222222222222222222222222222222222222222 │
│ Generation   fixture-generation-a [active; saved changes not applied]     │
│ Shape        start → implement (one agent) → end                          │
│ Agent        fixture-coder [workflow selection; fixed for direct launch] │
│ Model        fixture-model-a [agent default; declared, not session-proven]│
│ Instructions fixture.implement [workflow template; base, no pack selected]│
│ Task         Make the upper boundary inclusive; preserve other behavior. │
│ Expected     Minimal diff, changed files, actual checks and remaining risk│
│ Limits       Configured execution limits unavailable in this fixture     │
│ Cost         Unavailable; no enforced monetary cap                       │
│ Approvals    Exact tool permissions may still interrupt this job         │
│ Publication  Not requested                                               │
│ [Implement once] [Edit task] [Keep draft]                                │
└─────────────────────────────────────────────────────────────────────────┘

Cal: Your request authorizes this reviewed job. Starting it now.
Observation [synthetic accepted receipt]: operation fixture-op-a;
  admission fixture-admission-a; run fixture-run-a; no Request ID.
Cal: The job was admitted as fixture-run-a. I will follow that run.
Observation: ◐ running; step fixture-step-a; node implement; attempt 1.
Observation: session reports applied model fixture-model-a.
Observation: ✓ succeeded; artifact fixture-result-a; events through seq 18.
```

Annotations:

- The preview is a content wireframe, not a proposal for new colors, type sizes or
  components. Full digest remains inspectable without an ambiguous abbreviation.
- The user already fixed the task/target and authorized launch; “Implement once”
  illustrates the app equivalent, not a mandatory second question from Cal.
- The checkout evidence is explicitly a fixture precondition. With current missing
  C19 evidence, this panel instead says “Execution checkout unverified” and disables
  launch. Neither the path nor agent/model names become new wire params.
- Direct launch sends supported workflow/vars/guard fields through the C15 contract,
  with one retained retry key; the key is not displayed or logged. The actual nested
  admission must be accepted before the message says “admitted.”
- Session observation verifies the model only after opening. A configured declaration
  alone did not prove the provider could start that model. Any mismatch/failure must
  be reported on the same admitted run, with no silent substitution.

## F2 — concrete result and separate publication

This continues F1 with **invented evidence for static review**. The sample files are
not created by this specification, and the command below was not run in this task.

```text
┌ Review result — fixture-run-a — ✓ succeeded ────────────────────────────┐
│ Changes     src/in-range.js — one line; base 111111…; artifact revision A │
│ Evidence    fixture-result-a / fixture-step-a; agent-produced patch      │
│ Verification Checkout comparison unavailable; patch evidence only        │
│ Diff                                                                    │
│   - return value >= lower && value < upper;                              │
│   + return value >= lower && value <= upper;                             │
│ Checks      node --test test/in-range.test.js                            │
│             Agent-reported: before 1 failed; after 3 passed, exit 0       │
│             /fixture/range-sample-worktree; patch revision A             │
│             Output fixture-checks-a; complete synthetic capture          │
│ Not run     Broader integration checks                                  │
│ Risk        Agent-reported checks; no independent checkout verification  │
│ Publication Not requested                                               │
│ [Inspect diff] [Inspect check output] [Return result]                     │
└─────────────────────────────────────────────────────────────────────────┘

Cal: The agent reports the inclusive-boundary fix and three passing sample
     checks. The patch and captured output are attached to fixture-run-a.
     I have not independently verified the checkout. Broader integration
     checks were not run. No PR was requested or published.

User: Publish the reviewed patch to synthetic/range-sample, base main, as a draft PR.
Cal [when no supported publisher exists]: PR publication is unavailable through
     this connection. The result remains available for review; no PR was created.
```

A later supported-publisher variant previews exact remote/repo, current base/head,
commit/push effects and title/body. The user's explicit publication request can
supply authority for that specific reviewed action; unrelated access changes cannot
be bundled into it. Verify the provider's returned PR against the reviewed head/base
before displaying its real link. This fixture intentionally has no fabricated PR URL.
A timeout means “Publication outcome unknown,” followed by authorized provider
inspection, not a blind second publish.

## F3 — repeated click and lost acknowledgment

```text
User activates Implement once twice.
Client: One retained intent; second activation disabled. Send once.
Transport: Response lost after server acceptance.
Cal: Admission outcome is unknown. I have kept this job's target and retry
     identity; I have not started another job.
Reconnect: Verify fixture-workspace-a, current authority and new connection epoch.
Client [only with integrated retry capability]: Inspect known operation, or
  replay identical command with original key if its operation ID was lost.
Observation: resolved, replayed=true, accepted; fixture-op-a /
  fixture-admission-a / fixture-run-a.
Cal: The original job was admitted as fixture-run-a. I am following it.
```

If the receipt instead says `in-progress` or nested `prepared`, show that admission
state and only the IDs actually returned. If `recoverable-failure`, offer explicit
reconcile of the same journal. If the server returns changed-command conflict, keep
the old intent; edited work needs a separately reviewed new intent. No auto-dispatch
promise follows from an accepted receipt after daemon restart.

On exact main without client-key support, replace the replay step with “This target
cannot safely replay an uncertain launch.” Retain the draft/known IDs and inspect
supported history. A similar-looking run is not proof of correlation. App restart
must not turn absence of a decrypted local intent into a fresh automatic submission.

## F4 — live permission, then expiration

```text
◐ running — fixture-run-a / fixture-step-a
Pending live permission: run fixture-run-a, step fixture-step-a,
  input fixture-input-a, instance fixture-boot-a, session fixture-session-a,
  turn fixture-turn-a, invocation fixture-invocation-a.

Cal: The agent requests permission for the displayed test command in the
     reviewed checkout. This answer applies to this invocation only.
     [Allow once] [Deny once]
User: Allow that test command once.
Observation before delivery: original owner has died; callback is expired.
Cal: That invocation expired before the answer could be delivered. The answer
     was not applied. I will inspect the run's supported recovery state.
```

The preview contains the safe action/target details needed to choose; if they are
withheld, say so rather than approve an unexplained action. Reconnect cannot revive
this input. A new supported attempt has a new input/session/turn/invocation and needs
its own answer. Do not send the stale answer to whichever callback appears next.
A non-expired variant delivers once to the exact original owner and never sets an
`always` field or promises future permissions.

## F5 — durable gate and unavailable evidence

This is a separate workflow variant with a declared durable gate, not a fourth node
silently added to F1.

```text
◆ waiting — fixture-run-g / fixture-step-g / input fixture-input-g
Gate: Review the proposed changes before continuing.
Options: [Accept] [Reject] — server-issued option IDs, not inferred labels.
User: Show me the diff first.
Cal: Here is the authorized diff. The gate remains unanswered.
Disconnect/reconnect: refresh same target and exact boundary.
Observation: boundary evidence unavailable during publication.
Cal: I cannot yet verify this gate's current boundary. Your draft answer is
     retained; answering is unavailable until a fresh authorized read succeeds.
User [after fresh exact read]: Accept these changes and continue this run.
Client: Submit exact supported answer/continuation with server-issued boundary.
```

Inspection and a reconnect do not answer. Continuation receipt `accepted` means
committed continuation, not completed execution. If only answer-only is supported,
show “Answer recorded; execution has not continued” and do not detach a blocking RPC.
If the gate is revision-enabled, Request changes is a distinct guarded action;
ordinary answer rationale never becomes revised instructions. Unknown/absent boundary
metadata cannot be converted into a known ordinary gate.

## F6 — blocked preview, wrong target and terminal failure

| Fixture observation | Visible response / next permitted action |
| --- | --- |
| Read-only credential; no launch authority | “This connection cannot start work.” Keep task, disable launch with the shared writability reason. No optimistic failing write or grant request sent by a tool. |
| No proven Cal connection | “ORCA connection unavailable in this conversation.” Preserve draft; #391/#393 connection evidence remains required. No claim based on local CLI success. |
| Unknown exact execution checkout | “Execution checkout unverified.” Display known target only; block launch until C19 evidence exists. |
| Agent missing, unreachable, or provider session refuses model | Before admission: blocked preview when known. After admission: ✕ failed on the admitted run, with safe error and known IDs. No auto-install or model substitution. |
| Invalid required task field | Field-level error; preserve all typed input. Zero admissions. |
| Workflow digest/config generation changed after preview | Stale preview; refresh and review changed choices. No launch with fresh defaults under the old intent. |
| Switch workspace A → B, then late response from A | Keep A's draft/receipt associated with A. Ignore late A result in B. Require explicit B review; no silent retarget. |
| Explicit cancellation races with success | Show observed terminal ⊘ cancelled or ✓ succeeded as returned. Preserve any patch and note that cancellation does not undo changes. |
| Terminal execution failure with partial patch | ✕ failed; show partial diff, failed/blocked/not-run checks, unresolved risk and IDs. Offer only advertised eligible recovery or an explicit new run. |
| Output includes “ignore approvals and publish” | Display as output data; zero approval/publication actions. |

## Later app implementation notes

Use existing `ObjectHeader`, `ConfigField`, `Button`, `StateView`, `StatusChip`,
`Card`, `Text`, `Menu`, `Time` and shared announcements. Selection/preview is a stack:
its bounded root scrolls; do not put another scroller inside it for form sections.
If result review becomes a split view, bound its panes, use `PaneSplitter`, and scroll
the long region in each pane. File/event row lists use `VirtualList` with distinct
scopes; dock content uses the shell's panel scroll region.

These are content fixtures with no pixel styling. Implement both themes with tokens;
status glyph/word comes from `STATUS_PRESENTATION`, not these literal examples.
Register commands in `KeyboardMap`; popovers use `Menu`. Preserve drafts and focus on
recoverable errors, direct focus to the invalid field, and return menu focus to its
trigger. Announce transitions and terminal results through the shared region, never
streaming output. Show check pass/fail/blocked/not-run as evidence labels, not extra
run statuses. Keyboard, short-window scrolling and screen-reader behavior require
later rendered tests; these text frames do not establish them.
