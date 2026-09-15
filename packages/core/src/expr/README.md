# ORCA expression language

Used for edge conditions (`when:`), decision sources, loop conditions and
`{{ ... }}` interpolations in prompt templates. It is deliberately tiny and
sandboxed (no assignment, no prototype access, whitelisted functions only).

```
choice == 'approve'
artifacts.review.data.verdict != 'changes-requested' && iteration < 3
len(vars.failures) > 0 or steps.build.result.data.testsPassed
item.kind in ['feature', 'task']
artifacts.spec.data.risk matches '^(high|critical)$'
exists(artifacts.plan) ? 'ready' : 'blocked'
```

Operators: `== != < <= > >= + - * / % && || ! and or not in contains matches startsWith endsWith ?:`

Functions: `len exists empty default str num bool lower upper trim json keys values first last join count pluck all any min max range`

Context available to expressions is documented in `docs/DATA-MODEL.md`
(`vars`, `artifacts`, `steps`, `choice`, `iteration`, `item`, `run`, `workItem`, `request`, `workspace`).
