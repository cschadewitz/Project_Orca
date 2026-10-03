# Guided launch and first-run consumer

Proposed #334 behavior, built on the [#424 experience specification](../cal-first-job-experience/interaction-spec.md).
This is not evidence of a completed UI or a working Cal connection.

## Smallest first-beta path

The product cohort is two semi-technical Apple Silicon Mac users on M3–M5 and
up-to-date macOS, using normal DMG/app setup; two Windows developers follow as
the second cohort. These are product targets, not a tested compatibility claim.
An assisting agent may help, but the user must not need one or a contributor
checkout/terminal to complete ordinary setup.

#386 owns native first-run, Finder PATH/tool/architecture discovery, dedicated
project selection, local-daemon explanation and explicit agent setup guidance.
It calls the same configuration/launch surfaces, rather than copying them. A
harmless sample is available before paid/provider authentication; a real local
agent requires separately authorized execution and preflight. No silent install,
credential capture, standing permission grant or unrelated-file inspection.

The recommended first useful job is one fixed, reviewed `start → agent → end`
workflow with a declared task input, configured supported agent/model/instructions
and verified disposable checkout. It is Request-free: no decomposition, Request
or work-item record is invented just to run one agent. A workflow is still
required; this is not a persistent chat session. #420 owns the actual harmless
sample and result evidence. The preset identity is unresolved D2, not a fabricated
workflow named in this packet.

Broader Request mode is a separate explicit choice. Do not make fleet, Docker,
canvas, persistent chat or a new template editor prerequisites for one local job.
Neither mode promises token cost, percentage complete, ETA or automatic PR
publication. Existing loaded instructions can be used without #355 completion.

## Review and submission

1. Pick the verified target/workspace via #318. Read supported methods and current
   capabilities through the existing connection owner. A read-only/store target
   cannot launch. No credential/connection implementation in the launch component.
2. Select direct workflow or Request. Render the selected workflow's typed input
   declarations, preserving absence and declared defaults. Unknown declarations
   are unsupported with explanation unless the accepted validator defines their
   handling. Do not infer provider keys or coerce numbers/booleans by truthiness.
3. Expose only selectors accepted by that entry point. At pinned main direct
   `RunsStartParams` has no `overrides`; fixed effective agent/model/template
   choices may be shown, but do not claim a writable override. Request override
   UI must map to actual `SubmissionCommand.overrides` and authorized selection
   data. Never disguise an unsupported selector inside arbitrary `vars`.
4. Preflight is side-effect-free. Bind workflow ID/version/content revision,
   active generation, input draft and target into one review. A sequential
   `config.get` plus typed validation is not proof of a coherent snapshot: the
   integrator must supply the accepted coherent projection or guarded assembly
   and prove stale refusal. Do not use raw config as an operator projection.
5. Show exact target, effective selections/provenance, input names and permitted
   local values, withheld sensitive values and capability limitations. Show the
   configured checkout only after D1 evidence exists. A URL, workspace ID or
   config root string alone does not prove actual repo/branch/base/cwd.
6. Explicit submission freezes the reviewed command and allocates one client
   intent/key through the accepted #331 controller. Disable repeated clicks
   synchronously. Server admission checks current auth and all guarded identities;
   preflight never authorizes later mutation.
7. Navigate only from the actual persistent receipt. Preserve operation,
   admission, Request and run identities distinctly. Accepted is not completed;
   `prepared`, `in-progress`, `recoverable-failure` and unavailable recovery remain
   visible. Terminal success still needs artifact/check evidence for the task.

## Recovery and interruption

- Repeated click, response loss, reconnect and app restart recover the same intent
  through #331's existing retry/inspect/reconcile boundary. Do not build a second
  ledger, generate a new key on timeout, or recapture changed defaults for a retry.
- Explicit new work creates a new intent. Same key with changed command is a
  conflict; it is not a request to run the revised input.
- Target change invalidates review and freezes unsent draft/ambiguous submission
  under its original target. Returning requires identity/current-authority review.
  A stale async result cannot select a run in the new target.
- Close, Cancel, Back and Escape before submit create no work and restore focus.
  Closing after sending is not cancellation of an admitted run. Show recovery of
  the pending intent; any run cancellation is a separate explicit supported action.
- Do not serialize launch inputs/task text in ordinary preferences or a URL to
  survive restart. Integrator must agree a protected intent/reference design and
  prove cross-restart recovery. Until then, restart acceptance is blocked.
- Startup continuation guarantees come from the accepted runtime, not a UI timer.
  No lease stealing, unconditional resume, automatic retry of external effects,
  invented `runs.retry` or resurrection of dead live callbacks.

## Unresolved D1–D3 and owner decisions

| Decision | Smallest recommendation | Owner / evidence needed |
| --- | --- | --- |
| D1 exact checkout | An explicitly prepared disposable checkout fixed by target config; no per-launch arbitrary path/worktree picker | #334 with #327 projection owner/integrator: authorized observation of intended repo/cwd/branch/base, exact freshness binding and stale refusal. New projection fields/schema require coordinated approval. Until then verified-checkout launch is blocked. |
| D2 workflow asset | One reviewed fixed direct workflow, typed task input, diff/check/risk result contract | #334/#420: real registered ID, version/digest, agent/instruction mapping and provenance/omission rules. Synthetic transcript is not execution evidence. |
| D3 publication | Return result with publication unavailable | #334/#327 and #350 if later selected: separately authorized publisher and verified outcome, never a new arbitrary shell MCP tool. |
| Protected restart recovery | Persist only necessary intent correlation via an approved protected boundary | #334/#331 integrator: exact retention, current-principal binding, refusal on absent/corrupt state and cross-restart tests; no renderer secret cache. |

#386 consumes a launcher blocked/unavailable reason and links to the existing
configuration/connection surface. Diagnostics #416 integrates through its own
owner; declining diagnostic export must not block setup. Native packaged and
physical checks remain #385/#388/#390, separate from source-only fixtures.
