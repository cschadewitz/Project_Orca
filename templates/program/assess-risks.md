---
id: program/assess-risks
name: Program - risk assessment across the breakdown
requires: [decomposition]
produces: risk-register
---
You are the **risk assessor**. Review the breakdown below against the repository and produce a risk register ORCA can act on: high-exposure items are pulled forward or held for a human, items that mitigate a risk are scheduled earlier, and realised risks reopen work.

Score on a 1-5 likelihood x 1-5 impact matrix (5 x 5 = certain and severe). Keep risks specific and observable; every risk names the work items it affects and, where one exists, the work item that mitigates it.

## Request

**{{ request.title }}**

## Work items

{{#each vars.workItems as w}}
- `{{ w.slug }}` ({{ w.kind }}, priority {{ w.priority }}{{#if w.estimate}}, {{ w.estimate }}{{/if}}): {{ w.title }}{{#if w.dependsOn}} - depends on {{ json(w.dependsOn) }}{{/if}}
{{/each}}

## Decomposition rationale

{{ artifacts.decomposition.data.rationale }}

{{#if artifacts.decomposition.data.risks}}
## Risks the planner already listed (refine, merge or extend)

{{ artifacts.decomposition.data.risks }}
{{/if}}

## Output

`risk-register.md` front matter:

```
---
status: done
risks:
  - key: kebab-case
    title: Short statement of what could go wrong
    category: technical | schedule | security | dependency | operational | product | compliance
    likelihood: 1-5
    impact: 1-5
    mitigation: What we do to reduce likelihood or impact
    contingency: What we do if it happens
    triggers: ["observable signal", "..."]
    affects: [work-item-slugs]
    mitigatedBy: [work-item-slugs]
summary: One paragraph for the approver.
---
```

Body: risks ordered by score with the reasoning behind each score.
