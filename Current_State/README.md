# Project Orca current-state review

**Static architecture and maintainability review of `09f32690ffca5d9c79f6d8702481f6efe30a4cf3`, branch `casey/Review-Prompt`, dated 2026-09-29.** The initial working tree was clean; no pre-existing uncommitted implementation was included. All deliverables are under this directory. No application, build, test, migration, service or integration was run.

The review accounts for **all 13 workspace package manifests** (11 product/support packages and two tooling packages) and **55 package/component/system architecture views**. The source census maps 614 implementation, declaration, test and configuration assets. This is exhaustive at the stated package/major-component granularity, not an audit of every line, test branch, binary asset or external deployment. See [scope](baseline/scope.md), [coverage](baseline/coverage.md) and [quality/limitations](QUALITY.md).

**Read the [corrections addendum](addenda/corrections.md) with the baseline.** Source reinspection after the checkpoint corrected four statements: workflow version labels do not make same-version content immutable; the artifact RPC serves text or omission metadata, not an image view; blob paths are rooted under `artifacts/`; run variables are merged without a workflow-specific input validator. The frozen baseline has not been silently rewritten.

## Start here

| Purpose | Document |
| --- | --- |
| Understand the whole system | [System specification](architecture/system.md) · [System SVG](diagrams/svg/system.svg) · [Editable source](diagrams/source/system.json) |
| Navigate the independent investigation | [Baseline index](baseline/index.md) · [Coverage matrix](baseline/coverage.md) |
| Check its independence and preservation | [Scope/exposure record](baseline/scope.md) · [Checkpoint](BASELINE-CHECKPOINT.md) · [Checksum manifest](BASELINE-MANIFEST.sha256) |
| Understand behavior across packages | [Lifecycles](baseline/lifecycles.md) · [Data/contracts](baseline/data-contracts.md) · [Inputs/extensions](baseline/inputs-extensions.md) |
| Find a concept or source owner | [Glossary](baseline/glossary.md) · [Source ownership map](baseline/source-map.md) · [Dependency inventory](baseline/dependencies.md) |
| Assess engineering structure | [Engineering baseline](baseline/engineering.md) · [Test declarations](baseline/test-catalog.md) · [Assessment](roadmap/assessment.md) |
| Reconcile existing guidance | [17 documentation differences](comparison/differences.md) · [86-file documentation inventory](comparison/documentation-inventory.md) |
| Decide what to improve first | [Prioritized roadmap](roadmap/index.md) · [18 task specifications](roadmap/recommendations.md) |
| Plan separately authorized execution | [Uncertainties](baseline/uncertainties.md) · [Future verification and incidental hypotheses](roadmap/future-verification.md) |

## Architecture navigation

The [coverage matrix](baseline/coverage.md) links every specification to its SVG, editable JSON, source evidence and review status. A component is a cohesive lifecycle/service, persistence family, protocol boundary or UI surface family; individual files are not automatically components.

| Family | Package / supporting views |
| --- | --- |
| Domain and execution | [core](architecture/core.md), [store](architecture/store.md), [agents](architecture/agents.md), [engine](architecture/engine.md) |
| Client/server and entry points | [protocol](architecture/protocol.md), [daemon](architecture/daemon.md), [CLI](architecture/cli.md), [integrations](architecture/integrations.md) |
| Desktop and design | [app](architecture/app.md), [design](architecture/design.md) |
| Engineering infrastructure | [testing](architecture/testing.md), [lint tooling](architecture/tool-eslint.md), [font tooling](architecture/tool-fonts.md), [delivery](architecture/delivery.md), [workflow assets](architecture/workflow-assets.md) |
| Dependency views | [runtime package spine](architecture/runtime-packages.md), [adapter/build dependencies](architecture/adapter-packages.md) |

Diagrams share a [notation and legend](diagrams/notation.md). SVGs are standalone vector documents; JSON stores editable nodes, typed edges and claim-level evidence. Links in each diagram lead back to its specification. These are selected readable views, not full call graphs. Generation uses only the included standalone review tooling, not the project's build.

## Reading the findings

**Implemented** means directly supported by source; **inferred** states an interpretation with its reasoning; **declared** means schema/comment/test/configuration intent not fully traced; **unverified** means static inspection cannot establish it. No test-source citation means a test passed. Relative source links point to the reviewed checkout; baseline evidence also includes commit-pinned GitHub links. No original source file changed during the review.

The most consequential concerns are semantic plan ownership across writes/processes, observation of external writers and connection gaps, shared-checkout ownership, and precise permission/daemon trust boundaries. Workflow provenance and lifecycle settlement also need explicit contracts. The assessment preserves strengths: typed protocols, pure scheduling/projection, fenced run leases, artifact handoff, revision-aware drafts and shared UI primitives.

The roadmap separates documentation repairs, implementation changes and later runtime verification. It does not treat clearly labelled future proposals as current defects, and it does not assume the implementation is correct whenever documentation differs.

## Directory and preservation rules

- `baseline/`, `architecture/`, `diagrams/` and the initial `review-tools/` files are frozen by the baseline manifest.
- `addenda/` records source-backed corrections discovered after existing documentation was read.
- `comparison/` contains the documentation inventory and differences, separate from current-state facts.
- `roadmap/` contains assessment, proposed changes and future verification work.
- [QUALITY.md](QUALITY.md) records review-artifact checks and remaining limitations.

The mandatory root AGENTS instructions were already supplied and contain architectural prose. The [scope record](baseline/scope.md) explicitly records that unavoidable exposure; optional READMEs, design prose and `docs/` were deferred until the checksum checkpoint. No external design artifact or live environment was used to fill gaps.
