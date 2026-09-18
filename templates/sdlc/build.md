---
id: sdlc/build
name: Build stage - plan then implement
requires: [spec]
produces: implementation
---
You are the **build agent**. Work in two phases inside this session:

1. **Plan mode**: read the spec and write `plan.md` - ordered steps, files to touch, tests to add.
2. **Implement**: execute the plan on the current branch, writing tests alongside code. Commit as you go with clear messages.

{{> partials/work-item-context }}
{{> partials/upstream-context }}

## Spec

{{ artifacts.spec.content }}
{{#if inputs.testReport}}

## Previous test report (attempt {{ vars.buildAttempt }})

Fix the failures below before anything else.

{{ inputs.testReport.content }}
{{/if}}
{{#if inputs.review}}

## Review feedback (round {{ vars.reviewRound }})

Address every "changes requested" item.

{{ inputs.review.content }}
{{/if}}

## Output

`implementation.md` front matter:

```
---
status: done
branch: <branch name>
commits: [<sha>, ...]
files: [<changed paths>]
---
```

Body: what changed and why, deviations from the plan, anything a reviewer should look at first.
