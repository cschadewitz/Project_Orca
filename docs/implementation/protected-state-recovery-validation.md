# Disabled protected-state recovery inventory and validation (#387)

Engineering contract frozen before source implementation, 8 October 2026, against
main `983b824adba26b0d26cfca747e5c303d03a397c6`. This is an internal, read-only
engineering slice. It has no barrel exports, updater/daemon/engine wiring, copy,
restore, initialization, consent, lease or execution operation. Recovery eligibility
is always `unavailable`. No result authorizes production backup or recovery.

## Input and ownership

An engineering caller supplies an exhaustive root-ownership plan: stable opaque root
IDs, absolute owned roots, each root's role (`store`, `app`, `configuration`), an
expected workspace identity for each store, and explicitly classified components.
Every configured app/daemon/CLI/ACP store is a separate root unless the owner has
established that it is physically the same store. CLI store paths are resolved
relative to their configuration directory by the caller. No home-directory discovery,
configuration loading, bootstrap or initializing `workspaceIdentity` call occurs.
The adapter checks actual topology and rejects duplicate, nested and case-colliding
roots. The caller remains responsible for declaring all roots; filesystem inspection
cannot establish that an undisclosed CLI configuration does not exist.

Keys, artifact index/blobs, each plan collection/journal and admission-lock storage
are separate required components, so unused collections can be explicitly absent
without classifying an entire partially used family as missing.
Each required component is `present`, `absent`, `not-applicable`,
`external-unverified`, or `unknown`. Present components must contain their declared
relative paths; absent/not-applicable paths must actually be absent. An external
component is recorded without reading it: this includes local auth/credential bytes,
OS Keychain and external workspaces/worktrees. Separate workspace and credential
dependency declarations are mandatory, even when explicitly not applicable.
Unclassified entries and unknown components fail completeness. External-unverified
components are classified coverage with unresolved completeness, never verified
recovery. Additional candidate-owned paths require explicit classification.

The manifest contains only bounded relative entries and opaque logical IDs. It is
sensitive local engineering material, never diagnostics. Absolute roots exist only
in the invocation, never in the manifest or validation output. The caller supplies
candidate references; they refer to the existing updater/release identity contract,
not a competing release manifest. Candidate pairing is exact reference equality;
this module never calculates compatibility from protocol/store epochs. Candidate
trust, signatures, channel policy and readability of all intervening writes remain
external gates, including equal-epoch binaries.

## Audited ownership at the pinned main

| Root | Required component and actual locations |
| --- | --- |
| Every store | Public runs: `runs/`; artifacts: `artifacts/index.jsonl`, `artifacts/blobs/` (inventory the whole `artifacts/` subtree, including log metadata) |
| Every store | Private execution: `private-execution/`, its own `.execution-key`, inputs, payloads, sensitivity overlays and immutable `.generation.json` records; includes config/workflow/template snapshots and operator/admission/revision journals stored as protected records |
| Every store | Private workflows: `private-workflows/` and its independent `.execution-key`; legacy snapshots: `workflows/` |
| Every store | `requests.json`, `work-items.json`; `plans.json`, `dependencies.json`, `risks.json`, `decisions.json` and `plans/` journals |
| Every store | `claims/`, `leases/`, `request-admissions.json`, `request-admission-locks/`, `admission-retries/`, `continuation-locators/`; retained locks/tmp/log metadata are inventory, never adopted or used to infer inactive ownership |
| Every store | Coupled `workspace-identity/id` and `.workspace-identified`; metadata is read directly, bounded, and compared to supplied expected identity without initialization |
| Supplied app userData | `preferences.json` and `admission-intents.enc`; encrypted bytes do not prove Electron safeStorage/Keychain continuity; memory-only drafts are outside filesystem inventory |
| Supplied configuration | Exact supplied config filename(s), `orca.permissions.json`, workflow/template/plugin asset locations owned by that candidate; `auth/` is declared external-unverified and never traversed/read |
| Separately declared external | Workspace/worktree state and provider effects; credential/ownership/token dependencies including OS Keychain; no credential acquisition or probe |

Sources: `packages/store/src/document-store.ts`, `artifact-store.ts`,
`execution-store.ts`, `workflow-store.ts`, `plan-store.ts`, `workspace-identity.ts`,
`admission-retry-store.ts`, `continuation-admission-store.ts`,
`packages/engine/src/program/submission-store.ts`,
`packages/engine/src/configuration-generation.ts`, `packages/cli/src/bootstrap.ts`,
`packages/daemon/src/auth/bootstrap.ts`, `packages/app/src/main/index.ts`.
Required component names are a minimum audit checklist, not an exhaustive whitelist
of future durable paths. Each root is traversed fully except explicitly excluded
external paths; extra data without a classification fails coverage.

## Schema and capabilities

Version 1 is a strict bounded local inventory envelope: candidate reference, roots
with role/expected and observed identity, component declarations, relative file or
directory entries (size, SHA-256 for files, inode/device identity, POSIX mode/UID/GID,
ACL status), explicit required references, external dependency classification,
enumeration completion, observation outcome and stable reasons. `enumeration` is
`complete` only after every supplied owned root is traversed and final metadata checks
finish; an aborted traversal is `incomplete` even if all named components are declared
absent. Incomplete enumeration withholds coverage using `COMPONENT_UNKNOWN`; already
observed missing/unclassified components still fail coverage. Enumeration is separate
from access/identity failures, which can coexist with a complete traversal. This required
field remains internal to the unmerged version-1 envelope. Entries and
component/reference candidate bindings must match the manifest candidate. Plugin generation content is kept opaque;
no descriptors are invented and no callbacks are reconstructed.

