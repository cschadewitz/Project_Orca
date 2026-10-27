# Connected producer currentness composition preparation (#706)

This implements the investigation design on exact baseline
`6a4d30dda73be89b90b7684a821d18768dcc2e14`, tree
`1584948cf2add6891575506cc57f0e73f25ff42b`. It is implementation and fixture
preparation only. No fresh traced observation, independently accepted bootstrap,
connected acceptance, command release, production designation or deployment is
claimed. The independent investigation agent's unpublished work was not used.

## Scope and retained boundaries

The installed child's bootstrap assertion already invokes its original physical
assertion before checking the original proof hash and installed inventory digest.
Previously each connected producer `check()` invoked the physical assertion and
then that bootstrap assertion, traversing the same physical state twice.

The child now supplies an optional frozen `currentnessComposition` record with
kind `connected-physical-bootstrap-v1` and the exact original physical function,
bootstrap object and bootstrap assertion function. The producer retains these
original unbound functions, receivers and evidence reference before its first
await. It checks record shape, frozen status, lane and every declared reference by
identity. For a valid composition, each `check()` invokes the retained bootstrap
assertion once with its retained receiver and requires synchronous `undefined`.
Invalid declarations or execution failures refuse without fallback. Promises,
thenables and Boolean returns refuse; no result or success is remembered.

Reference identity binds declared roles. It cannot prove that arbitrary callback
code includes the physical check. Exact independent source and image review
remain necessary. The reviewed child closure includes the physical assertion and
all prior bootstrap association assertions on every call.

An absent declaration retains the separate legacy calls. Legacy supervisors can
check different workspaces through their physical and bootstrap callbacks, so
neither names nor matching strings can establish redundancy. Replacements of the
supervisor's properties after an await cannot substitute for the retained roles.
Mutation of the underlying physical state or proof still refuses the next call.

Initial producer setup still invokes physical and bootstrap separately. The
child's initial physical check and each phase's pre/post checks remain. Every
existing producer currentness call remains, as do managed lifetime/build checks.
The latter's separate duplicate traversal is outside this change. Credential,
revocation, expiry, scope, policy, lease, root, resource, seal, cancellation and
final dispatch boundaries are unchanged. Owner expiry remains 55 seconds, process
bound 60 seconds and trace bound 256 MiB. The prior 9.82-second bootstrap and
connected Save trace-cap refusal are historical investigation context, not new
measurements or connected acceptance.

## Fixture evidence

The actual producer tests cover genuine Save, separately settled Allow once,
fresh rule execution, revocation, policy/lease mutations, interval changes,
cancellation and lost acknowledgements, together with the new composition cases:

- Every producer check selects bootstrap once; only initial setup has its extra
  physical call. Both original receivers are verified.
- Copied or substituted physical/bootstrap/assertion references, noncallables,
  missing/extra/accessor/symbol fields, unfrozen/null records, wrong kind and wrong
  lane refuse before any assertion callback or phase executes.
- Post-await property replacements retain the original functions, receivers and
  bootstrap evidence. Physical and bootstrap workspace mutations after success
  refuse the next check. Legacy callbacks continue checking both workspaces.
- Throwing, Promise, thenable, `true` and `false` composed results refuse without
  attempting a separate physical fallback.

The exact repository child runs against real flock/pipe fixtures with a synthetic
producer to instrument its actual closure. Four composed invocations plus a fifth
fresh invocation and unchanged phase pre/post checks read/hash the proof 16 times,
versus 21 through the legacy separate invocation sequence. This is a fixture call
count, not a runtime speed measurement. Fresh stat controls observe 10 physical
traversals, 30 inventory observations and 20 FIFO observations, versus 14/42/28
through the separate sequence. All file stamp fields, physical replacements,
types and FIFO identities still refuse after successful invocations.

## New review, pins and complete manifest required

