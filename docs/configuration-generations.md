# Configuration generations and launch provenance (#332)

This story implements the generation provider, config model, protocol shapes and
focused tests. `docs/patches/332-runtime-integration.patch` supplies the exact
reserved-path wiring against preparation commit
`7abc2342aa672ee9d2f10d565ca4f8eb546184df`. Per the parallel contract, Cal applies
that patch together with the other stories. The feature branch alone does not
advertise `config.apply` or claim combined runtime acceptance.

## Saving and activation

`config.set` still saves only. When the generation provider is installed,
`config.get` and successful saves include `generation`:

- `savedRevision`: the current file's SHA-256 revision, or empty for a missing file.
- `activeRevision`: the file revision admitted at activation.
- `activeGeneration`: an opaque immutable generation ID, independent of file hash.
- `state`: `active`, `pending`, `restart-required` or `invalid`.
- `restartRequired`: changed settings that cannot be applied live.

The effective permission view uses the active configured rules and the current
sidecar; a saved but unapplied permission edit is not reported as active policy.

`config.apply` takes `expectedRevision`, `expectedGeneration` and optional
`validateOnly`. Both guards are mandatory. It shares the config writer's file
lock, reloads candidate assets and validates references and immutable workflow
identities. Validation produces `validated` without writes. Other outcomes are
`applied`, `unchanged`, `restart-required` and `invalid`. `CONFIG_STALE` means
refresh and review again. Validation errors do not include source values.

Activation durably publishes immutable protected material before one synchronous
active-pointer swap. Launch capture reads that pointer before awaiting anything.
Both returned admission callbacks remain bound to that generation and exact
workflow version/revision. A concurrent apply cannot mix their choices. Failures
leave the old active pointer intact. A crash before activation can leave unused
protected records or workflow pins; there is no automatic deletion of resume data.

A boot validates and activates the saved configuration for new work, as before.
Previously admitted runs restore their recorded generation. Missing or corrupt
material is `RUN_STATE`, never permission to use today's configuration. A missing
workflow pin or different digest also fails closed.

Request-written/run-missing recovery uses the separate trusted `restoreLaunch`
callback, with the durable admission's generation, exact workflow identity and
Request ID. It binds that Request ID and validates the protected material and
workflow digest; it never falls back to the current generation. The #329 caller
must authorize recovery and read this record from the durable Request rather than
accept historical choices from the RPC caller. Ordinary `captureLaunch` continues
to reject a noncurrent `expectedConfigGeneration`, including after restart.

## Reloadability

| Settings | Apply behavior |
| --- | --- |
| `roles` | New launches use the new mapping. |
| `program` | New Request captures use the workflow and item-workflow defaults; explicit vars still win. |
| `workflows` | Reload and validate definitions, preserving existing immutable versions. |
| `templates` | Reload templates; admitted runs retain captured bodies and partials. |
| `agents`, including models, commands, environment, session options and permissions | Restart required. Per-run selection overrides remain supported. |
| `hosts`, `workspace`, `storeDir`, `planning`, `humanInput`, `plugins`, `version` | Restart required. |
| Unclassified settings, including new or unknown nested fields | Restart required. |
| `orca.permissions.json` | Live, independent of generation apply; reread at the next permission check. |

A plugin can contribute runtime registrations, so refreshing plugin-backed
assets is refused by the bootstrap loader; restart is required. Plugin and
external-agent executable code is not snapshotted or claimed reproducible.
Bootstrap captures effective plugin agent specifications and role mappings in the
protected generation, and retains the actual host objects and workspace provider
for that bootstrap lifetime. Later registry edits cannot replace those registrations.

A later bootstrap restores declarative plugin agent specifications and role mappings
from the protected generation after verifying unchanged resolved entry modules,
plugin list and configured host definitions. No-op and declarative-only plugins retain
restart compatibility. Entry digests do not cover transitive imports; ORCA does not
claim reproducible plugin execution.

