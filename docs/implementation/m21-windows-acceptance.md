# Milestone 21 focused completion and Windows acceptance

This branch starts at integration PR #584, `6fcd543a368246c2156f86a225072a871c754435`,
and targets `calcifer/m10-m21-m22-same-boot-config-integration`. It preserves the composed
#579/#582 ancestry. It neither merges nor closes a milestone.

## Implementation reviewed

| Issue | Corrections in this branch | Focused evidence |
| --- | --- | --- |
| #333 | Reference-selector focus after structural operations; narrow shell/Config field and review-action layout. | Renderer form, route and existing Config tests; daemon Save/Apply, reference and authority tests. |
| #334 | Mounted authorized Request overrides; exact captured input declaration and descriptor; revision/generation/grant fences; verified selection provenance; independent protected recovery grants; typed navigation drafts; pending and accepted receipt guards. | Main adapter/journal, mounted route/controller/restore, daemon preflight/projection, protocol and captured-generation tests. |
| #355 | Authoritative catalog errors; clean read-only refresh/preview; exact partial consumers; blank-ID refusal; applied history from reviewed source digests. | Mounted route/controller/editor tests and file-backed template authoring tests. |

Request preflight and admission share the defaulted in-memory Request descriptor. Declared
models, roles, item workflows and template packs are checked without contacting an agent.
Agents without model declarations retain the existing dynamic provider admission contract.
The additive persisted `itemWorkflow` provenance describes the program dispatch default;
individual nodes can pin a different child workflow. Input values remain withheld.

The read-only review's actionable findings were corrected and regression-tested: accepted
receipts incorrectly retaining an update blocker, stale read-only template previews, and
global model overrides bypassing declared choices. Final bounded review found no remaining
actionable defect in these changes.

## Later branches

#590 is native diagnostics packaging work and is not required for this focused source-built
acceptance. #591's relevant Config layout corrections (`a4292d4`, `368759a`, `a35691f`, with
their narrow-column prerequisite) were carried into the existing Config surfaces. #596 and
#599 contain unrelated diagnostics product/evidence work. This branch does not compose their
capture activation, native addon, or performance claims. Existing first-run, update and
capture gates remain intact.

## Local verification

The combined focused invocation selected 24 existing/new test files and passed 391 tests with
two supported-platform sample skips; the existing Config surface's 31 tests passed
separately. The final captured Request default guard added three passing preflight cases;
its 41-test backend/protocol check, 59 existing Request submission cases and 23 generation
cases passed after the guard. Final distinct coverage: **25 files, 425 passed, 2 skipped**,
one worker at a time. This was not a
full suite, coverage run, CI run or Actions dispatch.

Applicable affected builds passed:

```text
node node_modules/typescript/bin/tsc -b packages/app/tsconfig.json packages/cli/tsconfig.json
node node_modules/typescript/bin/tsc -b packages/app/tsconfig.preload.json
node node_modules/typescript/bin/tsc -p packages/app/renderer/tsconfig.json --noEmit
node packages/app/scripts/build-daemon.js
# packages/app cwd:
node node_modules/vite/bin/vite.js build
```

Changed TypeScript/test/config CSS ESLint and Prettier checks, CSS token checks and whitespace
checks passed. The shared design CSS fails the same Prettier check at the exact base and at
this head; this change adds only the narrow-column rule and retains existing formatting.
Vite reports the existing large-chunk warning; no threshold or splitting policy was changed.

## Real Windows/Electron acceptance

Run `node packages/app/test/milestone21/windows-acceptance.mjs` after the affected builds.
The harness is source-built Electron with the production main/preload/renderer, native
secure storage, and an owned bundled ephemeral authenticated daemon. Its workspace and
profile are disposable. It does not fabricate UID, grants, RPC results, agent responses or
native storage. Synthetic workflows park at a human gate before an unavailable executable
can run. It never contacts the live ORCA connector or agent-01.

The receipt uses public IDs, digests, method names and check booleans. It excludes raw
sources, command parameters, credentials, paths, screenshots and protected journal bytes.
Cleanup verifies the exact disposable root and awaits owned application/daemon exits.

Native run results and the sanitized receipt are recorded after acceptance completes.

## Remaining acceptance and implementation limits

Windows first-run setup is **not implemented as a successful supported path** on this
source base: `first-run/directories.ts`, `setup.ts` and `ownership.ts` require POSIX
`process.getuid()` ownership evidence. Windows supplies no such function. The real compiled
setup refuses the selected project before provisioning or connection, and the source test
records that refusal. This is an existing platform implementation limitation, not a manual
acceptance pass. No UID shim or weakened ownership check was added. The configured explicit
workspace path is evaluated separately.

Physical Mac acceptance, packaged signing/update/replacement, real agent execution,
Narrator/VoiceOver listening, and second-user filesystem attack/manual crash cases remain
unproven here. Automated keyboard, axe and geometry checks do not substitute for those
native/manual results. Milestone 21 is not closed and these issues are not represented as
fully accepted across platforms.
