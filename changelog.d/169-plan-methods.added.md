- **protocol:** the plan surface, at protocol 1.7. Nine reads under the `plan.read`
  capability — `plans.list`, `plan.get`, `items.list`, `schedule.get`, `schedule.explain`,
  `dependencies.list`, `risks.list`, `decisions.list`, `journal.list` — five writes under
  `plan.write` — `dependencies.waive`, `decisions.decide`, `decisions.reopen`,
  `risks.update`, `claims.release` — and a `plan.changed` notification carrying which kinds
  of thing moved. Nothing in the new views carries a date estimate.
- **daemon:** `orca serve` answers all fourteen over `PlanService`. A plan read is one
  snapshot and one schedule per call, so an item arrives with the scheduler's classification,
  its priority score and reasons, its risk exposure and the run holding its claim at once; a
  `schedule.explain` returns `orca plan explain`'s lines word for word rather than a
  paraphrase. The writes journal with `origin: { kind: "human", actor: "daemon" }`.
  `orca serve --read-only` omits all five, from the dispatch table and from `hello.methods`.
- **daemon/cli:** `claims.release` over the wire — the daemon half of `orca claims release`
  (#88). Refused while the owning run could still resume unless `force`, and it answers with
  the same "still in-progress" note the CLI prints.
- **app:** `window.orca.plan` and `window.orca.claims.release` on the preload bridge, so the
  Plan surface (#170) and the palette's write actions (#178) have something to call.