Parsing accepts a bounded JSON string, strips no unknown fields, and returns only
closed reason codes on errors. Pure validation returns separate structural validity,
coverage, integrity, semantic readability, writer consistency and recovery eligibility.
Integrity comparison includes each root's POSIX mode, UID, GID and ACL evidence as well
as entry contents/access. Different safe root modes still fail evidence comparison.
Digest verification compares manifest entries against a separately observed manifest;
a digest in an unobserved manifest is a claim, not an integrity check. Semantic read
evidence is supplied separately and explicitly bound to candidate and root; it is
engineering evidence, not trusted authority. No filesystem read, decryption or callback
is performed by parsing or validation.

Writer consistency is always unknown in this slice. Before/after inode/stat/directory
checks detect observed mutation; an unchanged observation is not a snapshot. The
maintenance fence covers the daemon, not independent CLI/ACP or external writers.
There is no `quiescent` boolean, fence-token consumer or trusted all-writer proof here.
Topology checks and no-follow file opens are defense in depth, not an atomic cross-root
snapshot or a portable defense against a hostile concurrent ancestor replacement.
Bounded reads and post-observation checks refuse observed changes. POSIX owner-only
mode/UID evidence is checked; Windows ACLs remain unverified. Modes are evidence,
never a Windows ACL audit. No chmod/chown, repair, lock, mkdir or key creation occurs.

## Closed reason codes

`MANIFEST_INVALID`, `RESOURCE_LIMIT`, `ROOT_INVALID`, `ROOT_OVERLAP`,
`PATH_UNSAFE`, `PATH_COLLISION`, `SYMLINK_REFUSED`, `SPECIAL_FILE_REFUSED`,
`ACCESS_UNSAFE`, `ACL_UNVERIFIED`, `READ_FAILED`, `OBSERVATION_CHANGED`,
`COMPONENT_MISSING`, `COMPONENT_UNKNOWN`, `ENTRY_UNCLASSIFIED`,
`EXTERNAL_UNVERIFIED`, `IDENTITY_MISSING`, `IDENTITY_MISMATCH`,
`KEY_MISSING`, `KEY_INVALID`, `REFERENCE_MISSING`, `CANDIDATE_MISMATCH`,
`INTEGRITY_UNVERIFIED`, `DIGEST_MISMATCH`, `SEMANTIC_UNVERIFIED`,
`SEMANTIC_UNREADABLE`, `WRITER_COVERAGE_UNKNOWN`, `RECOVERY_DISABLED`.

Errors/results contain only these reasons and conclusions; no filenames, roots,
identities, digests, user metadata, exception text, schema issue paths or plaintext.
Operational budgets bound roots, components, references, entries, depth, path/string
length, file size, total bytes hashed and JSON size; caller budgets can only lower hard
ceilings. Inspection uses incremental directory iteration and fixed-size hash buffers.

## Verification and remaining gates

Only tests own synthetic roots and perform copy/restore there. Positive round trips
use existing non-mutating protected reads, workflow reads, committed public event reads
and protected public projections; no plaintext is emitted. Existing artifact/document
facades can mkdir or take write locks during reads, so they are not called on source
stores as evidence of side-effect-free inspection. Tests compare source bytes and
metadata and assert that validation has no execution hooks. Coverage includes two
independent stores, app/config roots, protected keys, corrupt ciphertext, missing
references, mixed eras/identities/candidates, unsafe topology/access, resource limits
and observed hash mutation.

[Recovery support](../preparation/beta-update-support/recovery-support.md) and
[protected execution storage](../protected-execution-storage.md) remain authoritative.
[#394](https://github.com/cschadewitz/Project_Orca/issues/394) owns opt-in generation/plugin
restoration; #395 owns JEV adoption and #396 fresh-process/Cal acceptance. Historical
plugin records are opaque inventory and never evidence of execution-restorability.
No credential resolution, key regeneration, provider call, admission reopening, lease
adoption or consent restoration is implemented. Destination, encryption, retention,
access, consent, channel and trust policy are unchosen. Native signed Mac upgrade,
old-to-new Keychain/permissions continuity, all-writer fencing, compatibility of all
writes and the separately reviewed supported restore procedure remain live gates.

Initial verification (Node 24.21.0/pnpm 12.4.2, Linux): 52 new recovery cases plus
20 adjacent protected-read/continuation cases pass with two Vitest workers;
workspace and renderer typecheck, full lint/CSS checks, and scoped formatting pass.
The broader protected-execution test run has one unchanged environmental failure:
its legacy-workflow-directory expectation is 0755, but this environment's inherited
0077 umask creates 0700. Reproduced alone; no existing tests or process/host defaults
were changed. Full suite/build, CI, native Mac/Keychain and live recovery were not run.

Review correction verification: 60 recovery cases pass across the three owned suites
with two Vitest workers, including deterministic aborted-enumeration and genuine
0700-to-0500 root-mode regressions plus all root access fields. Workspace/renderer
typecheck, scoped ESLint/Prettier and diff checks pass. Earlier legacy readability
and encryption assertions passed; the unchanged 0755-versus-0700 assertion is the
only legacy failure. No legacy test or process/host permission default was modified.
