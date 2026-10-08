# Policy, authority and illustrative configuration

This is a proposed contract, not a schema implemented at the recorded
[baseline](README.md). Existing first-match permission rules retain their meaning.

## Two separate questions

1. **May this principal perform this operation on these resources?** Current daemon
   authorization, administrator limits, captured delegation and the execution host's
   permissions answer this. Neither an agent nor a checker can change that answer.
2. **Should this particular authorized action proceed now?** Deterministic action
   rules, optional model review and any required human confirmation answer this.

An allow recommendation to an unauthorized request is still denied. Human approval
also cannot override an administrator prohibition, missing OS permission, revoked
principal or unsupported enforcement. A policy administrator must change policy
through a separate authenticated administration boundary if a limit is wrong.

## Precedence and authority

Use intersection for authority, not last-writer-wins configuration. A lower scope
may select only profiles made available by a higher scope, and may add restrictions.
The effective authorization set is the intersection of current principal rights,
current administrator caps, project-authorized envelope, captured run ceiling,
workflow restrictions, agent restrictions and per-run restrictions. Required human
confirmation and enforcement requirements accumulate; deny vetoes dominate. Bounds
such as duration, calls and spend take the minimum; allowed sets intersect.

| Scope | Who controls it | What it can do | What it cannot do |
| --- | --- | --- | --- |
| Installation | Verified administrator, outside agent-writable mounts | Define immutable-to-runs limits, trusted profile catalog, checker destinations, supported runners and hard-human classes | Be overridden by repository YAML, an approval card or a model response |
| Project | Authorized project operator within installation limits | Select approved profiles, resource roots, repositories, destinations and narrower defaults | Treat a committed file or workflow author's claim as administrative authority |
| Workflow | Author proposes; admission resolves against authorized project catalog | Select an available profile and narrow resources/operations | Add credentials, approve its own new profile or silently broaden another scope |
| Agent | Authorized agent configuration, plus task-specific restrictions | Narrow the profile for the resolved agent/adapter/host and require stronger review | Override workflow restrictions or inherited administrator denials |
| Per run | Authenticated launcher within their own scope | Narrow limits or explicitly select an already authorized profile at admission | Turn off higher-level review, grant another principal's scope or widen an active run silently |

Preference precedence is different: installation default → project default →
workflow choice → agent preference → per-run preference, with the last *valid*
explicit value winning for presentation, approved checker selection and optional
explanation detail. Security-sensitive choices are checked against every enclosing
limit. If workflow and agent profile requirements are incompatible, reject admission
with a field-specific explanation; do not choose the more permissive profile.

The distinction must be structural in the schema: `limits`, `requirements` and
`authorizedProfiles` cannot be mistaken for overridable `preferences`. Absence
inherits; it is not allow. Empty allowed sets mean no authority. Unknown fields,
unknown profile versions, invalid regular expressions, cycles in profile inheritance,
missing policy records and unsupported required coverage prevent enforcing admission.
Validate and bound rule complexity; do not run arbitrary policy scripts from a repo.

The trusted catalog lives outside workspaces and their write capabilities. A
repository can contain a proposed profile, but making it active is an authenticated,
revision-guarded operator action. Editing `.orca`, `orca.config.yaml`, permission
sidecars, runner manifests, policy files or checker instructions is itself a protected
operation. A read-only policy file alone is insufficient if the agent can replace its
parent directory, alter the loader or reach the daemon's private store.

## Compatibility with current permissions

Keep `effectivePermissionPolicy` and `decidePermission` as the legacy permission
decision source: configured rules → sidecar → conditional built-in defaults,
first match wins. Do not silently change it to deny-overrides inside that list.
The new authority ceiling sits outside that evaluator. A legacy deny remains a
veto; a legacy allow can be narrowed by new restrictions. In the initial enforcing
mode a legacy ask still needs a person. A checker cannot manufacture an ACP choice.

Later delegated mode may resolve specifically eligible asks only when an authorized
operator has explicitly granted the bounded profile that covers them. The record
must identify that grant as the authorizer. This is a new authority contract requiring
review and migration, not a model converting `ask` into `allow`, and not an implicit
reinterpretation of existing `humanInput: auto` or `allow always` settings.

