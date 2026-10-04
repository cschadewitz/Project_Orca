# Offline owned-root bootstrap preparation (#453)

This is an **inactive preparation pilot**, implemented in
`tools/deploy/owned-root-bootstrap/prepare.mjs`. It has no CLI, subprocess runner,
ACP adapter integration, installation step, service change, or activation switch.
Only Node standard-library code and synthetic fixtures have been exercised.
Controller preparation must finish before the existing ACP adapter starts an
agent. This helper grants the agent no additional permissions or run capacity.

## Review and local verification

From the assigned execution directory with an installed Node >=22:

```sh
node --check tools/deploy/owned-root-bootstrap/prepare.mjs
node --check tools/deploy/owned-root-bootstrap/prepare.test.mjs
node --test --test-isolation=none --test-reporter=tap tools/deploy/owned-root-bootstrap/prepare.test.mjs
```

Tests create `.synthetic-*` fixtures beneath the helper directory and remove only
their own fixtures afterward. They never invoke Git, pnpm, ACP, network services,
or real credentials. Interrupted fixture state is asserted before cleanup. No
full pnpm, lint, typecheck, build, app smoke, or repository suite is claimed in
this dependency-free execution root.

## Contract and trust boundary

The operator reviews a controller-held contract; it is never accepted from an
agent, root-local ready marker, environment variable, or mutable workspace file.
Supply these fields to `constructPlan(contract, controller)`:

| Field | Required evidence |
| --- | --- |
| `parent`, `root`, `cwd` | Absolute canonical paths, no symlink components; root is a direct child of parent and cwd equals root. Parent is the owner-approved admission boundary. |
| `branch`, `base`, `record` | Branch is `orca/roots/<root basename>`, base is the full 40-character SHA, and recorded `{cwd, branch, base}` agrees exactly with the owner record. Missing records block. |
| `inputs` | Sorted path-to-SHA-256 object containing root package/workspace/lock files and every immediate `packages/*` and `tools/*` package manifest. No omitted/new inputs. |
| `sourceDigest` | Reviewed source inventory digest, including file contents and permissions and directory names/modes. |
| `manager` | Exact `pnpm@x.y.z` identity matching package.json, canonical executable path, and full executable SHA-256. No Corepack or download resolution. |
| `policy` | Exact exported `POLICY`: frozen, offline, scripts and hooks disabled, copy imports. Unknown/different policy blocks. |
| `cache`, `cacheDigest` | Canonical prepopulated seed directory and reviewed full inventory digest; missing/empty/changed cache blocks. |
| `control` | Canonical controller-private directory, mode 0700, owned by the controller UID; disjoint from root and cache. |

`fingerprint(root)` and `cacheFingerprint(cache)` are read-only inventory helpers
for trusted review, **not approval functions**. Review and persist their digests
before launch; never recompute expected hashes to accept an unexpected change.
The dependency input map uses sorted insertion order. Inventory hashes cover
sorted arrays of relative paths, kinds, modes, and regular-file SHA-256 hashes.
Source excludes `.git`, `.orca`, and only the enumerated package `node_modules`
outputs. These metadata/report exclusions are not permission to change them.
Symlinks, special files, and multiply linked regular files in source or seed
are rejected. Hook/private configuration names are rejected without reading
their contents. The helper is intentionally unsuitable for repositories needing
additional dependency input types until separately reviewed support is added.

The trusted controller supplies `readIdentity(root)` using read-only Git and the
actual independent owner record. Return `{cwd, branch, head, clean, record}`;
`clean` must account for index, untracked paths, file modes, and any recovery
snapshot authorized by the owner. Preparation itself supports only fresh roots.
After preparation, the clean check may exclude only the dependency output paths
created by this operation and the owner's exact reports. Do not infer owner
records from Git HEAD, repository text, another run, or the agent's claims.
`readManagerIdentity(executable)` returns the independently verified exact
identity. Tests substitute synthetic observations for both callbacks.

Controller assertions `exclusiveBeforeAgent`, `protectedState`, and
`immutablePrerequisites` must all be true. They mean admission excludes agent
execution and other writers, the agent cannot write controller state, and seed,
toolchain and reviewed inputs cannot change during validation/copy/execution.
They are trusted attestations, not capabilities that this library establishes.
0700 does **not** isolate an agent running as the same UID. Establish OS or
controller isolation before any activation; do not set these booleans merely to
get past validation. Checks are not an atomic filesystem lock against hostile
concurrent mutation. The atomic reservation only arbitrates helper initialization.

## Planned execution and failure handling

