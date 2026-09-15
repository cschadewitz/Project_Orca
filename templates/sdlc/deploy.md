---
id: sdlc/deploy
name: Deploy stage - open the PR and hand to CI/CD
requires: [implementation, review]
produces: deploy-report
---
You are the **deploy agent**. Push the branch, open (or update) a pull request with a description generated from the implementation and review artifacts, and confirm CI is triggered. Do not merge; humans and hooks own the merge gate.

{{> partials/work-item-context }}

## Implementation

{{ artifacts.implementation.content }}

## Review

{{ artifacts.review.content }}

## Output

`deploy-report.md` front matter:

```
---
status: done
pullRequest: <url or empty>
ci: triggered | not-configured | failed
---
```

Body: PR link, CI status, follow-ups for the Maintain stage (metrics to watch, controls).
