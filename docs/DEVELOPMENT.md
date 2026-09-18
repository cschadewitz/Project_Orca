# Development

```bash
mise install                 # Node 24 + pnpm 12 (any Node >= 22 works)
pnpm install
pnpm run lint                # tsc --noEmit over every package + tests (paths-mapped to sources)
pnpm test                    # vitest: unit tests + e2e against a real ACP subprocess
pnpm run build               # tsc -b project references -> packages/*/dist
pnpm run demo                # program run with scripted agents (from sources via tsx)
node packages/cli/dist/main.js demo   # same, from the compiled build
```

`demo --dir <path>` (or `demo --keep`, which keeps the temp workspace instead of
removing it afterwards) leaves a complete setup behind — `orca.config.yaml` wired to
the scripted agent plus its `demo-playbook.yaml` — so `orca --config <path>/orca.config.yaml
run <workflow>` exercises any workflow without an LLM. Edit the playbook to change what
the agent delivers per artifact kind.

## Package manager

pnpm, pinned by `packageManager` in `package.json` and installed by `mise install`.
Internal packages depend on each other with `workspace:*`; every package declares
what it imports, because pnpm's `node_modules` is symlinked rather than flattened
and undeclared ("phantom") dependencies do not resolve.

pnpm keeps one content-addressed store and hard links packages into each
`node_modules`, so several checkouts on one machine share the bytes: a second
fully-installed worktree costs about 1 MB instead of another ~90 MB.

**Hard links only work within a filesystem.** If checkouts do not live on the
same filesystem as the store, pnpm silently falls back to copying and the saving
disappears. On a machine whose checkouts are not under `$HOME` (build agents,
shared worktree hosts), point the store at the right filesystem once:

```bash
pnpm config set --global store-dir /srv/dev/.pnpm-store   # adjust to taste
pnpm config get store-dir                                 # verify
```

This is deliberately machine-level rather than a committed `.npmrc`: the correct
path differs per machine, and CI wants the default.

pnpm runs no dependency lifecycle scripts by default. `esbuild` (via `tsx`) needs
its postinstall, so it is allow-listed under `allowBuilds` in
`pnpm-workspace.yaml`; add to that list with `pnpm approve-builds` if a new
dependency legitimately needs to build.

## Layout conventions

- One concern per file; every file except a pure re‑export barrel starts with a comment
  saying what it is for.
- `packages/*/src/index.ts` is the public surface of a package; tests import only that
  (the CLI tests reach into `src/commands` directly).
- `core` has no runtime I/O except reading workflow/template files. `engine` depends on
  ports (`EventStore`, `ArtifactStore`, `AgentHost`, `AgentSession`), never on concrete
  transports, so it is testable with in‑memory stores and the scripted agent.
- Errors are `OrcaError` with a stable `code`; executors return `failed(code, …)` rather
  than throwing for expected failures.
- `exactOptionalPropertyTypes` is on: use conditional spreads (`...(x ? { x } : {})`) instead
  of assigning `undefined`.

## Tests worth reading first

- `packages/engine/test/sdlc.e2e.test.ts` — the full Plan→Deploy loop with retries, review
  rounds, follow‑up prompts and the auto gate, asserting on prompts the agents received.
- `packages/engine/test/program.e2e.test.ts` — decomposition, dependency‑ordered dispatch,
  blocked items on failure.
- `packages/engine/test/containers.test.ts` — loop / parallel / subworkflow / resume / cancel
  with a plugin‑registered custom node.
- `packages/integrations/test/acp-facade.test.ts` — ORCA driven *as* an ACP agent by an
  in‑process ACP client (proxy mode), including gate forwarding as a permission request.
- `packages/core/test/plan.test.ts` — the pure planning layer: dependency grammar, risk
  matrix, graph (waves, cycles incl. self‑loops, critical path around a partial cycle),
  decision matrix, scheduler classification and priorities (policy flags, weight overrides,
  superseded / deferred decisions), artifact signals, Mermaid.
- `packages/engine/test/plan.service.test.ts` — cross‑request registration (placeholders
  bound later, slug clashes, self‑references and unparsable refs), stage‑level and decision
  dependencies (a stage stays satisfied after its upstream fails; superseded / deferred
  decisions), artifact intake, risk appetite holds, and the `custom:plan-await` node waking
  on plan changes.
- `packages/engine/test/plan-dispatch.test.ts` — `custom:plan-dispatch` with `onWaiting: wait`
  (gives up after `waitTimeoutMs`, woken by a plan change rather than the poll) and `failFast`
  cancelling a sibling still running.
- `packages/engine/test/plan.e2e.test.ts` — the shipped program with decisions made by
  matrix, stage‑level pipelining (`core@spec`), build‑phase waits (`api#build`) with
  upstream artifacts in the build prompt, and a second request deferred then picked up by
  `plan-resume` (which dispatches to `vars.itemWorkflow`, i.e. `program.itemWorkflow`, not a
  pinned `ai-sdlc`).
- `packages/store/test/jsonl-log.test.ts` — the on‑disk sequencing under both JSONL stores:
  two instances over one directory, torn‑tail recovery, and the lock file's stale‑holder
  rules.

## The scripted agent

`packages/testing` ships an ACP agent that reads the deliverables block from each prompt and
writes files from a **playbook** (per artifact kind, sequential entries). It is what makes the
end‑to‑end tests and the demo deterministic and LLM‑free. Point any ACP client at
`pnpm exec tsx packages/testing/src/scripted-agent/main.ts --playbook pb.yaml` to try it.
