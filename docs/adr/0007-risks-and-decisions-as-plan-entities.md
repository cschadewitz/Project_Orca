# ADR 0007 — Risks and decisions are first‑class plan entities fed by artifacts and computed by ORCA

**Status:** accepted

## Context
Risk and architectural decisions were prose in specs. The orchestrator could not use them:
it could not hold a risky item for a human, pull de‑risking work forward, block an item on
an unmade decision, or say afterwards *why* an option was chosen. Asking agents to call a
planning API would break ADR 0002 (artifacts are the only hand‑off).

## Decision
- **Risk** records with likelihood x impact on a configurable matrix, a status lifecycle
  (`open → mitigating → mitigated | accepted | realized → closed`), `affects` and
  `mitigatedBy` links to work items. Exposure feeds the scheduler: items above the plan's
  **risk appetite** are held until a human accepts or the risk is mitigated; mitigating items
  are prioritised.
- **Decision** records with a weighted **decision matrix** (criteria with `weight` and
  `direction`, options with per‑criterion scores). ORCA evaluates the matrix (ranking,
  margin, confidence, pivotal criteria) so the arithmetic is reproducible; an explicit
  `chosen` overrides it and is recorded as such. Items depend on decisions like on other
  items (`decision:key`).
- Both are **lifted from artifact front matter** at record time (`risk-register`,
  `decision-matrix`, and `risks:` / `decisions:` / `dependencies:` on any artifact such as a
  spec), via pluggable signal extractors. Agents keep writing files; ORCA keeps the model.
- The program workflow gains `assess-risks` and a `decide` loop that fills a matrix per open
  decision before the schedule is computed and gated.

## Consequences
+ Gates get objective inputs (`vars.schedule.risk.highestLevel`, matrix `confidence`),
  so humans are asked only when it matters.
+ The dependency graph can express "not until we have decided X" and "not until legal signs
  off" without fake work items.
+ Decisions and risks are auditable: origin artifact, matrix result, who decided, journal.
− Scores are only as good as the agent's scoring; the matrix makes that visible rather than
  correct. Templates therefore ask for evidence per score and expose pivotal criteria.
− Front‑matter conventions grow; the deliverables block and templates document them.
