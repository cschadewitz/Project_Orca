# Owned disposable file read: validation

Source under test: `dcbac0eb553e88fe2a579feb186bc90159da69e7`, based on main
`df2e623175f58f2031efb0bb7386d2de1cae8990`. Later evidence-only commits do not
change executable source. Author and committer: Calcifer Schadewitz
`<347762766+calciferschadewitz@users.noreply.github.com>`.

## Environment and setup

- Linux 6.18.55 x86_64; Node 24.19.0; pinned pnpm 12.4.2; Vitest 5.0.5.
- `AGENTS.md`, development/architecture/contributing instructions, canonical guard
  contracts, strict policy, judge, one-use fence, protected-file ownership and
  owned-root worktree boundaries were inspected. Workspace `.agents`/`.codex`
  contained no skill files. The repository's demo-development skill is not needed
  to run the documented compiled scripted demo.
- Frozen install passed, including the existing 534-entry supply-chain policy
  check. Lockfiles, lifecycle allow/deny rules and sandbox settings are unchanged.
  Offline setup lacked package metadata; the normal frozen install succeeded
  without bypasses. An available pinned pnpm binary was used; no toolchain or
  dependency version was substituted to obtain a passing check.

```sh
XDG_DATA_HOME=/workspace/.local/share XDG_CACHE_HOME=/workspace/.cache \
ELECTRON_SKIP_BINARY_DOWNLOAD=1 /workspace/.orca-tools/node_modules/.bin/pnpm \
  install --frozen-lockfile --store-dir /workspace/.pnpm-store
```

## Results

| Check | Result |
| --- | --- |
| Affected source composition, policy, resource and judge tests | 399 passed, seven files |
| Full `pnpm test --maxWorkers=2` on committed source | 8,504 passed; 36 skipped; one todo; 525 files passed / five skipped |
| `pnpm run typecheck` | Passed, root and renderer |
| `pnpm run lint` | Passed, ESLint and CSS token check |
| `pnpm run build` | Passed; existing renderer chunk-size advisory retained |
| `pnpm run format:check` | Passed |
| Explicit retry integration | Two tests passed in both required files, zero pending/skipped |
| Compiled scripted demo | Passed, three items complete; temporary demo workspace removed |
| `git diff --check`; dependency lock diff | Passed; no lock changes |

The full run exited zero: 530 total files, 8,541 total cases, on the committed
source with two workers. The ordinary suite retains its existing skips/todo; the
two required retry cases were additionally exercised explicitly as recorded below.

The affected command was:

```sh
pnpm exec vitest run \
  packages/engine/test/composed-file-guard.test.ts \
  packages/engine/test/composed-memory-guard.test.ts \
  packages/engine/test/synthetic-read-fence.test.ts \
  packages/agents/test/strict-permission.test.ts \
  packages/agents/test/strict-permission-source.test.ts \
  packages/agents/test/strict-resource.test.ts \
  packages/agents/test/review-judge.test.ts --maxWorkers=2
```

The explicit retry command was:

```sh
ORCA_RETRY_INTEGRATION=1 pnpm exec vitest run \
  packages/cli/test/admission-retry-wiring.test.ts \
  packages/integrations/test/admission-retry-acp.test.ts --maxWorkers=2 \
  --reporter=json --outputFile=/tmp/orca703-retry.json
node packages/cli/dist/main.js demo
```

The retry JSON was checked for success, both exact filenames, two passed tests,
zero pending tests and every assertion status `passed`. The demo uses only the
local scripted test agent, not a live provider. No daemon is deployed.

## Observed effect and limits

The file tests independently observe one actual call-through OS read of exactly
nine bytes at offset zero, returning `synthetic`, in each allow mode. Explicit
deny, human requirement, required-judge outage and pre-read invalidation observe
zero OS reads. Each of ten await stages exercises six changes (60 subcases):
caller cancellation, revocation, generation invalidation, changed owner, expiry
and disposal. Symlink/replacement/rename/cwd attempts still return the originally
retained inode's bytes. Missing physical facts and metadata changes before the
syscall refuse; post-read changes retain `execution-unknown`, without a response
or repeated read. The memory regression separately checks the fence's added
current-authority check after response acknowledgement settles.

Concurrent dispatch consumes once. The syscall spy, protected authorization
record adapter, response start and separate delivery acknowledgement are checked
independently. Missing/lost acknowledgements never establish delivery. Cancellation
cannot undo a read or response already started. All file trees are newly created
synthetic `/tmp/orca-owned-read-*` roots and teardown removes them.

This is Linux **source-tested**, with synthetic original authority/lease records
and an offline judge. It is **not installed/provider-qualified** and **not
production-enabled**. Native hooks/cached approvals, blanket ACP interception,
hostile same-UID/root or external writers, content sealing, arbitrary files,
remote hosts, macOS/Windows, durable crash recovery, UI, production grants and
activation are unsupported/unrun. Full/global coverage is not claimed by these
local commands; unchanged CI ratchets remain required.

Main run `40276580664` was pending at delegation and was not polled here. Earlier
`040fe081` success is prior evidence, not a claim that the new main is green.
Parent owns independent review, exact-head CI acceptance, merge and any later
separate activation decision. #703 and #706 remain open.
