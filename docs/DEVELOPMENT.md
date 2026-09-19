# Development

```bash
mise install                 # Node 24 + pnpm 12 (any Node >= 22 works)
pnpm install
pnpm run typecheck           # tsc --noEmit over every package + tests (paths-mapped to sources)
pnpm run lint                # eslint (type-aware) over the same set; --fix as `pnpm run lint:fix`
pnpm run format              # prettier --write . (`format:check` to only report)
pnpm test                    # vitest: unit tests + e2e against a real ACP subprocess
pnpm run test:coverage       # the same run, with coverage and its thresholds
pnpm run build               # tsc -b project references -> packages/*/dist
pnpm run demo                # program run with scripted agents (from sources via tsx)
node packages/cli/dist/main.js demo   # same, from the compiled build
pnpm run orca serve          # the daemon, on 127.0.0.1:6722 until Ctrl-C
pnpm --filter @orca/app dev  # the app against that daemon, renderer hot-reloading
pnpm run build && pnpm --filter @orca/app start   # the same app from the built output
pnpm run design:build        # regenerate packages/design css/tokens.css + src/tokens.ts from tokens.json
pnpm run design:check        # fail if those generated files are behind (CI runs this)
pnpm run design:fonts        # re-subset packages/design/fonts from the upstream releases (by hand)
```

The app needs the Electron binary, which `pnpm install` downloads through electron's
postinstall (allow-listed in `pnpm-workspace.yaml`). CI sets
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` because it never launches the app — it still typechecks,
lints and builds the renderer, none of which need the binary; do the same locally if you
never launch it. The app reads `ORCA_DAEMON_URL` to attach to a daemon elsewhere.

## The renderer build

The app is three programs with three different runtimes, and they are built by two tools:

| part       | runtime  | built by                     | output          |
| ---------- | -------- | ---------------------------- | --------------- |
| `main`     | Node     | `tsc -b` with the workspace  | `dist/main`     |
| `preload`  | Node     | `tsc -b` with the workspace  | `dist/preload`  |
| `renderer` | Chromium | Vite (`packages/app/vite.config.ts`) | `dist/renderer` |

**Vite, on the renderer only.** Plain Vite rather than `electron-vite` or `electron-forge`:
the renderer is the only part that needs bundling (JSX, CSS imports, HMR), while main and
preload are ordinary Node ESM that the workspace's `tsc -b` already builds in dependency
order with the project references and declaration output the rest of the repo relies on.
Handing all three to a bundler would mean a second, parallel build graph for `protocol` and
`core` and would take `packages/app` out of `tsconfig.build.json` for no gain. Revisit when
packaging (`electron-builder`) lands and wants to own the whole app — that is its own ADR.

`pnpm run build` runs both: `tsc -b` then `vite build`. `emptyOutDir` in the Vite config is
scoped to `dist/renderer`, so the two never clear each other's output.

**`pnpm --filter @orca/app dev`** (`packages/app/scripts/dev.js`) compiles main and preload
once, starts the Vite dev server, and launches Electron with `ORCA_RENDERER_URL` pointed at
it; the main process loads that URL instead of the built `index.html` and opens devtools.
The renderer hot-reloads. Main and preload changes need a restart — see the comment at the
top of that script for why it is not worth watching them.

**The CSP is not relaxed by the dev loop.** `renderer/index.html` carries the production
policy (`default-src 'self'`, no `unsafe-inline`) and the build ships it verbatim. The dev
server swaps in a wider one *in memory only* — React Refresh injects an inline preamble and
Vite injects styles through JS, and HMR needs a websocket back to the dev server. Nothing
that relaxation allows can reach a built artifact, because the substitution is keyed on
`ctx.server` being present (`htmlPlugin` in `vite.config.ts`).

A consequence worth knowing before you add an asset: `assetsInlineLimit` is **0**, so Vite
emits every asset as a file instead of a `data:` URI. `default-src 'self'` blocks `data:`,
and Vite's default 4 kB threshold happens to catch the two Noto symbol subsets — the faces
the status glyphs come from — which would leave every glyph as tofu. Nothing is lost by
emitting files: the renderer loads from disk, not over a network.

**What the renderer may import.** The same boundary as the rest of the app (ADR 0008):
`@orca/protocol` and `@orca/design`, nothing else from the workspace. `no-restricted-imports`
covers `packages/app/renderer/**` as well as `packages/app/src/**`. `window.orca` is the only
other way out, and its shape is `packages/app/src/bridge.ts`, imported as a type by both the
preload that builds it and the renderer that calls it.

The renderer is its own TypeScript project (`packages/app/renderer/tsconfig.json`): DOM lib,
`jsx: react-jsx`, bundler resolution, and `@orca/*` mapped to sources so neither `dev` nor
`typecheck` needs a prior build. `pnpm run typecheck` runs it after the root project. Its
tests live beside it in `packages/app/renderer/test/**/*.test.tsx` rather than in
`packages/app/test` for the same reason — they compile against that project, not the root
one — and `vitest.config.ts` includes both globs.

`demo --dir <path>` (or `demo --keep`, which keeps the temp workspace instead of
removing it afterwards) leaves a complete setup behind — `orca.config.yaml` wired to
the scripted agent plus its `demo-playbook.yaml` — so `orca --config <path>/orca.config.yaml
run <workflow>` exercises any workflow without an LLM. Edit the playbook to change what
the agent delivers per artifact kind.

## The primitive preview

`packages/app/renderer/src/ui` is the React layer over `packages/design/css/components.css`:
`StatusChip`, `Button`, `Text`, `Duration`, `ObjectHeader`, `StateView` and the rest, each a
thin wrapper over the `orca-*` classes with no values of its own. Build screens out of these
rather than writing class names by hand; `packages/design/src/component-api.d.ts` is the
signature reference and is corrected in the PR that makes an implementation diverge from it.

```sh
pnpm --filter @orca/app dev     # then open #preview in the app window
```

`#preview` renders every primitive, both themes side by side, driven by the design system's
own lists (`RUN_STATUSES`, `SCHEDULE_CLASSES`, `STATE_VIEW_KINDS`, `THEMES`) — so a status
added to `semantics.json` appears there without anyone editing the page. It is the visual
review surface for the desktop-app milestone.

