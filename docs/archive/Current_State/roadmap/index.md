# Prioritized improvement roadmap

Prioritize **ownership and recovery guarantees**, then contract/convergence maintenance, then evidence-driven storage and diagnostic improvements. Preserve the existing schema, lease-fencing, artifact and UI-primitive boundaries. The [assessment](assessment.md) explains this judgment; [task specifications](recommendations.md) give source evidence, impact, alternatives and acceptance criteria for every recommendation.

This roadmap is a proposal at revision `09f32690ffca5d9c79f6d8702481f6efe30a4cf3`, not a commitment to schedules or a list of implemented fixes. “Near”, “medium” and “longer” express sequencing. Effort is approximate S/M/L, never elapsed-time estimates. P1 means resolve before relying on an affected guarantee, P2 means the next maintenance cycle, and P3 means localized clarity work. No emergency or demonstrated production failure is asserted.

## Near term

First make the current guarantees legible. Then address the narrow permission and workspace boundaries and decide who owns semantic plan mutations and live-store observation. Design choices for R04/R05 should happen together; implementation can follow in slices. Start the separate verification work only with execution authorization.

### Documentation corrections

| Order | Task | Priority / approximate effort | Outcome | Depends on |
| --- | --- | --- | --- | --- |
| 1 | [R02: recovery and trust guarantees](recommendations.md#r02) | P1 / S–M | Ownership/consistency table; workflow lookup, policy failure and config activation described accurately | None; revisited after implementation decisions |
| 2 | [R01: current capability ledger](recommendations.md#r01) | P2 / S | Resolve D01/D02/D04/D17; separate implemented, released, partial and future | None |
| 3 | [R03: contributor contracts](recommendations.md#r03) | P2 / S–M | Correct commands, module formats, IDs, notification and shortcut language; narrow reference checks | Destructive-option intent decision |

These are future edits to existing documentation. This review has left those files unchanged. D13 concerns an executable prompt asset, so its correction belongs with R14 rather than being hidden as a harmless prose edit.

### Implementation and design work

| Order | Task | Priority / approximate effort | Outcome | Depends on |
| --- | --- | --- | --- | --- |
| 1 | [R07: permission-policy failure behavior](recommendations.md#r07) | P1 / M | An unreadable overlay has an explicit conservative result | R02 intent; H01 verification |
| 2 | [R06: shared-workspace ownership](recommendations.md#r06) | P1 / M | Local checkout concurrency is refused or queued under a defined ownership policy | Ownership conventions; no database work |
| 3 | [R18: supported daemon trust boundary](recommendations.md#r18) | P1 for remote/multi-user; otherwise P2 / M | Deliberate bind/access policy matching raw-config and control privileges | R02; R10 if contract changes |
| 4 | [R04: plan operation ownership](recommendations.md#r04) | P1 / L | Decide semantic serialization and recovery unit; implement incrementally | R02; shared decision with R05 |
| 5 | [R05: observable writers and convergence](recommendations.md#r05) | P1 / M–L | Decide central-writer versus durable-change/reconciliation model | R04 ownership decision; R10 for wire changes |

### Separate verification and release gates

| Task | Priority / approximate effort | Gate |
| --- | --- | --- |
| [R16: bounded runtime review](recommendations.md#r16) | P1 trust/ownership, P2 integration/scale / M–L by scenario | Requires later authorization to execute; [H01–H03 / V01–V08](future-verification.md) are the initial queue |
| [R15: release provenance/platform evidence](recommendations.md#r15) | P1 before broader distribution, otherwise P2 / M–L | Required before claiming assurance for the intended shipping/update channel; preserve existing draft/admission/owned-daemon safeguards |

## Medium term

Complete R04/R05 as the first cross-component implementation work, then use their ownership and revision contracts to simplify downstream consumers. Other work can proceed independently where dependencies permit.

| Order | Task | Priority / approximate effort | Outcome | Depends on |
| --- | --- | --- | --- | --- |
| 1 | [R10: method contract manifest/parity](recommendations.md#r10) | P2 / M | Reduce repetitive schema/IPC/capability maintenance without widening preload authority | Coordinate R05 wire changes |
| 2 | [R09: lifecycle settlement owner](recommendations.md#r09) | P2 / M | Entry-point-independent Request projection, if H03 confirms the need | H03 trace; no speculative API redesign |
| 3 | [R08: execution recipe identity](recommendations.md#r08) | P2 / M–L | Explain same-version edits, template/config selection and resume provenance | R02; compatibility decision with R15 |
| 4 | [R11: renderer reconciliation](recommendations.md#r11) | P2 / M | Uniform gap recovery with surface-specific semantics and preserved drafts | R05 contract; R03 terminology |
| 5 | [R14: extension/prompt contracts](recommendations.md#r14) | P2 / M | Plugin preflight/capability metadata; accurate executable prompt promises | R08 identity; R10 when advertised over wire |
| 6 | [R13: focused coordinator extraction](recommendations.md#r13) | P2 / M per slice | Isolate one lifecycle responsibility at a time | R04/R09 decisions for the affected paths |

R13 is intentionally sequenced after ownership decisions: moving code before deciding who owns state would preserve the same ambiguity across more files. R10 can proceed earlier where it is limited to parity/type checks, and D13's prompt qualification can be a small early R14 slice.

## Longer term

| Task | Priority / approximate effort | Outcome | Depends on |
| --- | --- | --- | --- |
| [R12: bounded store growth and lifecycle](recommendations.md#r12) | P2 / L | Measured read budgets, repairable indexes and explicit archival/cleanup policy | R04/R08 authority/provenance; V08 measurements |
| [R17: joined lifecycle diagnostics](recommendations.md#r17) | P2 / M | Correlate existing IDs, operations, revisions and failures without a new telemetry platform by default | R04/R05/R09 identities |

“Longer term” is not a claim these are low-value. They need evidence and ownership inputs to avoid premature indexes, unsafe cleanup or a diagnostic schema that encodes the wrong authority. If current operational measurements reveal a constraint sooner, resequence using that evidence.

## Critical sequencing and decision gates

1. **R02 → R04/R05 decision:** is the supported active store single-writer through a daemon, or are multiple semantic writers a requirement? This determines operation locks, durable revisions and CLI routing. Do not decide storage technology first.
2. **R05 + R10 → R11:** define server convergence and wire shape before making every UI hook invent recovery.
3. **H03 → R09 → R13:** establish the lifecycle parity need, select its owner, then extract code around that owner.
4. **R08 + R04 + V08 → R12:** know authoritative references and measured costs before retention or compaction can remove anything.
5. **R02 + V06 → R15 release gate:** shipping assurance requires actual artifact/platform evidence, not just declared CI configuration.

R07, R06 and R18 are independently useful safeguards within the existing architecture. They do not need to wait for a transactional store or a new UI data framework.

## What this roadmap does not schedule

The review does not promote explicitly future-facing workflow editing, autonomous Maintain, capacity allocation, T3 transport completion or multi-tenant hosting into required work. Those are product decisions with separate scope. It also does not prescribe SQLite, a distributed event bus, an all-purpose frontend store or an observability vendor. The recommendations name the guarantees to achieve and the alternatives to consider.

## Completion criteria for the roadmap as a work queue

Every accepted task should become a separate implementation/documentation issue with its source links, chosen alternative and acceptance criteria preserved. Close documentation differences only after the intended guarantee is explicit. Mark runtime questions resolved only with reproducible evidence. Keep this review tied to its recorded commit; future changes should use an addendum or a new review directory instead of rewriting its frozen baseline.
