# JEV restoration adapter (#395)

The shipped `orca.config.yaml` still uses the ordinary environment-configured
plugin. Same-bootstrap execution works as before. Cross-process restoration of
that default plugin remains conservatively refused until #394 supplies the
versioned runtime attachment and protected-record integration. This adapter
slice does not enable restoration by adding a config flag.

`createJevEvalRestorationAdapter(options, context)` and
`createRestorableJevEvalPlugin(options, context, bridge)` are exported through
`@orca/integrations` and `@orca/integrations/jev-eval`. The `bridge.attach(plugin,
adapter)` interface is explicitly **provisional** and can be injected by the
caller. Its default bridge now attaches the `identity`, `capture`, `validate`
and executor-only `restore` hook published provisionally in
[#394's interface comment](https://github.com/cschadewitz/Project_Orca/issues/394#issuecomment-6051433591).
The local `JevPluginRestoration` type is a structural projection of that hook,
not a replacement for the shared owner's final types. The integrator must
check it against #394's final contract and runtime implementation. No shared engine,
bootstrap, store or plugin types are changed by this slice.

## What the adapter captures

One adapter is created for one generation. It copies the effective default
model from `options.model` or `ORCA_JEV_MODEL`, and the endpoint from
`options.baseUrl`, `TYPESAFE_BASE_URL`, or the shipped HTTP default. A missing
default model is recorded as `null`; restoration cannot consult today's
environment to fill it in. A node's recorded model overrides that default.
Node rubric, questions, input identities and routing remain in the recorded
workflow/results, rather than being reconstructed from today's plugin settings.

Descriptors are strict, bounded JSON with schema version 1, stable plugin and
transport names, code and dependency digests, effective defaults, and a
non-secret credential reference/provider/account binding. Unknown fields,
versions, model aliases, malformed identities, and URLs containing userinfo,
query strings or fragments are refused. Trailing endpoint slashes are removed
at capture to match the existing HTTP provider. Capturing an adapter does not
resolve a key, copy arbitrary environment variables or call a provider.

| Option or boundary | Supported in this adapter |
| --- | --- |
| Explicit `model` / `baseUrl` | Captured and pinned for the generation |
| Environment defaults | Copied when the generation's adapter is constructed |
| Node model override | Uses the recorded workflow's override |
| Missing default model | Recorded explicitly; a node must supply its model |
| `env.TYPESAFE_API_KEY` | Never captured; the injected authorized resolver supplies the key |
| Inline `apiKey` | Non-restorable, even with a resolver |
| Arbitrary injected `provider` | Non-restorable; no callback serialization or compatible custom factory is claimed |
| Missing provider/account binding or resolver | Refused |
| Changed code/dependency identity | Refused |
| Legacy/missing descriptor | Refused; historical inputs cannot be invented |
| Completed evaluation | Existing durable result/artifact reused by the interpreter |
| Interrupted provider call | No adapter retry or reconciliation guarantee added |

## Required substrate ownership

The injected context supplies `codeIdentity` and `dependencyIdentity` as
`sha256:<64 lowercase hex digits>`. The substrate must verify these describe
the full admitted code/dependency closure, authenticate and protect the
descriptor, and validate the entire candidate before provisioning or execution.
The adapter only compares identities; an arbitrary caller-supplied digest is
not proof of equivalence, and shape validation does not authenticate a record.

The context also supplies trusted metadata identifying the current TypeSafe
provider, account, and secret reference. `env:TYPESAFE_API_KEY` by itself
does not prove account identity. `resolveCredential(binding, {signal})` must
enforce current authorization/revocation, honor cancellation, and return that
same binding together with a transient key. The adapter checks it on every
evaluation, immediately before HTTP transport. Rotation within the same
authorized account/reference is allowed; substitution of another account is
refused. Resolver failures and HTTP errors are sanitized before durable records;
responses echoing the resolved key are refused too. Resolver results may be
mutable objects or accessors: the adapter validates their fields inside the
sanitized credential boundary and captures one string key per request. That
same value is used for authorization and response checks even if the resolver's
cache rotates while HTTP is pending. Throwing credential/binding getters cannot
publish their error text.

`restore(descriptor)` returns an isolated `NodeExecutor` or a stable refusal
reason/remediation. It neither activates it nor accesses credentials. The
bridge owns binding this executor into a candidate generation and rollback of
partial failures. The provisional helper registers the same pinned executor
for current execution and exposes its adapter to that bridge. New generations
must get fresh adapters; reuse of an old adapter intentionally retains its
old defaults. Callers must preserve current authorization, ownership fencing
and permission-sidecar evaluation. No consent or live permission callback is
restored.

## Evidence and limitations

`packages/integrations/test/jev-restoration.test.ts` uses scripted HTTP and
credential resolvers. It exercises descriptor compatibility, changed defaults,
node overrides, refused bindings, sanitized failures and reopened file stores
with a fresh interpreter that reuses a completed evaluation artifact. It does
not prove daemon-process/bootstrap restoration: #394 and the separate #396
acceptance fixtures own that combined proof.

Do not resume an ambiguously interrupted paid evaluation under an exactly-once
assumption. The adapter adds no retry, provider idempotency key or side-effect
reconciliation. #297 owns that duplicate-call window and interruption semantics.
Preserve the historical store and evaluation/routing evidence. For incompatible
or missing descriptors, use compatible recorded code and authorized bindings;
otherwise start explicitly new work under current settings after reviewing any
possible prior provider effect. Never edit an old record to adopt today's defaults.