Arbitrary custom executors, plan signal extractors, workspace-provider and changed host objects may close over
registration-time config, environment or other unrecorded state. Matching entry
bytes and host IDs cannot prove that state. These executable registrations are bound
to the bootstrap that captured them until an explicit plugin restoration contract
can reconstruct those inputs. Their private fingerprint includes a fresh lifetime
nonce, without raw configuration or secret values. A historical launch or resume in
a later bootstrap fails closed with `RUN_STATE`, before workspace provisioning.
Captured launches within the original bootstrap retain their provider/host objects.
This is not a blanket restart refusal for no-op or declarative-only plugins.
In-place host/executor and nested filesystem callback edits are behavior-bearing too.
The shipped JEV example registers custom executors and is therefore bootstrap-bound:
finish its admitted work before restarting. Do not delete protected records or start a
replacement run under new callbacks to bypass a refusal. Cross-bootstrap recovery for
such plugins needs an explicit restoration contract; this release does not provide one.
Track that work in [#394](https://github.com/cschadewitz/Project_Orca/issues/394),
the JEV adapter in [#395](https://github.com/cschadewitz/Project_Orca/issues/395), and
real restart/operator acceptance in [#396](https://github.com/cschadewitz/Project_Orca/issues/396).

Built-in providers record their resolved bootstrap directory and Kepler task directory
inside the protected generation. Historical launch restoration never rereads the current
`KEPLER_TASK_DIR`; a missing recorded Kepler context fails closed.

Apply also rejects removal of a previously resolvable program or item-workflow
default, even when its configured name has not changed. Unconfigured bundled
defaults that were already absent remain compatible with minimal installations.

Configured gate behavior is restored from the admitted generation. Explicit
embedder/plugin human-input ports and later facade replacements remain live, as
does the human-input port used for permission requests.

There is no filesystem watcher or periodic polling. `config.get` rereads saved
bytes, detecting external YAML/JSON edits. Explicit `config.apply` is also the
manual asset refresh, even if the config bytes have not changed. Its validation
loads the current workflow/template files. An edited workflow with a recorded
unchanged version is refused; bump the workflow version. Template-only edits
produce a new generation while retaining the saved config revision. `active`
means the last applied config revision, not a claim that unwatched assets are
unchanged. An external editor must save files atomically and avoid editing during
apply. Revision checks detect config edits during preparation; a set of separate
asset files has no filesystem transaction.

## Provenance, secrets and current authority

The launch record reuses `RunOverrides` and the existing workflow version/digest.
Its safe provenance includes generation ID, workflow identity, input names and
sources, and each direct agent node's role, agent, configured model, host and
template selection with the precedence source. All input values are withheld,
including artifact references, even when not declared sensitive. Nested workflows
record their own selections when their child run is admitted. Agent-selected
models remain in the existing session-open/update records; an absent launch model
does not claim ORCA chose an external agent's default.

The protected generation record contains parsed configuration and templates, plus
references to the existing encrypted workflow pins and effective plugin agent/role data. It uses `private-execution/`
and its existing key, atomic publication and authenticated encryption. It does not
create another workflow store or key lifecycle. Configured literals stay encrypted;
ambient process environment, resolved credentials and live sessions are never
captured. Configured environment and argument literals also enter the existing execution redactor,
so copied values are hidden in public history and logs. Structural identity fields remain
metadata even when a short secret happens to match them. No RPC serves the private material. Back up the complete protected store
and keys as documented in `protected-execution-storage.md`.

The integration serves provenance only through the existing authorized run reads
and events. `config.apply` requires current `config.write` authority before
parameter validation; read-only daemons and unwired models do not advertise it.
`config.changed` distinguishes `saved` from `activated`; the latter carries the
new generation. Workflow activation emits `workflows.changed` for added/changed
and removed IDs (with `removed: true`), still filtered by current workflow authority.
No activation notification is sent for validation or failed apply.

Authority and credential revocation are not generation data. The session factory
uses current configured permission policy and the live sidecar, even when execution
choices were restored from an older generation. New restrictions therefore do not
require rewriting old execution material.

## Integrated wiring (original handoff retained)

The combined runtime reconciles `docs/patches/332-runtime-integration.patch`. Do not
reapply that historical handoff. The integrated wiring includes:

- Core provenance exports, event/run projection and protocol run inspection.
- Protected execution-store generation methods, reusing the existing private directory.
- Orchestrator admission/context/child binding and bootstrap construction.
- Direct daemon admission through `CaptureLaunch`; #329 should inject this same provider
  into Request admission without importing a peer branch, and inject `restoreLaunch`
  separately for authorized recovery of the original durable admission.
- Apply registration/authorization, conditional method discovery, notifications,
  active workflow discovery, protocol minor 1.10, release compatibility metadata and the security matrix update.
- Dedicated integration tests, the operation-inventory fixture update, and the existing
  CLI settlement fixture explicitly selecting its legacy post-bootstrap registry path.

No new error enum is introduced: `CONFIG_STALE`, `CONFIG_INVALID`, `RUN_STATE`,
`NOT_SUPPORTED` and existing workflow errors retain their meanings. There is no
new capability class; method discovery advertises apply only when writable and
wired. At combined integration, consolidate the protocol bump with the other stories. The
release store epoch advances to `config-generations-v3`: deployment rollback to a
binary that ignores generation-bound execution is incompatible. The protected v2
encryption, keys and records remain intact; there is no data migration or key rotation.

Focused tests cover save/apply separation, validation/refusal, concurrent saves
and applies, capture across apply, recovery, protected file contents, redaction,
notifications, external edits and same-version workflow collision. The integration
fixture resumes a parked parent against a new generation and checks that its newly
spawned child retains the old role and template. Full combined checks and real App
smoke remain required on the final integration head; feature-only evidence is not
cross-story acceptance.