Existing sidecar grants remain workspace-scoped legacy rules, including their current
limits. They are not exact-action permits. New bounded grants need additional identity,
budget, expiry and revocation fields in an approved protected record; do not silently
write the richer authority into today's sidecar. A separate explicit standing-rule
write still needs `permissions.grant` and remains under all new caps. Baseline corrupt
sidecar fallback is a known gap: enforcing mode must refuse evaluation when required
material cannot be read, rather than dropping restrictions. See [current-state](current-state.md).

## Capture versus current permissions

Capture the selected profile revision/digest, compiler/schema version, resolved
restrictions, delegation record, adapter/runner evidence and review configuration
with the run's existing protected generation material. Also capture the effective
legacy configured/sidecar/default policy, its exact ordered rules and sidecar digest
at enforcing admission. A broad profile alone cannot preserve a narrower legacy
restriction. Record safe provenance in public history. Preserve exact execution
choices and the meaning of the policy that authorized admission; missing material
fails closed on recovery.

At each check and immediately before permit consumption, re-evaluate current
principal/revocation state, administrator caps, active configured permission policy
and current sidecar. This extends the [existing separation](../../configuration-generations.md#provenance-secrets-and-current-authority)
between historical execution configuration and live authority. Do not imply that
saving an agent setting activates it: agents/permissions currently require restart;
sidecars are reread live. A future security-policy activation API needs its own atomic
epoch/invalidation contract, not a file watcher that changes authority accidentally.

For an enforcing run, newly narrower current restrictions apply immediately at the
next protected boundary and invalidate outstanding permits. A newly broader policy
does not expand the captured ceiling. Broader authority requires explicit authorized
renewal/re-admission with a new policy epoch and audit record; it cannot be smuggled
through a resume or approval answer. A human can approve an action already within
the captured ceiling without widening it. Children inherit the ceiling and remaining
shared budgets; they may narrow it, never reset the counters by spawning a run.

Evaluate captured and current legacy policies independently with their original
first-match semantics; do not concatenate their rule lists. Either result being deny
vetoes execution. Either result being ask preserves the human-review obligation unless
an explicit captured delegation covers that action and that specific delegable ask;
a current mandatory-human restriction still wins. Thus removing a sidecar deny or
changing ask to allow cannot expand an already-admitted enforcing run. A one-time
human answer discharges its exact ask only. A newly written standing grant affects
new admissions, or an explicitly renewed policy epoch, rather than silently removing
the captured ask obligation. This stricter temporal contract is opt-in and must be
shown to operators; it is not a change to legacy runs' live-sidecar behavior.

## Defaults and tuning

Existing runs and installations keep existing permission behavior unless a profile
is deliberately selected. Observation mode records hypothetical outcomes and never
supplies a new allow, denial or prompt. New enforcing profiles default to no delegated
authority, one-shot human approvals, no external network/credential access and denial
of missing required interception. Unknown action semantics are `indeterminate`, mapped
to human review only where coverage is sufficient and policy permits; otherwise block.

Start with a small reviewed profile catalog, such as inspect-only, isolated-build and
interactive-maintenance. These names do not certify safety. Even an inspect-only
profile needs credential exclusion and network controls; reads can disclose secrets.
Tune typed operation rules and budgets using observed false denials and reviewer
decisions. Require reviewed policy diffs and regression results for tuning; never
learn a standing allow automatically from repeated clicks or model confidence.

## Configuration sketches (non-executable)

The following YAML is design notation. No shown new key is supported today. Profile
versions are immutable; a digest in a launch record detects changed bytes under a
reused version. Administrator configuration is stored outside the repository.

```yaml
# Installation authority — proposed, not orca.config.yaml syntax
toolSafety:
  schemaVersion: 1
  limits:
    policyMutationByAgents: deny
    credentialExport: deny
    requiredHuman: [production-deploy, force-push, destructive-external-delete]
  authorizedProfiles: [isolated-build@1, interactive-maintenance@1]
  requirements:
    policyReadFailure: block
    checkerDataDestinations: [approved-internal-review-service]
  profiles:
    isolated-build@1:
      coverage: constrained-effects
      runner: certified-isolated-runner
      capabilities: [filesystem-boundary, descendant-containment, network-boundary]
      operations: [workspace-read, workspace-edit, pinned-test-recipe]
      credentials: []
      network: []
      executionRecipes: [project-tests@sha256-reviewed-recipe]
      modelReview: { mode: advisory, timeoutMs: 3000 }
      unresolved: hold
      delegation: { maxCalls: 100, maxDurationSeconds: 1800 }
      # A recipe describes exact argv/cwd, pinned inputs, effect limits and runner.
```

```yaml
# Project-authorized selection, and a workflow's narrowing request — proposed
projectSafety:
  authorizedProfiles: [isolated-build@1]
  repository: project-orca
  workspace: admitted-attempt-workspace
  protectedPaths: [orca.config.yaml, orca.permissions.json, .orca, .git/hooks]

workflowSafety:
  profile: isolated-build@1
  narrow:
    operations: [workspace-read, pinned-test-recipe]
    maxCalls: 40

agentSafety:
  require: [structured-action-input, one-shot-approval]
  preferences: { modelReview: advisory }

runSafety:
  narrow: { maxCalls: 20, maxDurationSeconds: 600 }
  unattended: { escalation: hold, humanDeadlineSeconds: 300 }
```

Here the workflow removes workspace edits; the agent's preferences cannot restore
them. The run further lowers the budget. If the ACP adapter only emits incomplete
permission metadata and cannot meet constrained-effects requirements, admission
fails before provisioning execution. A human pressing approve does not repair that.
The sketches grant no credentials; any future credential broker must have an
independent deterministic authorization boundary and is outside the first phase.

## Operation policy and inspection limits

| Operation | Attributes and deterministic boundary | Recommended default in an enforcing profile |
| --- | --- | --- |
| Commands/arguments | Executable identity and version, exact argv, shell/interpreter, cwd, environment references, stdin/script digest, effect envelope; check at dispatch | Structured, reviewed recipes may be eligible for delegation. Unresolved shell/scripts need human review within containment, or block. No command-prefix grant. |
| Working directory | Resolved host workspace identity, physical root, repository/worktree identity; guard directory resolution at use | Require the admitted workspace; a displayed path alone does not establish identity. |
| File reads/search | Every resource, symlink/mount traversal, credential/config/control-store exclusions, descriptor-based or OS-enforced roots | Allow bounded nonsecret workspace reads; protected files deny. A read result is untrusted and cannot amend policy. |
| Writes/moves/deletes | Source and destination, expected preimage/version, path resolution at use, recursive breadth | Bounded ordinary edits may delegate. Bulk/recursive deletion and overwrite of valuable state require human confirmation; protected paths deny. Existing default workspace deletes are not proof this new profile should allow them. |
| Network | Scheme/host/port plus resolved endpoint, redirect/DNS/proxy policy, private-address rules, upload/body class | Default deny; explicit destinations and egress enforcement required. Domain allowlists alone do not bound exfiltration or prevent rebinding. |
| Credentials | Secret reference, allowed consumer and destination, lifetime, inherited environment, SSH agent/socket/keychain reachability | Do not expose values to checker; deny reading/exporting secrets and agent-chosen credentials. Human approval cannot mint access. Independently preauthorized broker use only in a later profile. |
| Git | Repository/worktree, exact refs and objects, hooks/config/helpers, remote identity, expected old remote OID | Read-only queries only when helpers/config are controlled. Local branch/commit within an isolated workspace may delegate. Push requires explicit publishing authority; force-push, protected-ref changes and destructive reset/clean require human confirmation. |
| Installations | Artifact/lockfile digest, registry endpoint, install location, lifecycle scripts, privileges, dependency graph | System/global installs and unpinned downloads need human confirmation or deny. Pinned isolated dependency restoration may delegate only with scripts and egress constrained. |
| Deployment/publication | Environment/account, immutable artifact digest, service target, change plan, rollback and idempotency key | Production deployment and destructive external changes require human confirmation plus separately scoped deterministic publisher authority, regardless of model confidence. |

Command names are not effect classes. `git diff` can invoke external helpers; tests,
builds and package managers execute repository/dependency code; a permitted interpreter
can do arbitrary I/O. Quoting, substitutions, pipes, redirection, aliases/functions,
shell startup files, `PATH`, environment expansion, response files, symlinks, hooks,
plugins, downloaded scripts and subprocesses change meaning. Even a complete shell
AST cannot predict dynamic scripts or indirect remote effects. Never run a candidate
command to find out whether it is safe. Infer likely risk, mark uncertainty explicitly,
and constrain actual effects at the runner and external service.
