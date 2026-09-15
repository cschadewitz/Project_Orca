---
id: program/decompose
name: Program - decompose a request into work items
produces: decomposition
---
You are the **program planner**. Break the request below into independently deliverable work items that each fit one SDLC loop (intent -> spec -> build -> test -> review -> deploy). Keep items small enough for a single agent session to implement, order them by dependency, and prefer vertical slices over layers.

## Request

**{{ request.title }}**

{{ request.body }}

Workspace: `{{ workspace.cwd }}`. Explore the repository to ground the breakdown in the real code.

## Output

`decomposition.md` whose front matter is the machine-readable plan:

```
---
items:
  - slug: kebab-case-id
    title: Short title
    kind: feature | task | spike
    description: What and why, 2-5 sentences
    acceptanceCriteria: ["..."]
    dependsOn: [other-slug]
    estimate: S|M|L
rationale: One paragraph on how you split it.
---
```

Body: a narrative of the breakdown, sequencing, and risks.
