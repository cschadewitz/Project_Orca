---
id: partials/work-item-context
name: Work item context block
---
{{#if request}}
## Request

**{{ request.title }}**

{{ request.body }}
{{/if}}
{{#if workItem}}
## Work item: {{ workItem.title }} (`{{ workItem.slug }}`)

{{ workItem.description }}
{{#if workItem.acceptanceCriteria}}

Acceptance criteria:
{{#each workItem.acceptanceCriteria as c}}
- {{ c }}
{{/each}}
{{/if}}
{{/if}}

Workspace: `{{ workspace.cwd }}`{{#if workspace.branch}} on branch `{{ workspace.branch }}`{{/if}}.
Read the repository's CLAUDE.md / AGENTS.md and any skills before acting; they encode the team's standards.
