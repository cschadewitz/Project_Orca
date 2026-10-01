# Scope and evidence method

## Revision and allowed work

The source snapshot is commit `09f32690ffca5d9c79f6d8702481f6efe30a4cf3`, branch `casey/Review-Prompt`, origin `https://github.com/cschadewitz/Project_Orca.git`. Initial `git status --short` was empty. The only new working-tree content created for this task is this review directory. Repository implementation is therefore described at the pinned commit; review files themselves are uncommitted deliverables. Existing work was neither reset nor cleaned.

The first filesystem mutation was creation of `Current_State/`; it did not previously exist. The mandatory root `AGENTS.md` was read for constraints first. No nested AGENTS files were discovered. No README, `docs/` content, prior review, proposal, architecture image or explanatory document was opened before the independent checkpoint. A directory listing can reveal a document's name; its body was not used to select investigation subjects.

The root AGENTS text, also supplied directly by the user, contains implementation descriptions, design rules and pointers. Complete ignorance of those statements was impossible. They were treated as working constraints, not baseline evidence. In particular, its instruction to consult development/architecture documentation was deferred under the user's explicit independent-investigation requirement. No higher-priority instruction required further documentary exposure.

## Coverage and granularity

Discovery used tracked file paths, workspace/package manifests, public barrels, executable entry points and imports. A component is a cohesive lifecycle owner, service, projection, persistence family, protocol boundary or UI surface family. Small helpers remain inside their owner. Thirteen workspace manifests comprise eleven product/support packages and two tooling packages; delivery configuration and executable workflow assets are additional owners. The [matrix](coverage.md) accounts for every discovered major family. The [census](source-census.tsv) hashes 614 tracked non-document source/configuration/test/assets files; the [source map](source-map.md) records ownership and separately marks source mapping versus selected semantic tracing.

Cross-boundary traces followed callers and implementations: CLI composition → engine → store; program → plan dispatch → child runs; agent invocation → ACP/host → artifact collection; daemon methods → control/read models → engine/store; Electron renderer → preload → main client → daemon; notifications → UI reconciliation; plugin → JEV provider. Every view includes selected concrete evidence. This is exhaustive **inventory coverage at the stated granularity**, not a claim that every code branch, security property or test assertion has been audited.

## Classifications

| Label | Meaning | Appropriate conclusion |
| --- | --- | --- |
| Implemented | Directly supported by source statements and traced call/data paths | “The implementation routes the answer to the orchestrator.” |
| Inferred | Interpretation of source with reasoning stated | “Separate file mutations imply no shared transaction across these records.” |
| Declared | Schema, test, comment or configuration intention not fully traced | “CI declares a two-version Node matrix.” |
| Unverified | Static review cannot establish it, or the path was not sufficiently traced | “Remote-agent compatibility and crash durability remain unverified.” |

A parsed schema is evidence of validation only where a parser call is traced. Tests express intended coverage and useful scenarios; no test result is assumed. Comments can disagree with executable branches. Diagrams are structured interpretations of cited implementation, not observed process traces. The word “supports” in a specification means a traced code path exists, unless explicitly qualified as declared.

## Citation and exclusion conventions

Specifications use relative Markdown links with `#L` line locations and a companion commit-pinned GitHub link. GitHub provides a reliable immutable source target; a local viewer may not implement source-line anchors. Symbols make locations usable in either viewer. All source links refer to clean committed content. The baseline's review documents use relative navigation links.

Excluded from execution: application startup, builds, tests, migrations, services, integrations, generated-asset builds, dependency installation and external diagram rendering. Only source reads, Git metadata reads and standalone standard-library Python documentation/diagram/checksum checks were used. No repository Python/JavaScript/TypeScript module was imported or executed. Existing binary/font/image artifacts were inventoried by path where relevant, not interpreted as proof of rendering. Prompt bodies were deferred; parsers, template identifiers/frontmatter and workflow YAML were inspectable executable inputs.

No live credentials, external service behavior, performance, actual deployment state, test pass rate, packaging/signing outcome, recovery timing or OS isolation can be established here. Recommendations and documentation evaluation are deliberately absent from this factual baseline.
