# Installed plugin release evidence v1 (#394)

Implementation baseline: main `db579fb7ac9cfce2e4e6901713088a80602311da`.
`packages/cli/src/plugin-release.ts` adds an installed-release verifier mounted by
the production `packages/cli/src/bootstrap.ts` loader to the
existing [plugin restoration contract](plugin-restoration-v1.md).

## Trust source and remaining deployment decision

Trusted bootstrap composition supplies an independently approved manifest SHA-256
alongside the concrete installation root and relative manifest path. The pin must
come from the operator's reviewed release composition or an authenticated release
publisher. It must **not** be derived from the manifest being checked, plugin
metadata, generation records, config YAML, RPC inputs, or `ORCA_RELEASE`.

The pin attests the producer's reviewed, complete JavaScript/dependency bundle.
The verifier compares exact installed bytes against that attestation. It does not
discover arbitrary JavaScript imports or turn a publisher's untrusted local claim
into authority. The producer must bundle every JavaScript dependency, including
dynamic imports, and refuse unbounded module loading, native dependencies, runtime
code downloads, and behavior-bearing files outside the bundle. Only explicitly
declared Node builtins can remain external. The host runtime remains a trusted
execution boundary; the attestation also requires its exact Node version,
platform and architecture.

The repository's current `.orca-release.json` has a tag/SHA and compatibility
epochs; it does not establish this complete dependency evidence. Existing managed
release staging and packaged daemon builds do not produce or distribute the new
attestation. Choosing a reviewed producer and independent pin delivery path is an
explicit integration decision before shipped defaults can be enabled. This slice
introduces no signer, credential, deployment, environment-variable trust shortcut,
or automatic release migration. Source trees and unverified installations remain
unsupported for restoration.

## Attestation format

The manifest is strict JSON, at most 128 KiB, with at most 64 plugins. All configured
plugins must occur exactly once in config order. Plugin IDs and bundle paths must
be unique. Every bundle must be a concrete regular `.mjs` file under the fixed
release root, at most 64 MiB. Paths cannot contain traversal, absolute paths,
backslashes, empty segments, or symlink aliases. A moving release pointer is not a
concrete root.

```json
{
  "contractVersion": 1,
  "runtime": { "node": "24.21.0", "platform": "linux", "arch": "x64" },
  "plugins": [
    {
      "spec": "./plugins/example.mjs",
      "id": "example",
      "schemaVersion": 1,
      "closure": "closed-node-esm-bundle-v1",
      "path": "plugins/example.mjs",
      "sha256": "<64 lowercase hexadecimal characters>",
      "externalImports": ["node:crypto"]
    }
  ]
}
```

Unknown fields, schemas, closure formats, external packages and native addons are
refused. The declared external imports are a sorted, unique list of `node:` builtin
names. The trusted producer is responsible for proving this list is complete;
the verifier checks the independently pinned attestation and refuses unsupported
declarations. No heuristic scanner is represented as closure proof.

## Derived identity and runtime checks

`loadInstalledPluginRelease(reference, entries)` validates all evidence before
returning `identityFor(spec)` and a `PluginRestorationIdentityVerifier`. Each
identity is detached and frozen. `codeVersion` is `sha256:<bundle SHA-256>`.
`dependencyIdentity` is `sha256:<SHA-256 of UTF-8 JSON>` of this canonical object,
with keys in the order shown and sorted external imports:

```ts
{
  closure: "closed-node-esm-bundle-v1",
  bundleSha256,
  externalImports,
  runtime: { node, platform, arch }
}
```

The complete installed composition is checked against the loader's pre-import
entry URLs/digests. Entry aliases, missing/additional/reordered plugins, changed
bytes, different runtime identities and unmatched declarations all refuse.
Verification rechecks the pinned manifest and **every** bundle before capture or
historical reconstruction, so a later mismatch in another plugin cannot permit
the first plugin's callback to run. Evidence read failures produce a sanitized
`RUN_STATE` / `identity_unverified`; diagnostics never include file contents,
paths from failures, or raw errors.

This verifier does not authorize historical writes, infer compatibility from
epochs, restore approval callbacks or consent, or resolve credential bindings.
Current admission, lease fencing, permission checks and separately injected
current-use credential authorization remain authoritative. Legacy/mixed plugin
and unsupported callback compositions retain the existing fail-closed behavior.

The focused tests use provider-free, synthetic closed bundles and externally
injected test pins. They prove installed-byte/refusal behavior and isolated fresh
executor reconstruction; they do not establish a deployed release publisher or
operator/provider acceptance.

## Minimum supported beta profile

Casey approved deferring JEV and keeping it disabled in today's beta on 8 October
2026. The generic recovery/security requirements remain in force. This slice adds
no JEV-specific bootstrap wiring and no provider/account catalog or resolver.

A builtin-only composition retains existing protected-definition recovery and
does not need plugin release evidence. A composition with custom executors can
claim restart restoration only when every plugin opts in and the complete ordered
composition consists of trusted, independently pinned closed bundles. It must use
builtin workspace/runtime services and preserve current authority, permission and
lease checks. Host changes, workspace-provider callbacks, plan-service callbacks,
human-input ports, builtin executor mutation and mixed legacy plugins remain
unsupported. A legacy no-op plugin cannot be added to an opted-in custom composition
to evade those restrictions.

The verifier, production bootstrap mounting and public CLI exports are implemented
in this slice. The additive seam is a trusted-only
`BootstrapOptions.installedPluginRelease` reference plus optional readonly
`PluginApi.restorationIdentity` supplied per plugin before `register`. It must never
fall back to current defaults or an unverified plugin declaration when absent.
Existing trusted verifier injection stays available; concurrent evidence and custom
verifier injection should refuse ambiguous policy selection.

On 8 October 2026 the parent explicitly designated the #394 author as owner of
`packages/engine/src/plugin.ts`, the CLI bootstrap verifier mounting and required
CLI exports. This reconciles the historical reserved-file integration rule for
these changes. The JEV lane is deferred and edits no shared bootstrap files;
app main/preload and other lanes' files remain outside this slice.

The loader validates release evidence before plugin import, supplies a frozen per-plugin
identity before registration, routes capture/recovery through the real verifier,
refuses simultaneous policies, and qualifies bundle import URLs by their verified
digest to avoid adopting a stale module-cache entry after bytes change.

The existing #396 fresh-process generic fixtures remain relevant. Their installed
attestation and Actual-Cal evidence limits remain explicit. This slice exercises
the mounted verifier through real bootstrap instances and separate fresh Node
processes with isolated provider-free executors and externally injected fixture
pins. It does not establish a deployed attestation publisher or substitute for
final operator acceptance. JEV-specific credential
metadata/resolution and real provider behavior can be deferred with JEV; generic
pin verification, protected generation integrity, authority and lease fencing
cannot be deferred for supported custom-plugin recovery.