It is dev-only in the strong sense: `routes.tsx` reaches it through a dynamic `import()`
inside an `import.meta.env.DEV` branch, which Vite folds to `false` in a build, so neither
the page nor its CSS is emitted. Keep it that way if you add to it.

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
its postinstall, and `electron`'s postinstall fetches the Electron binary, so both
are allow-listed under `allowBuilds` in `pnpm-workspace.yaml`; add to that list with
`pnpm approve-builds` if a new dependency legitimately needs to build.

## Lint and format

`lint` is ESLint, `typecheck` is `tsc --noEmit`, and `format` is Prettier. They do not
overlap: `eslint-config-prettier` is applied last in the config, so ESLint has no opinion
about whitespace and Prettier has none about correctness. CI runs all three.

The config lives in `tools/eslint-config` — a workspace package rather than a root
`eslint.config.js` — because typescript-eslint cannot load against TypeScript 7, which
is what the repo builds with. The package depends on TypeScript 6 (the last release with
the JS type-checker API), and pnpm's isolated `node_modules` means the linter resolves
that copy while `tsc` keeps using 7. Nothing else in the workspace sees TypeScript 6.
Revisit this once typescript-eslint supports 7.x.

Type-aware rules are on, minus the ones that fight this codebase's idioms — async ports
that implement a synchronous method, `unknown` event payloads rendered with `String(...)`,
conditional spreads under `exactOptionalPropertyTypes`. Each exception is commented in
the config with the reason; that comment is the argument to beat if you want it back.

One local rule, `orca/file-header-comment`, enforces the first convention below.
Prettier runs at `printWidth: 120` and skips `*.md` and `templates/` (see
`.prettierignore`): prose is wrapped by hand, and a prompt template's whitespace is
part of the prompt.

The initial reformat is a single commit listed in `.git-blame-ignore-revs`. To have
`git blame` skip it locally:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Coverage

```bash
pnpm run test:coverage            # v8 coverage -> coverage/ (html, lcov, json-summary)
node tools/coverage-summary.js    # the per-package table, from the last run
open coverage/index.html          # line-by-line
```

Thresholds live in `vitest.config.ts` and are set just under the numbers the suite
reaches today, so they act as a ratchet: a change that drops coverage fails locally and
in CI, and the way to turn CI green is a test, not a lower number. Raise them when
coverage improves.

`packages/testing` is excluded. The scripted agent runs as a real subprocess in the e2e
tests, and v8 coverage collected in the test process cannot see it, so its number would
describe the collector rather than the tests. `packages/*/src/index.ts` barrels and
`main.ts` entry points are excluded for the same kind of reason.

CI measures coverage on one Node version (24), writes the per-package table into the
job summary, and uploads `coverage/` as an artifact — including when the thresholds
fail, which is when the numbers are worth reading.

CI skips the whole typecheck/lint/test/build matrix when a push or PR changes only
documentation: `docs/**` and any Markdown outside `templates/` (the prompt templates are
Markdown but the engine loads them, so they count as code). A small `changes` job diffs
against the merge base and gates the matrix with a job-level `if`, so a docs-only PR still
shows a green check rather than none — see the comments in `.github/workflows/ci.yml`.

