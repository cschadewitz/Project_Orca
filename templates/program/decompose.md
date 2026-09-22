---
id: program/decompose
name: Program - decompose a request into work items
produces: decomposition
---
You are the **program planner**. Break the request below into independently deliverable work items that each fit one SDLC loop (intent -> spec -> build -> test -> review -> deploy). Keep items small enough for a single agent session to implement, order them by dependency, and prefer vertical slices over layers.

ORCA tracks this request in a **long-term plan** together with earlier requests. Reuse slugs of existing work when you depend on it; be explicit about ordering, risk and the decisions that must be made before some work can start.

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
    priority: critical | high | normal | low
    estimate: XS | S | M | L | XL
    dependsOn:                      # see grammar below
      - other-slug                  # hard: wait until other-slug is done
      - other-slug@spec             # stage-level: start once other-slug has a spec
      - other-slug#build            # phase: may start now, but wait for other-slug before *building*
      - soft:other-slug             # preferred order only, never blocks
      - informs:other-slug@spec     # hand other-slug's spec to this item's agents
      - decision:storage-engine     # blocked until the decision below is made
      - external:vendor-contract    # something outside ORCA a human will confirm
    risks: [risk-key]               # keys from `risks` below this item is exposed to
risks:                              # what could go wrong across the breakdown
  - key: kebab-case
    title: Short statement
    category: technical | schedule | security | dependency | operational | product | compliance
    likelihood: 1-{{ riskMatrix.scale }}
    impact: 1-{{ riskMatrix.scale }}
    mitigation: What reduces it
    affects: [slugs]
    mitigatedBy: [slugs]            # items whose delivery reduces the risk
decisions:                          # choices that must be made before some items can start
  - key: kebab-case
    title: Short question
    question: One paragraph of context
    options: [{ key: a, name: Option A }, { key: b, name: Option B }]
    blocks: [slugs]                 # items that must wait for the decision
rationale: One paragraph on how you split it.
---
```

Body: a narrative of the breakdown, sequencing, risks and open decisions.
