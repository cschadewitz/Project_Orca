---
id: partials/upstream-context
name: Upstream work items this item depends on
---
{{#if vars.upstream}}
## Upstream work this item depends on

{{#each vars.upstream as u}}
- `{{ u.slug }}` ({{ u.status }}; {{ u.type }}{{#if u.stage}} @{{ u.stage }}{{/if}}{{#if u.requiredBy}}, required by {{ u.requiredBy }}{{/if}}): {{ u.title }}
{{#each keys(u.artifacts) as k}}
  - {{ k }}: `{{ u.artifacts[k].path }}`
{{/each}}
{{/each}}

Read the upstream artifacts above before designing or building; do not re-implement what they deliver.
{{/if}}
