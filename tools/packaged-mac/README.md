# Packaged Mac harness preparation

This bounded #388 slice implements executor observations and launch-environment
construction. It does not launch, mount, extract, sign, notarize, upload, distribute
or verify an app. It changes no workflow, manifest, lockfile or production setting.
The existing [fixture validator](../deploy/tests/native-mac/README.md) remains the
single delivery-v1 fixture validator; candidate mode remains refused.

From the repository root, using the already provisioned tooling runtime:

```sh
node tools/packaged-mac/executor-preflight.js
pnpm exec vitest run tools/test/packaged-mac-executor.test.js --maxWorkers=1
```

The preflight checks its own platform/architecture before invoking anything. On
Linux/Windows or x64 tooling it returns a closed blocker code and exits 2. On an
arm64 macOS tooling process it reads only `/usr/bin/uname -m` and
`/usr/bin/sw_vers -productVersion/-buildVersion`. Each read has a 5-second limit
and 1 KiB output limit, absolute command path and minimal environment. Failures
publish only closed codes; raw output/errors are not returned. A successful
observation exits 0 with `scope: executor-only`, `status: observed` and explicit
unchecked GUI/app/daemon architecture and unrun candidate fields. Exit 0 is not
packaged acceptance. There are no retries, provisioning or GUI/security commands.

`createMacAppEnvironment({accountHome, temporaryDirectory, locale?})` constructs
a frozen object with exactly HOME, TMPDIR, PATH, LANG and LC_CTYPE. It never reads
or spreads `process.env`, so developer tools, external daemon/renderer/workspace,
provider/signing credentials, Node injection, proxies and sandbox overrides cannot
be inherited. PATH is `/usr/bin:/bin:/usr/sbin:/sbin`; locale defaults to
`en_US.UTF-8` and accepts `C` or a syntactically valid `xx_XX.UTF-8` explicitly.
Unknown input keys and malformed paths/locale fail with closed codes.

Supply the **existing disposable OS account's actual home**. This helper does not
change the shell's HOME, create an account, resolve paths, inspect permissions or
prove isolation. Independently verify owned scratch, canonical containment, GUI
session, actual Electron profile/cache/log paths and Keychain/TCC/account boundary
before a future app launch. A temporary HOME alone cannot isolate native state.
Spaces/non-ASCII are preserved; validation is lexical, not filesystem authority.
No filesystem writes, deletion, keychain or TCC reset are implemented.

The future native harness must pass this environment explicitly to the unchanged
packaged executable and record actual app/daemon architecture and production
bootstrap. If more GUI context is required, identify and review that exact need;
do not spread the parent environment. This module deliberately does not freeze
first-run UI, profile arguments, runtime endpoints, agent support or automation
fuse/entitlement decisions. Those remain in the [existing harness design](../../docs/archive/preparation/native-mac-testing/harness-design.md).

Tests use mocked native system observations and disposable environment canaries.
They are source evidence only. The CLI's Linux blocker is an actual local result;
all synthetic macOS versions/builds are invented, not supported-matrix evidence.
See the [current readiness ledger](../../docs/archive/preparation/native-mac-beta-readiness/readiness.md)
for owner-required native gates.

## Source-bound staging plan

`node tools/packaged-mac/packaging-plan.js --source-commit <full-clean-SHA>`
prints an **unexecuted unsigned staging plan** using the existing #467 clean-source
reader. It selects exact source/version/lock/protocol/store-epoch facts, requires the
ordinary Mac policy to remain literal `identity: null` / `notarize: false`, and checks
clean selected source again before returning. Missing or changed source/policy refuses
with exit 2 and a closed code. This assumes a trusted quiescent checkout, not a hostile
concurrent writer. No subprocess for a plan step is invoked; only the reused source
reader's bounded-output Git reads run. There is no `--run` or candidate mode.

The plan lists native executor preflight, frozen installation, build, daemon bundle,
authenticated standalone probe and an explicit Mac arm64 **directory** package with
`--publish never`. It does not add a target-array overlay, create DMG/ZIP, load/import
signing credentials, derive a beta version/plist policy, or insert fixture identity
into a candidate. The source's root version is recorded, not assigned as today's beta.
All steps remain `not-run`; signed candidate status remains blocked, with named gaps.
Tests run its exact argument vector through the locked builder's actual CLI parser,
target normalizer and configuration validator without calling the build function.

Root coordinates any later Mac execution, exact tested source and approved tooling/
account/scratch setup. Commands are structured argument vectors, not a shell script:
use each exact vector from the repository root after authorization. Do not concatenate
untrusted values into shell commands. The staging package is not for invited-user
distribution or Gatekeeper acceptance. For signing sequence, native read-only checks,
both format oracles and Casey's timed action list, use the
[candidate execution packet](../../docs/archive/preparation/native-mac-beta-readiness/candidate-execution.md).

## Bounded acceptance command packet

`node tools/packaged-mac/acceptance-packet.js --source-commit <full-clean-SHA>`
plus the seven explicit local path selections documented in the
[acceptance runbook](../../docs/archive/preparation/native-mac-beta-readiness/acceptance-runbook.md)
generates command vectors only. It reuses the source/staging policy and minimal app
environment; it does not read artifacts, credentials or ambient environment, run
native commands, launch an app, extract containers or publish anything. CLI execution/
candidate switches refuse. Paths are lexical selections, not ownership or containment
proof; generated packets with real private paths stay local.

The exact locked-builder vector selects arm64 DMG+ZIP from an already accepted
stapled app with `--prepackaged` and `--publish never`. This skips signing hooks and
remains blocked on the production producer/policy/signing handoff. Twenty later
read-only observations use absolute commands, one worker, zero retries, 30-second
timeouts and 16 KiB ceilings per output stream. The app distribution descriptor
requires macOS 14+ `syspolicy_check`; it does not choose the supported-OS floor.
Both launch vectors have explicit minimal
environments and remain blocked on native validator/extraction/GUI/automation.
There is no native execution consumer or packaged Mac E2E project in this slice;
source smoke/type proof must not be reported as installed candidate acceptance.

With existing installed binaries, the focused preparation check is:

```sh
./node_modules/.bin/vitest run tools/test/packaged-mac-acceptance-packet.test.js --maxWorkers=1
```

Tests normalize the real locked builder's prepackaged targets/config without building,
check separate contained-copy paths, bounded descriptors, minimal environment with
synthetic child-only canaries, and safe CLI rejection. No Mac/credential read occurs.
