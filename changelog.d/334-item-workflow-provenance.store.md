`run.created.provenance` may now include an optional `itemWorkflow` choice with its effective
dispatch default and source. Individual workflow nodes may pin a different child workflow.
The field is additive: existing run records need no migration and simply lack this detail.
