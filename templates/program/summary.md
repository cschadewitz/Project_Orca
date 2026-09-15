---
id: program/summary
name: Program - final summary
requires: [decomposition]
---
Summarise the program for the requester. Use the dispatch results below; for each work item state whether it was delivered, link the PR from its deploy report if present, and list open follow-ups.

## Request

**{{ request.title }}**

## Work items

{{#each vars.dispatched as d}}
- `{{ d.slug }}`: {{ d.status }}{{#if d.runId}} (run {{ d.runId }}){{/if}}
{{/each}}

## Decomposition rationale

{{ artifacts.decomposition.data.rationale }}

## Output

`summary.md` with front matter `status: done` and a body suitable to paste into the originating issue.
