# Development

```bash
mise install                 # Node 24 (any Node >= 22 works)
npm install
npm run lint                 # tsc --noEmit over every package + tests (paths-mapped to sources)
npm test                     # vitest: unit tests + e2e against a real ACP subprocess
npm run build                # tsc -b project references -> packages/*/dist
npm run demo                 # program run with scripted agents (from sources via tsx)
node packages/cli/dist/main.js demo   # same, from the compiled build
```

## Layout conventions

- One concern per file; every file starts with a comment saying what it is for.
- `packages/*/src/index.ts` is the public surface of a package; tests import only that.
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
  matrix, graph (waves, cycles, critical path), decision matrix, scheduler classification
  and priorities, artifact signals, Mermaid.
- `packages/engine/test/plan.service.test.ts` — cross‑request registration (placeholders
  bound later, slug clashes), stage‑level and decision dependencies, artifact intake, risk
  appetite holds, and the `custom:plan-await` node waking on plan changes.
- `packages/engine/test/plan.e2e.test.ts` — the shipped program with decisions made by
  matrix, stage‑level pipelining (`core@spec`), build‑phase waits (`api#build`) with
  upstream artifacts in the build prompt, and a second request deferred then picked up by
  `plan-resume`.

## The scripted agent

`packages/testing` ships an ACP agent that reads the deliverables block from each prompt and
writes files from a **playbook** (per artifact kind, sequential entries). It is what makes the
end‑to‑end tests and the demo deterministic and LLM‑free. Point any ACP client at
`npx tsx packages/testing/src/scripted-agent/main.ts --playbook pb.yaml` to try it.
