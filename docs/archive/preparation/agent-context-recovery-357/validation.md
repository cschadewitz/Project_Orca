# Validation for #357 context recovery investigation

30 October 2026; source baseline `a4e0fd44e2a112129034e2f4c9b33a7c95c6db99`.
This record covers investigation and runtime validation before any review-branch handoff.
Read repository `AGENTS.md`, `docs/DEVELOPMENT.md`, the existing live-input continuity
contract, and the relevant provider preparation packets. `/workspace/.agents` is empty;
there is no repository `.agents` directory. No additional local skill applied.
The cloud-environment runtime skill/network policy were inspected. GitHub reads used
connected tools; no external mutation was made. #357 and its existing durability comment
were read before selecting this slice; no new issue/comment was published.

## Passing checks

```sh
node_modules/.bin/vitest run packages/agents/test/context-recovery-357.test.ts packages/agents/test/live-input-session.test.ts packages/agents/test/acp-session.test.ts --maxWorkers=1
```

Initial investigation: **3 files / 27 tests passed** in 5.44 seconds, including **7 new tests**.
Required-load implementation: **3 files / 33 tests passed** in 5.00 seconds, including
**13 new tests**. Broader package verification also passed:

```sh
node_modules/.bin/vitest run packages/agents/test packages/engine/test/session-startup.test.ts --maxWorkers=1
```

**31 files / 1,042 tests passed** in 20.71 seconds on the final source. This exercises
the production ACP client against provider-free NDJSON peers, plus existing real
scripted-subprocess tests. It proves callback isolation and the observed adapter fallback
boundary, not provider context persistence or installed-provider acceptance.

```sh
node_modules/.bin/eslint packages/agents/src/acp-session.ts packages/agents/test/context-recovery-357.test.ts
node_modules/.bin/prettier --check packages/agents/src/acp-session.ts packages/agents/test/context-recovery-357.test.ts docs/preparation/agent-context-recovery-357/source-inventory.json
```

Both checks passed after narrowing the optional timeout error before throwing it.
Production changes are limited to the opt-in adapter boundary.

Affected agent-test TypeScript also passed with a temporary config extending the
repository root `tsconfig.json`, using just the new test as the root file and inheriting
its transitive agent/core source imports. Because the config lives in `/tmp`, set
`compilerOptions.typeRoots` to `/workspace/Project_Orca/node_modules/@types`:

```json
{
  "extends": "/workspace/Project_Orca/tsconfig.json",
  "compilerOptions": {
    "typeRoots": ["/workspace/Project_Orca/node_modules/@types"]
  },
  "include": ["/workspace/Project_Orca/packages/agents/test/context-recovery-357.test.ts"]
}
```

```sh
node_modules/.bin/tsc -p /tmp/orca-context-recovery-357-tsconfig.json --noEmit
```

Initial local text validation passed for all **4 investigation files**: UTF-8, LF, final
newline and no trailing whitespace; Markdown fences are balanced; **10 relative links**
resolve; all **27 immutable source URLs and Git blob SHAs** have the expected form.
The final check also includes the changed source/continuity documentation and added
changelog fragment; a plain `git diff --check` would not inspect untracked files.
Final text/link validation passed for **7 changed/new files**, with **13 resolving
relative file links** and the same **27 source records**. `git diff --check` passed.

## Broader check limitation

```sh
node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Stopped with the pre-existing app import error:

```text
packages/app/src/main/first-run/setup.ts(14,36): error TS2307: Cannot find module 'yaml' or its corresponding type declarations.
```

That file was untouched. No dependency install or lockfile change was made. The targeted
agent check above passes, but is not a substitute for a clean full-workspace typecheck.
Observed runtime: Node **24.19.0**, existing pnpm **11.19.0**; repository metadata pins
pnpm **12.4.2**. Validation used the existing local binaries directly. No claim of a
frozen-install or CI-equivalent full-suite run is made.

## Unperformed checks and remaining gates

- No installed provider authentication, native command, live daemon mutation, remote
  shell, provider credential, artifact installation, deployment, merge or publication.
- No real provider process/daemon restart, compaction fidelity, native filesystem crash
  consistency, permission-cached execution, shell/MCP/subagent effect or host-loss test.
- No durable late-intent store/lifecycle, provider-context verification or Continue runtime
  wiring was implemented. The adapter's required-load option is the bounded groundwork;
  the packet proposes the remaining contract under #357. No retention duration, degraded
  fallback or tolerated crash-tail loss was selected. There is no release acceptance claim.

These are explicit scope/acceptance gaps. No action was denied by approval review and no
permission request is pending. Continuing runtime acceptance requires the reviewed
contract and exact authorized provider/profile/host, not a guessed credential or an
assumption that `session/load` restarts an old permission callback.
