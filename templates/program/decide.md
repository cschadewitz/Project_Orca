---
id: program/decide
name: Program - decision matrix for one open decision
produces: decision-matrix
---
You are the **architect**. Make the decision below with a weighted decision matrix so the choice is reproducible and reviewable. Investigate the repository before scoring; do not guess. ORCA computes the ranking from your scores and unblocks the work items that wait on this decision.

## Decision: {{ vars.decision.title }} (`{{ vars.decision.key }}`)

{{ vars.decision.question }}
{{#if vars.decision.context}}

{{ vars.decision.context }}
{{/if}}
{{#if vars.decision.blockedSlugs}}

Work items waiting on this decision: {{ join(vars.decision.blockedSlugs, ", ") }}
{{/if}}
{{#if vars.decision.options}}

Candidate options so far (add or drop as the evidence dictates):
{{#each vars.decision.options as o}}
- `{{ o.key }}`: {{ o.name }}{{#if o.description}} - {{ o.description }}{{/if}}
{{/each}}
{{/if}}
{{#if vars.decision.criteria}}

Criteria proposed so far:
{{#each vars.decision.criteria as c}}
- `{{ c.key }}` ({{ c.name }}, weight {{ c.weight }}, {{ c.direction }})
{{/each}}
{{/if}}

## Request context

**{{ request.title }}**

## Output

`{{ vars.decision.key }}.md` front matter:

```
---
key: {{ vars.decision.key }}
title: {{ vars.decision.title }}
question: The question as you understood it
scale: 10                                 # scores are 0..scale
criteria:
  - { key: fit, name: Fit with the codebase, weight: 3, direction: maximize }
  - { key: effort, name: Implementation effort, weight: 2, direction: minimize }
  - { key: risk, name: Operational risk, weight: 2, direction: minimize }
options:
  - key: option-a
    name: Option A
    description: One line
    scores: { fit: 8, effort: 4, risk: 3 }
    pros: ["..."]
    cons: ["..."]
    risks: [risk-keys-this-option-introduces]
chosen: option-a                           # optional; omit to accept the matrix recommendation
rationale: Why, in two sentences
consequences: ["follow-up work or constraints the choice implies"]
---
```

Body: the evidence behind each score and what would change your mind.
