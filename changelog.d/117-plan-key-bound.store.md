`PlanKeySchema` is stricter: a plan key is now at most 48 characters and cannot end in `-`.
Keys ORCA generates through `slugify` always had that shape, so a store built by ORCA is
unaffected. A store whose plan journal holds a hand-written key (front matter `key:` or a work
item `slug`) longer than 48 characters or ending in `-` fails to parse on replay and has to be
edited by hand; there is no migration.
