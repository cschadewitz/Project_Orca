---
id: program/summary
name: Program - final summary
requires: [decomposition]
---
Summarise the program for the requester. Use the dispatch results below; for each work item state whether it was delivered, link the PR from its deploy report if present, and list open follow-ups. Call out work that was deferred (waiting on another request, an external, or held for risk) and what would unblock it.

## Request

**{{ request.title }}**

## Work items

{{#each vars.dispatched as d}}
- `{{ d.slug }}`: {{ d.status }}{{#if d.runId}} (run {{ d.runId }}){{/if}}{{#if d.reason}} - {{ d.reason }}{{/if}}
{{/each}}

Dispatch outcome: {{ vars.dispatchOutcome }}
{{#if vars.schedule}}

## Plan status when dispatch started

- Critical path: {{ join(vars.schedule.criticalPath, " -> ") }}
- Open risks: {{ vars.schedule.risk.open }} (highest: {{ vars.schedule.risk.highestLevel }})
{{#if vars.schedule.openDecisions}}
- Open decisions: {{ join(pluck(vars.schedule.openDecisions, "key"), ", ") }}
{{/if}}
{{/if}}
{{#if artifacts.riskRegister}}

## Risk register

{{ artifacts.riskRegister.data.summary }}
{{/if}}

## Decomposition rationale

{{ artifacts.decomposition.data.rationale }}

## Output

`summary.md` with front matter `status: done` and a body suitable to paste into the originating issue.
