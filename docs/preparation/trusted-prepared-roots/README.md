# Trusted prepared-root contract fixtures

Preparation packet for [#505](https://github.com/cschadewitz/Project_Orca/issues/505),
a contained slice of [#453](https://github.com/cschadewitz/Project_Orca/issues/453).
It defines data and a synthetic validation oracle. It acquires no ownership and
performs no source import, dependency copy, install, runtime mutation or agent launch.

Read [contract](contract.md), [controller handoff](controller-handoff.md) and
[acceptance matrix](acceptance.md) together. The only files owned by this assignment
are this directory and `tools/test/trusted-prepared-roots.test.js`.

## Run without installed dependencies

From the repository root, using an already installed Node 22 or 24:

```sh
node --test-reporter=tap docs/preparation/trusted-prepared-roots/contract.test.mjs
```

`node:test` runs when the file is invoked directly. The explicit TAP reporter
reports every case, including passed, failed and skipped counts. The suite uses
only Node standard-library modules, reads this packet's schemas and synthetic
example, and creates no roots or files. Its Vitest discovery bridge registers
the same assertions directly when repository dependencies exist:

```sh
pnpm exec vitest run tools/test/trusted-prepared-roots.test.js
```

All identities, paths, inventory contents, resource values, journals, nonces and
readiness checks in `fixtures/synthetic-v1.json` are invented. Source-review commit
and helper hashes are the explicit provenance pins below. They are not synthetic
execution evidence. No credential, private receipt or deployed root is included.

## Frozen read pins

Repository baseline and preparation parent: `794e64344e3d6edb64e80c5920f722ff381fa4a5`.
The isolated task checkout started at exactly that commit. No incompatible newer
source was substituted. The local source reads for the handoff are pinned there:

- `AGENTS.md`, `CONTRIBUTING.md`, `docs/DEVELOPMENT.md`, `docs/ARCHITECTURE.md`,
  `.github/workflows/ci.yml`, `vitest.config.ts`, `tools/eslint-config/index.js`.
- `docs/root-worktree-isolation.md`,
  `docs/preparation/cal-first-job-experience/implementation-handoff.md` (#424).
- `packages/engine/src/workspace/owned-root-worktree.ts`,
  `packages/engine/src/workspace/git-worktree.ts`,
  `packages/engine/src/orchestrator.ts`, `packages/engine/src/admission-execution.ts`,
  `packages/engine/src/configuration-generation.ts`,
  `packages/store/src/lease-store.ts`.

The reviewed backend is at
[`b6f4345b0e8b60a75a8c8e8409a1851785e61383`](https://github.com/cschadewitz/Project_Orca/blob/b6f4345b0e8b60a75a8c8e8409a1851785e61383/docs/preparation/dependency-copy-review/README-WRAPPER.txt).
Read-only GitHub file reads covered `README-WRAPPER.txt`, `README.txt`,
`SHA256SUMS`, `copy-once.py`, `copier.py`, `relocation.py`,
`checkpoint-collector.js` and `test_guards.py` at that exact ref. Nothing from
that packet was executed or copied into this packet.

| Executable | SHA256 from the pinned checksum packet | Git blob at the pinned ref |
| --- | --- | --- |
| `copy-once.py` | `952dc2652cfb1e6d7b41e5e0267f2c6a2b7c95e3cda4f0d1e6e3e76cb2491ea5` | `eb28232ab1535cf193887bac305b1f35d3f552d8` |
| `copier.py` | `97c291ac389e65bf4c5a9176fe5d3416683782e1b7bc36a8c5e53020874c3955` | `8cb9705d86f0ae00683e27433c7c26e592fa2666` |
| `relocation.py` | `f634cb5be8e926a657e42dc42b0bb7c7042fed62b9e72d4a29e56c961286e5c1` | `3eb820bca8c1dab6b0afa51c0b2f7173aa85ec75` |
| `checkpoint-collector.js` | `a68b79c10f08ff48bb9435c4e2e453e58d875ac58ac09fd2bdfb9bdee15a93e6` | `fca765950aa290d92ff5a493f2bf5fb4d94ad8a5` |

Also read the exact linked
[independent review](https://github.com/cschadewitz/Project_Orca/issues/502#issuecomment-6009197966)
and [bounded historical copy receipt](https://github.com/cschadewitz/Project_Orca/issues/502#issuecomment-6009737432),
and [#449's enforcement contract](https://github.com/cschadewitz/Project_Orca/issues/449).
These establish reviewed semantics and evidence categories, not present readiness.

No listed skill applies to this repository fixture task. The documentation packet
was explicitly requested as repository files with a fixed destination; it is not
a Page, website, image or OpenAI product task. No production or UI files changed.
