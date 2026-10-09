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
attestation. The bounded [candidate producer](#candidate-production-and-independent-approval)
is a separate local composition tool; its output does not approve itself. Choosing
the independent approval authority and startup pin delivery path remains an explicit
integration decision before shipped defaults can be enabled. This introduces no
signer, credential, deployment, environment-variable trust shortcut, or automatic
release migration. Source trees and unverified installations remain unsupported
for restoration.

## Candidate production and independent approval

Follow-on baseline: draft [#558](https://github.com/cschadewitz/Project_Orca/pull/558)
at `a56692c51eb7b99ca9941772dc71dde847004fd3`. Its source and acceptance evidence
remain unchanged. [`tools/plugin-release.js`](../../tools/plugin-release.js) reuses
the exact lockfile-installed esbuild dependency used by
[`build-daemon.js`](../../packages/app/scripts/build-daemon.js), plus the existing
tooling TypeScript parser. It deliberately cannot inherit the daemon's native
externals or runtime `require` shim. Managed staging and desktop workflows do not
invoke it automatically.

The smallest supported candidate profile is reviewed JavaScript ESM plus inlined
JSON, with literal static/dynamic import edges and a narrow Node builtin allowlist.
Each input must be a regular file of at most 16 MiB; total input per plugin is at
most 128 MiB. Every plugin builds to one `.mjs`, without chunks or source maps.
Input and emitted-output syntax checks refuse computed/glob imports, known runtime
loaders/evaluation, CommonJS, native inputs, unsupported builtin facilities and
unresolved packages. Any bundler warning refuses. The output graph may contain
only explicitly listed allowlisted Node builtin edges. This profile is deliberately
more restrictive than the verifier's generic builtin format.

The plan is strict JSON with an ordered `plugins` array. Each item has exactly
`entry` (an absolute built `.js`/`.mjs` entry path), `id` (a unique lowercase slug)
and positive integer `schemaVersion`. Paths/specs are generated as
`plugins/<id>.mjs` and `./plugins/<id>.mjs`. Plugins are never imported or executed
during production. All bundles finish before a new destination directory is created;
an existing destination refuses rather than replacing an approved installation.

Example local candidate generation, with an independently reviewed plan:

```json
{
  "plugins": [
    { "entry": "/absolute/reviewed-build/example.mjs", "id": "example", "schemaVersion": 1 }
  ]
}
```

```sh
node tools/plugin-release.js --plan /absolute/reviewed-plan.json --out /absolute/new-candidate-directory
```

The tool writes `plugin-release.json` and its ordered bundles, using the build
process's exact Node/platform/architecture. Its only success output is
`{ "candidateManifestSha256": "...", "approved": false }`. It provides no
trusted `InstalledPluginRelease` reference, modifies no config, and installs,
signs, publishes and launches nothing. Repeating the build with the same source
layout, dependencies, runtime and pinned tooling produces identical bytes; the
tests check separate absolute source roots. An imported dependency change changes
the bundle and manifest digests. General reproducible-build certification is not
claimed across different toolchains, layouts or platforms.

These syntax/graph checks are **not semantic closure proof or a hostile-JavaScript
sandbox**. A reviewed producer must still inspect the entire source/dependency
composition for indirect/obfuscated loaders, native facilities, downloads and
behavior-bearing file access outside the bundle. A matching candidate digest says
which bytes were produced; it cannot decide that this source review occurred or
authorize its own attestation. An arbitrary generated candidate is unapproved.

### Exact remaining security/product decision

No existing approved trust authority or delivery route was found. The concrete
decision is: **who approves the complete JEV-free source/dependency composition,
runtime and resulting manifest digest, and which independently maintained startup
component is authorized to carry that literal digest?** The existing managed
launcher obtains release paths through `ORCA_RELEASE` and `.orca-release.json`;
neither is the independent plugin authority. The ordinary CLI `serve` command
does not supply `BootstrapOptions.installedPluginRelease`.

Minimal recommendation for the parent-owned next slice: approve one reviewed,
owned JEV-free test release for actual-Cal acceptance, and a separately reviewed,
operator-owned launcher outside its replaceable plugin files. That launcher should
contain the literal approved manifest digest, concrete installation root and
manifest path, then pass the reference directly to daemon/bootstrap composition.
Do not obtain the pin from candidate output at startup, YAML, RPC, an environment
variable, plugin metadata, or a manifest beside the bundle. No new signer/key is
needed for this bounded operator-reviewed authority, but choosing it is still an
explicit approval decision. The launcher wiring and any real installation/launch
remain unimplemented pending that decision; no production pin is silently injected.

[`tools/test/plugin-release.test.js`](../../tools/test/plugin-release.test.js)
exercises the actual producer, installed verifier and production bootstrap. Its
isolated ESM package dependency is synthetic, and its approved pins come only from
the test harness. It checks dependency tampering, identity changes, deterministic
bytes, missing pins, pre-import refusal, retained admitted values and unsupported
closure forms. This is executable producer/verifier plumbing, not approval of a
real release or a deployed daemon, fresh-process actual-Cal resume, or provider
acceptance. #558's existing fresh-process evidence is preserved separately. #394's
production approval/pin integration and #396's actual-Cal proof remain open.

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
