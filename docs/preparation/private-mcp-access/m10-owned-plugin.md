# M10 owned-plugin restart preparation — UNAPPROVED

This bounded cloud preparation consumes #562 at
`ec915f4f47ffec87270879c74e9bce1c4cd1bca9`, including #558 at
`a56692c51eb7b99ca9941772dc71dde847004fd3`. Root owns exact source/runtime/pin
approval, CI, merges and actual-Cal calls. Casey's routine dedicated-test-daemon
authority does not approve these candidate bytes. No host activation, agent-01
setup, connector rerouting, provider invocation, signer, account catalog, grant
change or production release occurs here.

## Exact review packet

| Item | SHA-256 |
| --- | --- |
| Entire [plugin source](../../../examples/m10-plugin/plugin.mjs), 1,695 bytes | `440a778aeb20fd25032f6888ea1be67149425fcbe7867f9f73d92427db823cc1` |
| [Candidate bundle](../../../examples/m10-plugin/candidate/plugins/m10-owned.mjs), 1,401 bytes | `8bb8dbe456f8d24b68a762e389c0ce650e2958a831cd436dec96340448b20152` |
| [Candidate manifest](../../../examples/m10-plugin/candidate/plugin-release.json), 434 bytes | `9ac49cd3b320421fa465bfce8b6876d43fff132c8c7a1ede389b25d25ea9c9ed` |
| Independent [proposed launcher](../../../tools/m10-operator/launch.mjs) | `4fa6ba9dedcc36ec14293604249c0b87c54f00e0250a243179590d4524f6127a` |

[Build facts](../../../examples/m10-plugin/build-facts.json) explicitly record
`approved:false`. The manifest format has no approval field; a manifest cannot
approve itself. The proposed launcher independently carries the literal digest
above and `ROOT_APPROVED = false`. It refuses before startup even if an environment
variable claims approval. Changing that literal guard is an operator-reviewed
action after root returns exact approval, not a generated build step.

The entire plugin executable closure is the one source file: no imports, external
packages, JSON dependencies, builtin externals, downloads, dynamic imports,
filesystem/network/process loaders, evaluation, credential bindings or JEV.
Its only moving input is the non-secret `ORCA_M10_VALUE`, strictly restricted to
`old-model` or `new-model`. This carries behavior, never authority or identity.
Registration captures `{schema:1,value}`; restoration registers a fresh custom
executor using the protected historical descriptor, without rereading the default.
The executor records one JSON result using ORCA's existing builtin artifact port;
it performs no direct file access and starts no agent. It uses builtin workspace,
store and runtime services under the existing execution authority and lease.

