# ADR 0006 — The Plan is a persistent, cross‑request dependency graph; the scheduler evaluates it live

**Status:** accepted

## Context
The program workflow's `parallel` fan‑out ordered items by `dependsOn` slugs *within one request*. Real
programmes span requests: a feature from request B needs an API from request A, work must
wait for a decision nobody has made yet, or for a vendor. Agents also discover dependencies
mid‑flight (while designing). The orchestrator must keep handing work to agents in the right
order as that graph changes.

## Decision
Introduce a **Plan**: a long‑lived container that requests join. Work items get `planId`
and plan‑unique slugs; **Dependency** records (not slug strings) are the source of truth,
with three target kinds (work item + optional *stage*, decision, external), three types
(`blocks`, `soft`, `informs`) and a `requiredBy` phase. References to slugs that do not exist
yet become `external` placeholders bound automatically when the slug is registered.

Plan entities live in document stores plus an append‑only **journal** (`plans/<id>.jsonl`)
recording every change with its origin. Runs stay event‑sourced (ADR 0001); the plan is a
read model with an audit trail, because it outlives any run and is queried far more than it
is replayed.

The **scheduler** is a pure function over a snapshot. It evaluates dependencies *live*
(against item status, `produced` artifacts and decision status), classifies items as
ready / waiting (with the reason) / held (risk) / unschedulable, ranks ready items with
explainable factors, and reports waves and the critical path. `custom:plan-dispatch`
re‑schedules after every child completion **and** on every plan‑changing journal event
(work items, dependencies, decisions, risks; plus a poll every `pollMs`), so stage‑level
dependencies (`other@spec`) pipeline runs instead of waiting for a slot to free.

## Consequences
+ One request can depend on another's work; deferred items are picked up later by
  `plan-resume` without re‑decomposing.
+ Every "why is this not running?" has an answer (`orca plan explain`), and every change has
  a journal entry.
+ Dispatch never trusts a stale status: waivers, accepted risks and decisions take effect on
  the next scheduling pass.
− Two persistence shapes (event log for runs, documents + journal for the plan).
− The scheduler re‑reads the whole plan per pass; adequate for hundreds of items, not
  thousands (index later).