Both producer and child source change. The old producer input hash and old
emitted producer hash must not be claimed unchanged. The complete local candidate
manifest is retained without reformatting in
[controlled-currentness-composition-candidate-build.json](controlled-currentness-composition-candidate-build.json).
It was built without executing the image at
`/tmp/orca-706-composition-final-image`, using Node 24.19.0 and the preinstalled
dependency tree. It contains 385 input hashes. This is a preparation build; the
installed dependencies differ from the baseline's declared package versions.
No lockfile or dependency declaration changes accompany it.

| Candidate input/file | SHA-256 |
| --- | --- |
| Producer TypeScript input | `61d62d01d32057036ea3cd638fa6a04abcf3f0b04be9973ae3c1c24ee44295a8` |
| `controlled-child.mjs` (5,713 bytes) | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |
| `controlled-producer.mjs` (2,172,826 bytes) | `242b05ae8bc5eea24dd4c81d66ad177b61dcd1788e3f48916abb8c27b0a1ba9e` |
| `controlled-build.json` (47,722 bytes) | `5ade3bc8469e81af0b04247a4a27c43b32b001aea33181ed7deed7d61584e62b` |

After independent review of the exact implementation head, the owner must:

1. Rebuild one new isolated physical image with the required frozen dependency
   installation and supported toolchain; retain its complete manifest and file
   bytes. Build roots, toolchain and dependency inputs can affect emitted hashes.
2. Review the actual producer input hash, child hash, emitted producer hash and
   every repository/dependency input in that image. Keep source correctness review
   distinct from record-reference identity checks.
3. Coherently update the disposable observer's `SOURCE` in
   `controlled_supervisor.py`, `controlled_connected.py` and
   `controlled_timestamps.py`, and `PRODUCER_INPUT_SHA` plus `CHILD_SHA` in
   `controlled_timestamps.py`, to the exact reviewed source/image. This preparation
   deliberately leaves all those pins unchanged.
4. Recheck image/source/manifest/physical inventory and original proof/plan
   associations, keeping historical source/child fixtures and all mixed-generation
   refusals. Historical evidence is not a fallback runtime trust selector.
5. Only after source and coherent pin/manifest review, perform separately
   authorized fresh bootstrap replay and connected observation under the unchanged
   owner/process/trace bounds. Fixture success grants no accepting token.

The unchanged pin suite currently refuses this candidate: its three positive
designation cases error with `installed child differs from reviewed producer
source`, and its source-correspondence case fails the old/new child hash equality.
These four failures are the outstanding review/repinning gate; they are not
connected acceptance failures or a reason to relax the selectors. The explicit
unreviewed-image refusal test and historical/mixed-generation negative controls
remain active. Production accepted-build registries, live providers, credentials,
access, OS/security settings, native Mac work and releases are untouched.

## Validation in this workspace

- Targeted producer/fdinfo Vitest suite: 65 tests pass with one worker, including
  all existing genuine Save/Allow once/rule reuse and refusal controls.
- Python discovery: 338 tests run; 334 pass and the four positive image-pin cases
  above fail at the deliberate review gate. Selecting the remaining 334 cases
  explicitly passes, including historical/mixed-generation refusals and the new
  unreviewed-image refusal. The 12 child stat tests pass through both paths.
- Workspace TypeScript `tsc -p tsconfig.json --noEmit`, ESLint on changed
  TypeScript/JavaScript, Prettier on those files, manifest/input/file digest checks
  and `git diff --check` pass.
- The separate renderer TypeScript project fails two unchanged
  `happy-dom-policy.test.ts` setting-property checks because preinstalled Happy
  DOM 20.14.5 differs from declared 21.0.4. This task does not change renderer code
  or dependencies. Validation uses preinstalled Vitest 5.0.2 and ESLint 10.11.0;
  it is not frozen-install toolchain parity with the baseline declarations.

These are source/fixture checks and a build, with no traced execution or connected
acceptance. PR metadata and integration remain with the parent owner.