This reuses #396's schema/old-model/new-model restoration case and the existing
[workflow/gate shape](../../../examples/m10-plugin/workflow.yaml). The broader
[#396 fixtures](../../../packages/engine/test/restoration-acceptance/README.md)
retain their ownership and limitations. No fixture loaders or synthetic traces
from those test sources enter the release closure.

## Frozen build and launcher contract

Candidate runtime: **Node 24.21.0, Linux x64**. Runtime identity mismatch refuses;
these bytes are not a Windows/agent-01 candidate. Node executable SHA-256 is
`7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.
The frozen install used pnpm 12.4.2 and passed 535 supply-chain policy entries.
Build TypeScript is 7.0.2; the producer reuses esbuild 0.28.2 and tooling-parser
TypeScript 6.0.3. Exact lockfile and producer hashes are in build facts.

The normal `tsc -b tsconfig.build.json` multi-module build is required. The launcher
imports the supported compiled CLI export; it cannot use the desktop standalone
`main.js` bundle as an exported library. The 251 JavaScript/JSON runtime outputs
in agents/cli/core/daemon/engine/integrations/protocol/store/testing were catalogued
as sorted `{path,sha256}` entries with English locale path ordering, UTF-8 JSON
indentation 2 and final LF. Their catalogue digest is
`18397298e277df2c0af45f5d3cbf0f99eb5fd203015539f416c0d9591bffb699`;
the cloud-only catalogue is `/tmp/orca-m10-runtime-catalogue.json`. Normal locked
runtime dependencies and the root package manifest must accompany this build.
This digest is supporting build evidence, not a new trust authority.

The exact source export gap was that ordinary `serve` could not deliver
`BootstrapOptions.installedPluginRelease`. The bounded adapter
`serveWithInstalledPluginRelease(context, reference)` snapshots a separately
supplied reference and command context, requires token authentication, and routes
through the same serve implementation used by the CLI. Ordinary `serve` supplies
no release reference. No flag, YAML, RPC, environment, config schema, auth method,
grant, capability or store contract changes. Its unchanged normal serve body was
compared with #562 after whitespace normalization and removing the one added
reference spread. The large diff is that body's extraction into a shared function.

The launcher is maintained at `tools/m10-operator/launch.mjs`, outside replaceable
`candidate/` files. The fixed reviewed topology resolves a concrete candidate root;
there is no moving release pointer or startup read of a digest from candidate
output, config, RPC or environment. It accepts no arguments. It requires existing
credential/ownership files and existing workspace identity before composing the
daemon. Config must be reviewed to retain the exact isolated state path; the
[config template](../../../examples/m10-plugin/config.json) is provider-free and
does not contain a trust pin. Startup refusal exits nonzero with a bounded message.
Normal daemon runtime error handling and graceful shutdown are preserved.

## Executed source checks

On 8 October 2026, the final four-file focused run started at 17:14:30 UTC and
passed **77 tests, zero failures, zero skips**, in 19.86 seconds:

```sh
export PATH=/workspace/.orca-tools/node_modules/.bin:/opt/codex/cua_node/bin:$PATH
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.build.json
pnpm exec tsc --noEmit
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run tools/test/m10-owned-plugin.test.js tools/test/plugin-release.test.js packages/cli/test/plugin-release-bootstrap.test.ts packages/cli/test/plugin-release.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=/tmp/orca-m10-owned-final.json
```

The new five-test adapter slice reuses the compiled-production fixture with its
disposable state and retained synthetic credential/grants, and exercises actual
stdio and reference HTTP MCP clients. A separately written harness-only launcher
contains a literal synthetic test pin. This does not activate or approve the
checked-in candidate/proposed launcher. Both transports prove:

- Park a Request-free custom run at the durable gate, preserve admission intent,
  then boot a genuinely fresh daemon using `new-model` and the same store/identity.
- Refuse the old boot target; retained-key replay with deliberately adopted new
  target preserves operation/admission/run IDs. Changed payload refuses
  `RETRY_CONFLICT` and creates no new run.
- Wrong-option and duplicate durable answers refuse. Exact answer alone leaves
  the run parked with no artifact. Explicit guarded continuation settles through
  the existing current-authority path, with stable replay IDs and one execution.
- Historical artifact contains `old-model`; a distinct fresh admission contains
  `new-model`. Each has exactly one run-created event, custom completion and artifact.
- Reject unauthenticated owned composition before bootstrap; reject tampered
  bundle before import/readiness; keep the real proposed launcher UNAPPROVED
  despite attempted environment overrides.

The preserved 72 producer/verifier/bootstrap tests cover absent/wrong pins,
runtime mismatch, manifest/bundle/dependency tampering, unsupported composition,
closure/loaders, identity changes and bounded evidence. Scoped ESLint, Prettier,
root `tsc --noEmit` and whitespace checks passed; frozen candidate formatting is
excluded from Prettier because formatting changes the approved bytes.

A second focused invocation started at 17:15:40 UTC and passed **8 executed tests**
in 7.82 seconds: all six existing `serve-request-wiring` tests and the two named
#396 cases for historical/current values and live lease fencing. The name filter
left **116 unrelated tests unselected**, including JEV; those are not passes.
Report: `/tmp/orca-m10-owned-preserved.json`.

After adding explicit unchanged-principal/scope/operation assertions across the
restart, the final five-test adapter file was rerun at 17:18:40 UTC: **5 passed,
zero failed/skipped**, 14.27 seconds. Report:
`/tmp/orca-m10-owned-identity-final.json`. Source/runtime/candidate bytes and the
other focused suites were unchanged; no broad suite was repeated.

Initial adapter runs had a fixture-only incorrect answer-method name and a
startup rejection that logged with a zero process exit after installing the
keep-running runtime handler. The fixture now uses the existing `operator.answer`
contract; both proposed and harness launchers catch startup failure with exit 1.
Final reports supersede `/tmp/orca-m10-owned-initial.json` and
`/tmp/orca-m10-owned-focused.json`. No full suite, coverage, native test,
provider, host or actual-Cal acceptance was run.

## Isolated host setup and rollback recipe — owner execution only

1. Root reviews the exact source, emitted bundle, manifest/runtime tuple and
   proposed launcher. Root returns approval naming the manifest digest above and
   the exact independently maintained launcher, config root and existing dedicated
   state/auth paths. Host paths remain unresolved here. Do not create credentials,
   accounts, grants, new state identities, symlink shortcuts or fallback authority
   to satisfy a missing prerequisite. Any changed runtime/candidate/launcher needs
   renewed exact review; the UNAPPROVED guard stays false until then.
2. On the dedicated test daemon only, owner confirms existing identity, grants,
   current daemon/MCP builds, secure modes, capacity and quiescence using the
   [actual-Cal matrix](actual-cal-matrix.md). Preserve all outstanding receipts,
   inputs and uncertain outcomes. Windows/agent-01 work remains afternoon-blocked.
3. Before the approved disruption, preserve a complete consistent backup of the
   exact isolated store/auth/config and known-good daemon/MCP launch configuration.
   Record the previous service command and binary pins. No credential issue,
   scope expansion or connector routing change is part of setup.
4. Stage the reviewed normal compiled tree plus locked dependencies separately
   from the independently maintained launcher. Install only the candidate manifest
   and bundle into the exact reviewed concrete release/config root. Retain that
   dedicated daemon's existing auth directory, ownership and isolated store path;
   the cloud template's fresh paths are not authorization to substitute new host
   paths or clone live credentials into another workspace. Review/install the
   provider-free config and workflow for that same test workspace. A changed
   spec/order/path must still match the pinned manifest or startup refuses.
5. Only after exact approval, operator changes the launcher's literal approval
   guard in the separately controlled copy and uses its reviewed fixed paths.
   Preserve normal token authentication and routine local-bootstrap rotation;
   persistent MCP identity/grants remain the existing ones. No new external
   credential may be issued. Owner performs the separately approved daemon stop/
   restart in that isolated fault window. Keep current connector routing intact.
6. Parent Cal executes the existing C3a/L02 and C5b/R02 recipes: authenticated
   discovery, guard preflight, direct admission, durable input, capture of original
   intent/IDs, owner restart, new boot discovery and deliberate target adoption,
   read original admission and only approved unchanged-key replay. Exact answer
   remains separate from continuation. Continue only with the server-issued
   boundary and current authority. Read the result artifact through actual MCP;
   require `old-model`, one run and one custom execution. A separately authorized
   fresh intent under `new-model` supplies the control. Record actual tool refs,
   confirmation behavior, pins, target/scope, receipt IDs and pass/fail/blocked.
   Reference clients and CLI-only resume cannot certify this step.
7. For rollback, owner first quiesces and records unresolved intents. Stop the
   test daemon in the approved window; restore the matching known-good binary,
   independent launch configuration and, if required by compatibility, complete
   pre-change store/auth/config backup together. Do not merge partial stores or
   copy receipts as authority. Preserve uncertain intent records; rediscover and
   verify workspace/principal/grants before reopening mutation. Retire only this
   test candidate/launcher after safe retention; never delete live state or renew
   identity to make a check pass. Rollback is prepared, not automatically executed.

Remaining gates: root exact pin/launcher/path approval, separately pending #558/
#562/new-slice review/CI/merge, owner host staging/restart window, and actual parent
MCP/Cal evidence. This packet prepares one supported test composition; it does not
close #394/#396 or approve production defaults.
