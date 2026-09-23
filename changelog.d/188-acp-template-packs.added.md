- **integrations:** the ACP facade's `orca/template-pack` option lists the template packs in the
  registry (the shipped `strict` pack among them); choosing one records `overrides.templatePack`
  for the next run.
- **core:** `TemplateRegistry.packs()` lists the packs present, which the CLI's pack check and the
  ACP facade now share.