`constructPlan` validates prerequisites without writes and returns a frozen plan.
Only plans created by this instance are accepted by `prepare(plan, runner)`.
There is deliberately no runner supplied. Synthetic tests inject filesystem-only
callbacks. A future controller runner requires separate implementation/review.
Never expose this injection point to an agent or use it to invoke live tools now.

Preparation atomically creates a root-keyed reservation in `control`, rechecks
identity/hashes/policy, creates root-local `node_modules/.orca-store`, and copies
seed bytes using exclusive file copies. It creates a private empty configuration
and home under `node_modules/.orca-home`. Every workspace package has its own
dependency output; the virtual store is `root/node_modules/.pnpm`. Planned pnpm
arguments require frozen/offline installation, scripts and pnpmfile disabled,
copy imports, isolated linker, global virtual store disabled, store integrity
checking, side-effects cache disabled, and package-manager self-management
disabled. There is no retry, online fallback, or cache population path.

The child environment is constructed from scratch, never merged with parent env:
empty PATH, private HOME/XDG/TMPDIR, empty user/global npm config, CI, and Corepack
network disabled. A future runner must use the exact absolute pinned executable,
no shell, exact cwd/args/env, all stdio ignored, and the 120-second deadline with
process-tree termination on timeout. The executable must work without PATH,
Corepack, shell wrappers, or undeclared interpreter dependencies. Stdout remains
reserved for ACP; child stdout/stderr are never forwarded. Surface only the fixed,
bounded preparation error codes, never raw logs or OS errors containing secrets.

The runner returns `{exitCode: 0, cacheComplete: true}` only with affirmative
evidence of a successful install using the approved complete seed. The helper
rechecks source/input/tool/cache digests and independently audits all output
files for hardlinks and symlinks escaping the assigned root. The local `.pnpm`
directory and regular `.modules.yaml` must exist; their presence alone does not
prove the dependency closure or tool readiness. Local pnpm symlinks
within the root are permitted; package bytes may not be shared writable hardlinks.
Only then does it return a receipt and write `prepared.json` in controller state.
There is no resume/readiness API trusting a workspace marker. A receipt describes
the controller-observed inventory at completion; it is not indefinitely valid
after the agent can change dependencies.

Reservation and `state.json` remain on success, failure, timeout, interruption,
or uncertain completion. Repeated/concurrent initialization is refused. Existing
dependency output blocks a fresh plan. No automatic deletion, rollback, repair,
or reuse is implemented. Preserve partial evidence and source edits on failure;
an operator must reconcile a failed root under a new explicitly authorized
procedure. The helper cannot roll back a malicious/defective runner's edits;
postchecks refuse readiness and leave the evidence intact.

## Future activation gates — all UNVERIFIED

1. Owner approval must name the pilot roots, exact parent/cwd/branch/base records,
   capacity/admission limit, controller-state location/isolation, immutable seed,
   dependency digests, and exact Linux Node/pnpm executable closure. Keep other
   roots and runtime/provider/workflow/service/credential configuration unchanged.
2. Validate the actual locked dependency closure on Linux with pnpm 12.4.2. The
   tracked lock inspected for this pilot contains the package-manager closure;
   workspace dependency coverage must be independently proven. Do not regenerate
   or accept new lockfiles as an implicit prerequisite of this helper.
3. Prove every planned flag is supported and effective on the pinned pnpm;
   verify no package-manager self-download or unexpected config/hook loading,
   no inherited proxy/auth/node options, exact cwd, bounded termination, stdout
   separation, and source/index/lockfile preservation with real Git observations.
4. Under independently enforced network denial, prove both complete-cache success
   and intentional cache-miss failure with zero fallback. `--offline` is not a
   general networking sandbox. Arbitrary lifecycle scripts can network even in
   offline mode; scripts remain disabled throughout this pilot. Do not enable
   them to make tool readiness pass.
5. Measure inode/link isolation and local virtual-store placement for every
   workspace package and two separately admitted roots. Mutating one root's
   installed bytes must not alter another root or the seed. Test crash windows,
   concurrent reservation, root replacement, source preservation and operator
   reconciliation; do not broaden admission or retry uncertain partial state.
6. Establish actual tool readiness with scripts disabled. esbuild's native binary
   setup and Electron's download normally rely on allowed builds in this repo;
   synthetic package bytes prove neither readiness nor test/build usability.
   Record required artifacts and independent readiness checks before ACP starts.
7. Review a minimal controller integration before the existing ACP adapter,
   including immutable prerequisite enforcement and state isolation from the
   agent. Run live acceptance only under new explicit authorization. This change
   wires nothing into ORCA and is not evidence of live acceptance.
