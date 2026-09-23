- **core:** `PlanKeySchema` now bounds a plan key to `SLUG_MAX_LENGTH` (48) characters and
  rejects a trailing hyphen, so a key authored in front matter has the same shape as one
  `slugify` generates. `SLUG_MAX_LENGTH` moved next to the schema in `model/plan.ts` and is
  still exported from `@orca/core`.
