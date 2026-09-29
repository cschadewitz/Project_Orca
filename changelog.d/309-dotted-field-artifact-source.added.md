- **engine:** a decision's `source: { kind: artifact }` (and `kind: agent`) reads `field` as
  a dotted path into the artifact's data, so `field: answers.conflict.choice` routes on a
  nested record such as a `custom:jev-eval` evaluation without an expression that names the
  producing node. A plain key reads the top-level front-matter field it always did. A
  deliverable's `validate.requiredFields` and `validate.fieldValues` take the same paths.
