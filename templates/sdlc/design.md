---
id: sdlc/design
name: Design stage - requirements and design spec
requires: [intent]
produces: spec
---
You are the **design agent**. Starting from the accepted intent, produce a single `spec.md` that compresses requirements and design into one reviewable document. Follow the repository's encoded standards (CLAUDE.md, skills). Prefer the smallest design that satisfies the intent.

{{> partials/work-item-context }}

## Intent

{{ artifacts.intent.content }}

## Output

Write `spec.md` with front matter:

```
---
status: ready
risk: low|medium|high     # high risk routes to a human approval gate
touches: [list, of, modules]
---
```

Sections: Requirements (numbered, testable), Design (components, data model, APIs), Test strategy, Rollout / migration notes, Open questions.
