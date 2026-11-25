# Configuration generations and launch provenance (#332)

**Current reading, 7 October 2026:** main uses protocol **2.0** and store epoch
**`operator-journals-v4`**. The 1.10 / `config-generations-v3` statements in the
original integration section describe that earlier feature checkpoint. The
save/apply/restoration boundaries below remain relevant; see the
[current protocol reference](../packages/protocol/README.md) and
[capability ledger](ROADMAP.md) for the combined runtime and acceptance limits.

The integrated runtime provides generation capture, restoration, config apply and
launch provenance. [332-runtime-integration.patch](archive/patches/332-runtime-integration.patch)
is a historical handoff against preparation commit
`7abc2342aa672ee9d2f10d565ca4f8eb546184df`; its wiring is already reconciled here.
Do not reapply it. The post-review corrections are described here; [combined validation](archive/runtime-next-integration.md#review-status-and-final-reconciliation)
remains a separate release gate.

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

Capability sets (#335) follow the same split. `config.get` reports `capabilities`
for the active configuration, and a `config.set` of the config document under
`validateOnly` reports the candidate's. Each is, per agent, the MCP servers and
skills its own scope gives it (workspace, inline servers, `agents[].capabilities`)
with the scope that decided each one, plus warnings. They carry identities and
sources only: no command, argument, environment value or skill path, and no skill
content is read. A candidate the schema refuses has no `capabilities`; its
validation errors say why. The app's review step compares the two to show what
applying the candidate changes for each agent.

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
protected generation records; preparation and persistence do not write workflow pins.
Only actual launches pin definitions, and there is no automatic deletion of resume data.

A boot validates and activates the saved configuration for new work without reserving
all loaded workflow versions in the global version store. Each protected generation
retains its validated workflow catalog. Editing an unused workflow at the same version
therefore does not prevent boot or recovery of unrelated work. Actual launch still
pins `(id, version)` immutably: if that version was already run with different content,
a fresh unversioned launch is refused and the workflow must receive a new version.
An explicit recorded version resolves the historical definition. `config.apply` still
rejects same-version content changes against active or stored definitions.
Previously admitted runs restore their recorded generation. Missing or corrupt
material is `RUN_STATE`, never permission to use today's configuration. A missing
legacy workflow pin or a different recorded digest also fails closed.

Request-written/run-missing recovery uses the separate trusted `restoreLaunch`
callback, with the durable admission's generation, exact workflow identity and
Request ID. It binds that Request ID and validates the protected material and
workflow digest; it never falls back to the current generation. The #329 caller
must authorize recovery and read this binding from the durable admission rather than
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
The refusal is generation-wide: registering a custom executor or other behavior-bearing
callback binds the whole generation, including runs that never invoke that callback.
Same-bootstrap launches and resumes remain distinct from restoration after restarting
the engine process (daemon, standalone CLI or embedder). Reconnecting a UI to the same
running daemon does not cross that boundary; quitting an app that stops its bundled
daemon does. No-op or declarative-only plugins can restore when the compatibility checks
above succeed.

The compatibility check works in both directions: a historical unbound generation
cannot restore into a bootstrap that installs executable plugin mutations. Built-in
executor registration objects are also copied per bootstrap, so removing a plugin cannot
retain its in-place callback mutation in another app in the same process.
In-place host/executor and nested filesystem callback edits are behavior-bearing too.
The shipped JEV example registers custom executors and is therefore bootstrap-bound:
finish its admitted work before restarting. Do not delete protected records or start a
replacement run under new callbacks to bypass a refusal. Cross-bootstrap recovery for
such plugins needs an explicit restoration contract; this release does not provide one.
Track that work in [#394](https://github.com/cschadewitz/Project_Orca/issues/394),
the JEV adapter in [#395](https://github.com/cschadewitz/Project_Orca/issues/395), and
real restart/operator acceptance in [#396](https://github.com/cschadewitz/Project_Orca/issues/396).

Built-in providers record their resolved bootstrap directory and Kepler task directory
inside the protected generation. Historical launch restoration does not reread the current
`KEPLER_TASK_DIR`; a missing recorded Kepler context fails closed. A missing recorded configuration directory also fails closed for local and git providers;
restoration does not borrow the current `configDir`. Provider reconstruction is checked
before writing run-specific private inputs or provisioning a workspace.

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

The protected generation record contains parsed configuration, templates, full validated
workflow definitions and effective plugin agent/role data. Legacy generation snapshots
without embedded definitions retain their existing encrypted workflow-pin lookup. It
uses `private-execution/` and its existing key, atomic publication and authenticated
encryption, without a second key lifecycle. Configured bytes stay encrypted; ambient
process environment, resolved credentials and live sessions are not captured except for
the explicitly resolved built-in provider directories above.

Snapshot compatibility is one-way. This runtime can read legacy pin-backed generation
snapshots subject to the restoration checks above. Older binaries that do not understand
`workflowDefinitions` discard that field and rely on pins for the entire workflow catalog.
New generations do not pin unlaunched workflows, so even a generation used by a launched
run cannot restore on such a binary if another catalog workflow has never been pinned.
This restriction also applies between builds reporting the same `config-generations-v3`
epoch; epoch equality alone does not establish rollback compatibility. Retain a complete
pre-upgrade store backup and its matching binary instead of attempting binary-only rollback.

Public launch provenance withholds every input value. Explicitly sensitive workflow
inputs remain protected. Defense-in-depth literal redaction additionally recognizes
credential-named environment fields/options, authorization headers, credential-bearing
URLs and common token formats. Ordinary `acp`, `mcp` and `FORCE_COLOR=1` values are not
global secret needles. This is not arbitrary-secret discovery or taint tracking: use
sensitive input declarations and avoid embedding credentials in unlabeled free text.
Structural identity fields remain metadata even when a declared secret matches them.
No RPC serves private generation material. Back up the complete protected store and
keys as documented in `protected-execution-storage.md`.

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
- Direct daemon and Request admission through the same `CaptureLaunch` provider, with
  separate `restoreLaunch` for authorized recovery of the original durable admission.
- Apply registration/authorization, conditional method discovery, notifications,
  active workflow discovery, protocol minor 1.10, release compatibility metadata and the security matrix update.
- Dedicated integration tests, the operation-inventory fixture update, and the existing
  CLI settlement fixture explicitly selecting its legacy post-bootstrap registry path.

No new error enum is introduced: `CONFIG_STALE`, `CONFIG_INVALID`, `RUN_STATE`,
`NOT_SUPPORTED` and existing workflow errors retain their meanings. There is no
new capability class; method discovery advertises apply only when writable and
wired. The combined protocol version is 1.10. The release store epoch advances to
`config-generations-v3`. The managed Debian updater compares release metadata and refuses
automatic activation/rollback across different epochs. Direct daemon/CLI startup does
not enforce that epoch, and manually selecting an older binary does not migrate the
store or guarantee a refusal. Treat rollback to a binary ignoring recorded generations
as unsupported; retain a complete pre-upgrade store backup and matching binary. The protected v2
encryption, keys and records remain intact; there is no data migration or key rotation.

Focused tests cover save/apply separation, validation/refusal, concurrent saves
and applies, capture across apply, recovery, protected file contents, redaction,
notifications, external edits and same-version workflow collision. The integration
fixture resumes a parked parent against a new generation and checks that its newly
spawned child retains the old role and template. Full combined checks and real App
smoke remain required on the final integration head; feature-only evidence is not
cross-story acceptance.
