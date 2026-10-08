# Plugin restoration contract v1 (#394)

Implementation baseline: main `65606fbce827cba914a67b999b1a47c0aab2797a`.
The API lives in `packages/engine/src/plugin.ts`; it is additive to `name` and
`register`. The production loader is `packages/cli/src/bootstrap.ts`. Restoration
is a trusted plugin-author contract, not a sandbox for hostile JavaScript.

```ts
interface PluginRestoration {
  identity: {
    id: string;
    schemaVersion: number;
    codeVersion: string;
    dependencyIdentity: string;
  };
  capture(): Record<string, unknown> | Promise<Record<string, unknown>>;
  validate(data: unknown): boolean;
  restore(data: PluginRestorationData, api: PluginRestorationApi): void | Promise<void>;
}
interface PluginRestorationApi {
  executors: { register(executor: NodeExecutor): void };
}
```

`OrcaPlugin.restoration` is optional. `PluginRestorationData` is a JSON object.
The loader records `contractVersion: 1`, ordered config spec, local entry SHA-256,
identity, data and registered custom executor types in the existing protected
generation store. Each data object is limited to 64 KiB of UTF-8 JSON, 4,096
values and depth 32. The same canonical bounded visitor validates capture,
initial generation preparation and every protected-record recovery, including
the same bootstrap. Array lengths count against the value budget before any
serialization; arrays must be dense and contain only index properties. UTF-8
JSON bytes, including escaped keys/values, are counted incrementally before
serialization. There are at most 64 records and 256 executor types per record.
Accessors, functions, non-finite numbers and non-plain objects are refused.
Public run provenance never includes descriptor data or these private identities.

## Author obligations

`id` is a stable identity unique across the entire plugin composition;
`schemaVersion` is a positive integer naming the descriptor schema.
`codeVersion` must be an immutable identity of the whole behavior-bearing
implementation. `dependencyIdentity` must name the complete immutable dependency
closure, such as a reproducible bundle or resolved dependency/lock content digest.
Changing any of these values refuses historical restoration. Declaration equality
alone is not proof: trusted composition must supply
`BootstrapOptions.verifyPluginRestorationIdentity(candidate)` and verify these
identities against installed whole-code/dependency release evidence. The candidate
contains `spec`, `identity` and the local `entry: {url, digest}`. Return `true` only
after that verification. The loader checks entry bytes additionally, but does
**not** discover arbitrary transitive imports or ship an installed-release verifier.
Without a verifier, behavior-bearing generations remain bootstrap-bound. A verifier
refusal/exception produces `identity_unverified`, before capture or restoration.
Entry equality, version epochs and moving package tags cannot establish
compatibility. No historical code is installed or downloaded during restoration.

Registration must first resolve non-secret behavioral defaults into values that
its executors actually use. `capture` returns those values when the configuration
generation is prepared. Admissions pin that generation; capture does not run
again on each launch. Capture must never reread ambient values that already
changed, serialize closures, dump environment variables, resolve credentials,
invoke providers or change operator state.

`validate` is a required explicit allowlist/schema check. It must reject unknown
fields, malformed versions, resolved secrets and unsuitable secret bindings.
There is no generic detector that can identify every secret hidden in arbitrary
plugin data. Only non-secret references/bindings may be stored. Factory and
validator exceptions are replaced by stable non-secret refusals.

`restore` receives a detached recorded data object and a registration-only API.
It must reconstruct executors exclusively from those inputs, without consulting
current defaults. It must register every recorded custom type exactly once.
No provider call, filesystem provisioning, standing grant, consent or permission
callback is permitted in capture, validation or restoration. Providers and
credential bindings remain subject to current authorization at execution time;
restoration supplies no credential resolver and grants no access. A plugin with
injected arbitrary providers must omit restoration unless it has an explicit
compatible implementation identity and authorized runtime credential boundary.

## Supported composition and isolation

Version 1 supports custom executor registration. Every configured plugin in an
opted-in generation must provide the contract and a locally resolvable entry,
and trusted composition must verify its whole-code/dependency identity.
Declarative workflow/template/agent/role inputs remain captured by the existing
generation snapshot. Other callback categories are deliberately unsupported:
host additions/replacements, in-place host or built-in executor mutations,
custom workspace providers, plan signal extractors, direct/prototype/nested plan
service replacements and plugin human-input ports. The bootstrap graph scan
classifies unrecognized plan-service mutations generation-wide; it never permits
a historical custom executor to adopt a newly replaced current plan callback.
Mixed opt-in/legacy compositions remain bootstrap-bound, including a legacy
no-op plugin alongside an opted-in custom plugin. This is an explicit v1
limitation; it does not promise general plugin composition restoration.

Recovery checks the complete ordered composition and identities before invoking
any factory. It builds a fresh builtin/custom executor registry without copying
current plugin executors. All factories and historical workflow validation must
succeed before a generation material is returned. Partial candidates are
discarded; active generations and current registries are never replaced. The
historical material selects its executor registry at execution. New admissions
continue to use the active generation and its current defaults.

Current lease fencing, admission authority and live permission-sidecar checks
remain authoritative. No live ACP process, outstanding tool approval, prior
consent or credential grant is reconstructed. Unsupported callback registrations
in the current bootstrap also prevent historical plugin recovery before effects.

## Compatibility and refusal

| Recorded generation | Same bootstrap | New bootstrap |
| --- | --- | --- |
| Builtin, no plugins | Existing behavior | Existing protected-definition recovery |
| Legacy no-op/declarative only | Existing behavior | Existing verified-entry compatibility |
| Legacy behavior-bearing plugin | Existing behavior | Refused, even if config or entry bytes match |
| Fully opted-in custom executors with trusted verification | Existing behavior | Isolated reconstruction with verified exact identities and validated data |
| Opt-in declaration without trusted identity verification | Existing behavior | Refused; equal declarations cannot grant compatibility |
| Unsupported callbacks or mixed legacy composition | Existing behavior | Refused |
| Missing/malformed protected descriptor | Refused if malformed | Refused; no adoption of current inputs |

Refusals use `RUN_STATE` and stable `details.pluginRestorationReason` values:
`invalid_descriptor`, `incompatible_identity`, `identity_unverified`, `unavailable_plugin`,
`unsupported_registration`, `reconstruction_failed`, or `legacy_generation`.
Missing/corrupt general generation definitions retain the existing generic
generation refusal. Messages contain neither raw plugin errors nor input values.

There is no automatic migration of older records. Keep the original engine
process for unsupported work, finish/cancel it before upgrades, or explicitly
start new work under current inputs. Use a compatible installation and valid
protected records for opted-in recovery. Never rewrite historical descriptors to
claim a new identity or infer missing inputs from current settings.

This bounded contract does not claim exactly-once external effects or safe
automatic replay of interrupted provider calls. #395 owns the JEV adapter; #297
owns provider ambiguity/result reuse. #396 owns fresh-process and actual Cal
operator acceptance; fresh-instance unit tests here do not replace that evidence.
The focused tests use a scripted trusted-verifier boundary. Production installed
release evidence/verifier wiring and trustworthy JEV credential metadata/resolution
remain integration requirements, and the shipped JEV default is not enabled here.

The synthetic plugin in
[`plugin-restoration-runtime.test.ts`](../../packages/cli/test/plugin-restoration-runtime.test.ts)
provides a small authoring example: registration captures its model default,
validation admits only the model field, and restoration registers an executor
closed over the recorded model. Its provider-free test also drives historical
and new admissions through the production bootstrap with changed defaults.
