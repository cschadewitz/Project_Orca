- **engine:** a decision's `source: { kind: artifact }` (and `kind: agent`) reads `field` as
  a dotted path into the artifact's data, so `field: answers.conflict.choice` routes on a
  nested record such as a `custom:jev-eval` evaluation without an expression that names the
  producing node. An exact top-level key wins over a nested path, preserving literal dotted
  front-matter keys. A deliverable's `validate.requiredFields` and `validate.fieldValues`
  use the same rule.
