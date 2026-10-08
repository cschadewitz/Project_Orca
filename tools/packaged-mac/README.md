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
fuse/entitlement decisions. Those remain in the [existing harness design](../../docs/preparation/native-mac-testing/harness-design.md).

Tests use mocked native system observations and disposable environment canaries.
They are source evidence only. The CLI's Linux blocker is an actual local result;
all synthetic macOS versions/builds are invented, not supported-matrix evidence.
See the [current readiness ledger](../../docs/preparation/native-mac-beta-readiness/readiness.md)
for owner-required native gates.