## Layout conventions

- One concern per file; every file except a pure re‑export barrel starts with a comment
  saying what it is for. `orca/file-header-comment` enforces this in `src` (tests are
  exempt).
- `packages/*/src/index.ts` is the public surface of a package; tests import only that
  (the CLI tests reach into `src/commands` directly).
- `core` has no runtime I/O except reading workflow/template files. `engine` depends on
  ports (`EventStore`, `ArtifactStore`, `AgentHost`, `AgentSession`), never on concrete
  transports, so it is testable with in‑memory stores and the scripted agent.
- `packages/app/src` and `packages/app/renderer` import `@orca/protocol` and `@orca/design`
  and nothing else from the workspace (`no-restricted-imports` in the lint config). Anything
  the app needs from ORCA is a protocol method the daemon serves; add the schemas to
  `protocol`, the handler to the daemon's method table, then call it from the app's
  `DaemonClient` and expose it on the preload bridge. See "The renderer build" above.
- The app's own preferences (theme, per-surface density) are `packages/app/src/preferences`:
  plain Node, owned by the main process as `preferences.json` under the Electron user-data
  directory, reached from the renderer through `window.orca.preferences` and shared with it
  as types only. They are about the person, not about ORCA, so they never go in the YAML.
- Renderer tests run in `happy-dom` against the real `tokens.css` and `components.css` (see
  `packages/app/test/appearance.test.ts`). Build one `Window` per scenario: happy-dom caches
  computed style per document and does not invalidate it when the device settings (colour
  scheme, reduced motion) change.
- UI code follows `docs/design/RULES.md`: no literal colours, sizes, radii or durations,
  only tokens. `packages/design/css/tokens.css` and `src/tokens.ts` are generated from
  `tokens.json` and `semantics.json` — edit the JSON, run `pnpm run design:build`, commit
  all four together. They are committed (and marked generated in `.gitattributes`) so no
  build is needed to read a token; Prettier and ESLint skip them.
- The faces are bundled, never fetched: `packages/design/fonts` holds subset woff2 of IBM
  Plex Sans and Mono plus the two Noto symbol faces that carry the status glyphs, with their
  OFL licences. They are generated by `tools/font-build/build-fonts.js` (`pnpm run
  design:fonts`) and committed — that script, not CI, is what verifies glyph coverage. See
  `packages/design/fonts/README.md` before adding a glyph or a weight.
- Errors are `OrcaError` with a stable `code`; executors return `failed(code, …)` rather
  than throwing for expected failures. On the wire they travel as `toJSON()`, with the
  same code, plus the three `PROTOCOL_*` codes for version, method and message problems.
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
- `packages/store/test/lease-store.test.ts`, `packages/engine/test/run-lease.test.ts` — the
  single‑writer lease per run: one winner per resource, heartbeat and lapse, an unreadable
  record broken rather than obeyed, a second interpreter refused with `RUN_LEASED`, and a
  holder whose lease is broken under it cancelling itself instead of writing on.
- `packages/cli/test/commands.test.ts`, `plan.test.ts`, `bootstrap.test.ts` — the CLI as a
  user meets it: every command's arguments and failures, `orca plan`'s subcommands over a
  real plan in both the human and the `--json` form, and config discovery / plugin loading.
- `packages/cli/test/format.test.ts` — one assertion per event type, so a rendering change
  shows up as a diff rather than as a surprise in a terminal.
- `packages/integrations/test/acp-facade-prompts.test.ts` — the facade's prompt grammar
  (`/status`, `/run <id> k=v`, plain text as a Request) without an agent subprocess behind it.
- `packages/integrations/test/t3code-session.test.ts` — the T3 Code adapter against a fake
  RPC: dispatched commands, event → update mapping, and when a turn is considered finished.
- `packages/app/test/appearance.test.ts` — the renderer under the real design CSS: a custom
  property resolves from the dark block under `[data-theme="dark"]` and follows the OS
  without it, `data-density` rebinds `--row-h` on one surface only, the running pulse is
  static under reduced motion, and `⌘⇧L` / `⌘⇧D` go through the keyboard map.

## The scripted agent

`packages/testing` ships an ACP agent that reads the deliverables block from each prompt and
writes files from a **playbook** (per artifact kind, sequential entries). It is what makes the
end‑to‑end tests and the demo deterministic and LLM‑free. Point any ACP client at
`pnpm exec tsx packages/testing/src/scripted-agent/main.ts --playbook pb.yaml` to try it.
