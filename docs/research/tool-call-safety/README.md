# Implicit tool-call safety and approval — research draft

**Status:** recommendation for Casey and Cal; no accepted ADR, executable configuration,
feature implementation, or authorization to broaden permissions. Research date:
2026-10-04 UTC. Repository baseline: [`94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb`](https://github.com/cschadewitz/Project_Orca/commit/94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb)
(`fix(daemon): preserve completed continuation settlement (#448)`). Both local HEAD
and remote `main` matched that SHA when research began. External documentation and
GitHub state are a dated observation, not part of the immutable code baseline.

## Recommendation

Add an **implicit policy check at supported execution boundaries**, selected by an
authorized workflow/agent profile. Preserve ORCA's existing permission evaluator,
live-input lifecycle, authenticated execution authority and protected audit stores.
Use deterministic controls to establish authority and constrain effects; use an
optional model to classify ambiguity, flag risk and recommend escalation. A model
response is evidence, never a credential, standing grant or enforcement capability.

Start with human-confirmed checks on a certified, narrow execution path. Permit
delegated automatic execution later only inside an explicitly authorized envelope
whose effects a runner can actually constrain. **Observation-only is non-enforcing.**
Never describe arbitrary ACP traffic inspection as a sandbox or complete tool mediation.

ORCA already automatically evaluates permission requests. The new capability is
structured action review, policy provenance and mandatory coverage checks across
execution paths, with optional model assistance and bounded delegation. It is not
another decision-node engine or a replacement for existing permissions.

## Reading map

| Document | Contents |
| --- | --- |
| [Existing system and adapters](current-state.md) | Verified baseline, reuse boundaries, execution-path matrix, bypass gaps, external protocol evidence |
| [Architecture and lifecycle](architecture.md) | Enforcement ownership, action binding, approval races, recovery, unattended operation and audit |
| [Policy and configuration](policy.md) | Precedence, administrator limits, inheritance, live restrictions, illustrative configuration and operation taxonomy |
| [Threat model and evaluation](assurance.md) | Adversaries, tests, staged rollout, measurable acceptance and costs |
| [Roadmap and decisions](roadmap.md) | Existing issue/proposal mapping, phased work, dependencies, Casey/Cal decisions |

All new field names, capability labels, event names and numerical budgets in this
research are proposals. They must not be copied into production configuration as
supported settings. Source links into this repository describe the recorded baseline;
use that commit when comparing with later changes. The preserved `Current_State/`
review is historical context, not the authority for shipped behavior today.

## Source-grounded options matrix

| Option | Good fit | Material limits | Cost and operational shape | Recommendation |
| --- | --- | --- | --- | --- |
| Existing deterministic permission rules | Known ACP kind/title/location asks; deliberate workspace standing rules | Metadata supplied by agent; first-match semantics; no complete command/effect model or universal interception | Local evaluation and sidecar I/O; no model dependency | Retain compatibility. Extend the surrounding contract, not a parallel replacement. See [baseline](current-state.md). |
| Rich deterministic action rules | Exact executable/argv/cwd, structured file/network operations, hard denials, principal and resource limits | Need trustworthy attributes and enforcement at the executor; shell parsing cannot prove arbitrary code safe | Predictable low latency; policy authoring, platform runners and test corpus are the larger costs | Mandatory authority layer. Begin with typed rules in existing package boundaries; evaluate a policy language only when complexity warrants it. |
| Model-assisted review alone | Explaining unusual commands, relating requested work to a task, detecting suspicious combinations | Prompt injection, omissions, nondeterminism, false allows/denials, service outages; no power over bypassing processes | Per-request tokens and tail latency; model/version drift requires evaluation | Unsuitable as sole authorization or enforcement. Useful for advice and escalation. |
| Hybrid deterministic authorization + optional model advice + constrained executor | Routine delegated work with escalation of ambiguous or high-impact requests | More integration effort; still limited by runner coverage and human fatigue | Rules fast path; bounded model lane; human queue only when necessary | Recommended. A model may withhold eligibility or recommend approval; only the authorized coordinator can issue a permit. |
| OS/container/remote runner enforcement without semantic review | Blocking out-of-scope filesystem/network/credential effects, including descendants | Does not decide business intent or whether an in-scope destructive change is wanted; platform gaps matter | Provisioning/startup and platform maintenance | Complement the hybrid; required where a profile promises constrained effects. |

For a future policy-language choice, [OPA/Rego](https://www.openpolicyagent.org/docs/policy-language)
evaluates structured data, while [Cedar](https://docs.cedarpolicy.com/policies/syntax-policy.html)
models principal/action/resource authorization and explicit forbid policies. Neither
creates an execution boundary. Adopting either immediately would add a second language,
distribution and compatibility burden before ORCA has trustworthy action attributes.
Keep evaluation pure and versioned so a later evaluator can be compared offline.

The primary ACP and adapter documentation is linked next to the capability claims
in [current-state](current-state.md#external-primary-documentation). Sources support
protocol/tool behavior; proposed ORCA policy semantics and cost budgets are design
recommendations, not claims those protocols provide them.

## Research validation and limits

This change contains documentation only. Validation checks the recorded baseline,
source paths and links, issue/proposal status, internal consistency and a second
researcher's adversarial review. It does not run a new safety feature, certify an
adapter, benchmark checker quality, or prove a sandbox. Implementation acceptance
requires the executable tests and real-host evidence in [assurance](assurance.md).

No runtime configuration, credentials, permission sidecars, generated artifacts,
issue metadata or release milestones are changed by this research. Publishing the
draft is a request to review architecture, not to activate delegated authority.
