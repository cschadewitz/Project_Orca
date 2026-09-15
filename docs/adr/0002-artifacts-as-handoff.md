# ADR 0002 — Artifacts are the only hand‑off medium

**Status:** accepted

## Context
The AI‑native SDLC playbook advances work through committed artifacts (intent.md → spec.md →
PR → …). Forwarding chat transcripts between agents is lossy, expensive and unreviewable.

## Decision
A step's outputs are files with YAML front matter, declared in `produces:` with a path
template and validation rules. ORCA appends a machine‑readable **deliverables block** to
every prompt, collects the files from the agent's host after the turn, validates front
matter, stores them content‑addressed with provenance, and renders the *next* prompt from
`template ⊕ artifacts`. Decisions read front‑matter fields.

## Consequences
+ Every hand‑off is a diffable file in the workspace; humans can edit it between steps.
+ Works with any agent (no tool‑calling contract needed) and over SSH (files are read back).
− Agents must be told what to write; templates carry that burden (and follow‑ups repair it).
