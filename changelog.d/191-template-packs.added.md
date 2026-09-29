- **core:** Template packs. `TemplateRegistry.get(id, { pack })` tries `<pack>/<id>` and falls
  back to `<id>`, so a pack overriding one template inherits the rest; an agent step renders
  from the run's `overrides.templatePack`. `templates/strict/` ships an example pack with a
  stricter `sdlc/review`, loaded by the default `templates` glob.
- **cli:** `orca validate --template-pack <name>` reports which templates the pack overrides
  and which the validated workflows inherit, and fails with `TEMPLATE_NOT_FOUND` on a pack that
  overrides nothing; `orca run`/`submit`/`plan dispatch --template-pack` refuse such a pack
  the same way.
