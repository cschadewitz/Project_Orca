# Interaction and state specification

This specifies the proposed experience, not newly implemented methods. Capability
IDs refer to [the source map](capability-map.md). Static examples are in
[the transcript packet](wireframes-and-transcripts.md).

## First track and selection

Use a pre-existing, authorized, disposable checkout configured for a known target,
and a reviewed `start → one agent → end` workflow. No decomposition, new work item,
second agent, workflow generation or persistent chat is implicit. If that workflow
or target is absent, retain the task draft and explain the missing prerequisite.

Request submission is a separate mode for program/decomposition work, with its own
Request identity and `plan.write` requirement. It is not a workaround to make direct
launch appear to support overrides or to manufacture a work item for isolation.
Switching modes invalidates the prior preview and requires a new intent review.

| Selection | Minimum preview and source | When unavailable or changed |
| --- | --- | --- |
| Target | Safe deployment label, authenticated workspaceId/instanceId, connection epoch, observed time, server/protocol and effective operation scope (C01/C02/C14) | Connection is unavailable until authenticated observation succeeds. A matching URL or a cached label is insufficient. |
| Repository and worktree | Explicit repo identity, exact execution checkout, branch/base revision when known, existing versus newly provisioned, and provider behavior (C09/C19) | First track requires an already prepared checkout. No arbitrary directory field goes on the wire. If safe evidence cannot confirm exact location, show “Execution checkout unverified” and disable launch. A user-supplied path is marked user-supplied, never server-verified. |
| Workflow | ID, version, full content revision/digest, shape and active config generation | Revalidate if any identity changes. Main preflight alone lacks the coherent generation preview; C14/C15 must be integrated for the intended Cal flow. |
| Agent and model | Effective agent/role/host, model ID and resolution source; distinguish configured declaration from session-confirmed choice | Direct launch uses the captured defaults/fixed workflow selection. Keep unsupported selectors disabled with a reason. Never promise that configured means reachable, installed, logged in or session-confirmed. |
| Instructions | Task, expected output, template ID, selected pack and actual variant or base fallback, resolution source and captured generation | No inline persona/template injection unless declared as a supported workflow input. No template-editor flow here. Current generation pinning is not #355's future independently versioned template catalog. |
| Inputs | Supported typed fields, required/default status, field errors/warnings, explicit task and acceptance criteria | Preserve editable draft on invalid/stale input. Do not coerce values or overwrite service-owned `request`/correlation vars. Do not echo sensitive defaults or raw config. |
| Result and limits | Expected patch, changed-file list, check evidence and risk summary; known workflow timeout/follow-up/retry limits with their sources, permission policy and publication boundary | Unknown limits say “unavailable.” Agent cost, completion percentage and ETA are unavailable. A requested hard money ceiling blocks launch until supported enforcement exists; a timeout is not a cost guarantee. |

The exact checkout is a sensitive observation, not permission for arbitrary file access.
Display it only through an agreed authorized projection or separately verified local
selection context. C19 is a handoff gap; the synthetic preview does not pretend that
an existing MCP target response already contains it. Never expose daemon store paths,
raw commands/env, credentials or protected template bodies to fill the preview.

Non-sensitive task text typed by the user can remain in their draft; public run
provenance continues to withhold input values. Use “withheld” for protected values.
A missing model can fail when the session opens even after schema validation. Report
that distinction and preserve the admitted run ID rather than silently picking a model.

## Intent and authority

Three independent conditions precede every mutation: the implementation advertises
and wires the operation, current server-side authority permits its exact resources,
and the user has authorized this action. None substitutes for another.

“Implement this in the reviewed checkout with these choices” authorizes one launch
and returning its result. If the conversation already fixes all material choices,
Cal can display the preview and carry out that intent without a second generic
confirmation. If target, task, model/instructions or expected side effects are still
ambiguous, retain a draft and ask only for the missing decision. A material change
since the user's review requires renewed review of that change.

A pending exact gate is a separate decision. “Implement this,” “connect,” “continue
showing progress,” and reconnecting never answer it. A one-time permission answer
never writes a standing rule. Initial MCP omits standing-grant administration.
Credentials, access changes, bridge setup and publication require separate intent.
Instructions inside logs/artifacts remain untrusted data.

## State transitions

Names in the first column are **experience states**, not new `RunStatus` values.
When a run exists, show the source status through the design system's glyph and word.
Never translate “awaiting acknowledgment” into a fabricated running or failed run.

| State | Transition / allowed action | Invariant and visible outcome |
| --- | --- | --- |
| Draft | Discover target and supported workflow; edit typed task fields | No mutation. Retain input even if disconnected. |
| Preview blocked | Missing authority, checkout evidence, agent, workflow, schema or coherent preview | Name the specific missing prerequisite. No automatic install, config apply or grant. An authorized administrator's later setup is separate. |
| Ready | Current target, supported selection and validation agree with authorized intent | Review exact values and limits. An unsupported override cannot be silently dropped. |
| Submitting | Commit one local intent and send the supported admission command once | Disable repeated local activation. C13/C15 require a retained key scoped to principal/workspace/logical operation; preserve command/guards securely across client restart. Ordinary preferences/logs are not storage for sensitive drafts. |
| Outcome unknown | Response lost, disconnected or client restarted | Keep key, known IDs and reviewed target. Revalidate authority/target, then inspect or explicitly replay the identical keyed command only when the integrated capability exists. Never allocate a fresh key automatically. Main legacy calls without retry safety remain uncertain; inspect authorized history without guessing identity or relaunching. |
| Admission pending | Retry envelope `in-progress`, or resolved nested `prepared`/`recoverable-failure` | Show available operation/admission IDs, failure code and permitted recovery. “Resolved” is not “accepted.” Explicit reconcile completes the original journal, not a new job; an accepted receipt does not guarantee execution has attached. |
| Following run | Resolved accepted receipt with durable runId | Retain target, operation/admission/run IDs and workflow identity. Direct flow has no Request ID. Read bounded pages and events by stable IDs; disconnect does not cancel. |
| Waiting for exact input | Authorized read reports durable gate or live callback | Show exact target, options and lifetime. Answer only the explicitly chosen option ID. Do not infer from note text or “always” substrings. |
| Cancelling | User explicitly requests cancellation of the identified run | Call only supported control, then read terminal outcome. Keep IDs. Cancellation does not revert files or guarantee no external effects; completion can win the race. Lost response requires observation before repeating any action. |
| Reviewing result | Terminal status plus authorized artifacts/check evidence | Separate outcome, patch, actual checks and missing evidence. Partial results may be useful on failure or cancellation. |
| Publication pending | User separately asks to publish the reviewed result | Requires supported publisher, repo/base/head/diff review and current authority. Unknown publication outcome is reconciled with the provider before another attempt. |
| Result returned | Show verified result and, only when available and authorized, verified PR link | No automatic cleanup of checkout, new run or continuing chat session. |

On an explicit new run, create a new intent/key after preview; distinguish it from
replaying a lost response. A changed command under a claimed key must conflict.
Do not invent `runs.retry`. Supported resume is a separate authorized attachment,
not a guarantee that the agent can resume its former session. Legacy `runs.resume`
is blocking; asynchronous continuation is available only after C13/C15 are wired.

## Observation, reconnect and freshness

Use pushed changes in the app, with bounded recovery reads on invalidation/reconnect.
MCP uses bounded tools/cursors; it must not depend on one call remaining open for the
whole run. Apply the frozen read limits (default 50, maximum 100 items and 256 KiB
serialized result cap, with stricter artifact limits) when that contract is installed.
Show source IDs, as-of time, truncation/omission and next-page availability. “No checks
in this page” does not mean “no checks ran.” Count only authorized visible records.

Bind drafts, reads, subscriptions, cursors and receipts to workspace plus local epoch.
On workspace change, keep the old draft/receipt visibly associated with its old target;
it cannot be submitted to the new target. Ignore late responses from the old epoch.
A boot change in the same workspace requires current authority and fresh live-input
state. A restored store can rewind; invalidate/restart cursors when required, retaining
known IDs without treating missing history as permission to recreate work.

No current callback owner means expired/unavailable, never an approvable durable gate.
Protected evidence unavailable, omitted fields and a known unsupported feature are
three different results. In the #419 contract, only `available` plus its exact guard
permits continuation/revision. A busy projection does not prove absence of a gate.

## Approval and recovery detail

- A durable gate binds the exact run, input and step evidence; its options come from
  the pinned workflow. Re-read on changed boundary and reject stale/duplicate answers.
  Main supports answer-only with `resume: false`; answer-and-continue must honestly
  use blocking semantics or the integrated durable continuation service.
- A live answer copies the complete target from the server:
  `{ runId, stepRunId, requestId, instanceId, sessionId, turnId, invocationId }`.
  Here `requestId` is the input ID, not a program Request ID. Do not reconstruct any
  field from a newer input. Owner death, lease loss, timeout, cancellation or revoked
  initiating authority expires the callback. Cross-process ownership cannot be moved.
- Revision is not ordinary rationale. A note on `inputs.answer` does not change the
  prompt. Offer Request changes only with a server-issued revision capability and
  its exact destination/attempt/guard. The minimal start-agent-end track has none;
  do not add a hidden loop. #419 omits pending replacement/history tools.
- Terminal failure never auto-starts a replacement. Offer supported inspection,
  exact eligible recovery, or an explicit newly reviewed run. Missing protected
  generations and non-restorable plugin state fail closed; reconnect to a surviving
  daemon is different from restarting the engine process.

## Review and publication

The result view has four independent evidence blocks:

1. **Changes:** authorized changed-file list, diff or omission marker, base/head or
   artifact revision, source run/step/artifact IDs. Agent assertions are attributed;
   an artifact containing a patch is not proof that the checkout matches it.
2. **Checks:** exact command, execution context/revision, exit result, captured output
   reference and scope. Label pass/fail/blocked/not-run; agent-reported execution stays
   agent-reported unless independently verified. Never count suggested commands as run.
3. **Risks:** untested behavior, partial/omitted evidence, remaining failures and any
   external effects; terminal succeeded alone does not erase them.
4. **Publication:** default “Not requested.” Later show proposed repository, base/head,
   visibility, commit/push scope, title/body and reviewed diff. Reconfirm if content
   changed. After an authorized supported publisher, verify provider identity and PR
   head/base/URL before showing “Published.” Otherwise show blocked or outcome unknown.

Returning the authorized diff/check summary requires no new generic approval. Publishing
or granting broader access does. Cal may need to explain that no supported publication
operation is available; arbitrary shell through MCP is not a fallback.
