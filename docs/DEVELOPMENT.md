# Development

This page is for contributors and agents who build, test or change ORCA from source. It lists
the commands and what each one changes, the build and lint rules, how the app is tested, and
the conventions code must follow. To review the code without setting anything up, read the
[documentation index](README.md), [architecture](ARCHITECTURE.md) and
[capability ledger](ROADMAP.md) instead.

## Toolchain and commands

`package.json` requires Node 24 or later and pins pnpm 12.4.2. `mise.toml` selects Node 24 and
pnpm 12.

- Use a frozen install. Do not regenerate the lockfile to make a docs check pass.
- `pnpm install` runs dependency build hooks and may download Electron. It is a setup action,
  not a check.

```bash
mise install                 # Node 24 + pnpm 12
pnpm install --frozen-lockfile
pnpm run typecheck           # tsc --noEmit over every package and test, then again over the
                             # renderer (packages/app/renderer/tsconfig.json) with JSX and DOM
pnpm run lint                # type-aware eslint over the same set, then the CSS token check
pnpm run lint:fix            # eslint --fix (eslint only)
pnpm run format              # prettier --write .
pnpm run format:check        # report only; prettier in parallel over tracked files
pnpm test                    # vitest: unit tests + e2e against a real ACP subprocess
pnpm run test:coverage       # the same run with coverage and its thresholds
pnpm run build               # tsc -b project references -> packages/*/dist, then the renderer
pnpm run demo                # program run with scripted agents (from sources via tsx)
node packages/cli/dist/main.js demo   # the same, from the compiled build
pnpm run orca serve          # the daemon on 127.0.0.1:6722 until Ctrl-C
pnpm --filter @orca/app dev  # the app against that daemon, renderer hot-reloading
pnpm run build && pnpm --filter @orca/app start   # the same app from the built output
pnpm run app:smoke           # Playwright drives the built app against a demo daemon
                             # (needs the Electron binary; use xvfb-run on a headless box)
pnpm run app:upgrade-launch  # the built app and daemon on a store ORCA 0.6.0 wrote (CI runs this)
pnpm run design:build        # regenerate packages/design css/tokens.css + src/tokens.ts
pnpm run design:check        # fail if those generated files are behind (CI runs this)
pnpm run design:fonts        # re-subset packages/design/fonts from upstream (by hand)
```

The app needs the Electron binary. `pnpm install` downloads it through electron's postinstall,
which is allow-listed in `pnpm-workspace.yaml`. CI sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
because typecheck, lint and the renderer build do not need it. Do the same locally if you never
launch the app. Set `ORCA_DAEMON_URL` to point the app at a daemon elsewhere.

### What each command changes

| Effect | Commands |
| --- | --- |
| Writes files | `format`, `lint:fix` |
| Generates assets | `design:build`, `design:fonts` |
| Starts processes; can write workspace or store data | `demo`, `serve`, app `start`/`dev`/smoke, `orca ping`, real-agent `run`/`submit` |
| Changes operator state | `answer`, `resume`, `cancel`, `claims release`, `leases break`, `config apply`, credential commands |
| Affects external installs | Release, service, feed and signing recipes |

Check the exact target and your authorization before running anything in the last three rows.
For a documentation review, check command syntax without running live, provider or host steps.

## Runtime integration checks

- `orca serve` defaults to token mode. The app and CLI use the bootstrap token file. Do not turn
  off authentication to make a smoke fixture pass.
- Legacy fixtures that need it set `auth: {mode: "loopback-unauthenticated"}` explicitly.
- The Electron smoke fixture passes its temporary workspace's token file to its RPC helper and
  the app.
- Run the combined suite and app smoke on the exact integration head before treating separate
  feature branches as accepted.

CI runs the two `ORCA_RETRY_INTEGRATION=1` cases (CLI and ACP) explicitly on Node 24, with at
most two Vitest workers and a three-minute limit. It checks the report, so a skipped case fails.
The CLI case uses a local authenticated daemon and a synthetic workflow; the ACP case an
in-process client and file-backed claims. Neither needs a provider credential. They do not
prove Electron keychain restart or the full key lifecycle in #331.

## CI

- **Runners.** `ci.yml` picks Tyler's self-hosted runners (`tyler` label, 20 Vitest workers)
  when one is idle, and GitHub-hosted `ubuntu-24.04` (2 workers) otherwise. Fork PRs always get
  hosted runners. Every Vitest step is also capped at one less than the available CPUs. See
  [CI runners](ci-runners.md).
- **The required check** is `check (node 24)`, on every PR and main push.
- **Selection.** Audited ordinary prose gets light text and local-link checks. Package source
  and test changes run the affected package domains and their consumers. Core, store,
  protocol, testing, security, configuration, non-import dependency triggers, mixed changes and
  missing graph evidence run everything. Every code lane still builds, runs the no-skip retry
  cases and compiled smoke, and runs statics on Node 24. See
  [selection policy](ci-shadow-selection.md#current-pr-execution).
- **Coverage.** Eligible PRs defer global coverage to main. Every main push and every full or
  fallback PR keeps the global and app thresholds. A partial selection is not full-suite or
  coverage proof.
- **Only `ci.yml` runs automatically before merge.** Desktop packaging, App smoke, type proof
  and native UI projects run by manual dispatch and as reusable release checks. Their Linux
  jobs use Tyler's runners when idle. CodeQL is manual only. Read the workflow before you
  dispatch it.
- **Changelog check.** `.github/workflows/changelog.yml` is manual: dispatch it with a
  `pull_request` number. It fails if `packages/` changed without a new fragment in
  `changelog.d/`, unless the PR has `no-changelog` or `release`. Label changes do not trigger
  it. Release notes are still required.

## Documentation-only review

For a prose-only change:

1. Inspect the final path diff and run `git diff --check`.
2. Check relative links and fragments, command names and flags, and source claims in the
   changed documents.
3. Check UTF-8, LF line endings, a final newline, trailing whitespace and balanced fences.
   `.prettierignore` skips Markdown and the frozen review, so Prettier passing says nothing
   about prose.
4. Keep dated recipes and their source pins apart from current instructions.

Run runtime checks only when executable docs, templates or behaviour change, or a specific
concern needs them. A prose fix does not need the broad suite or platform workflows. Report
the checks you ran and the jobs you skipped; the PR template's checklist is not proof.

## Desktop packaging probes

**Windows only.** Run **Desktop → Run workflow → platform: windows** on the branch. It packages
x64 and arm64. It does not install or launch them on Windows 11.

**Windows and Linux.** Choose **platform: windows-linux**. It packages both Windows
architectures and the Linux targets, without a Mac job. The Linux leg keeps its display and
Chromium sandbox prerequisites and its packaged-daemon start check: provision the runner, do not
bypass the checks. It runs on Tyler's runners when idle, hosted otherwise.

- `all` and release calls keep all three platforms. Reusable calls reject reduced matrices.
- Packaging does not prove fresh-install acceptance on Windows 11 or Ubuntu 24.04.
- Before handing a package to a tester, record the source SHA, version, run and attempt, and
  artifact sizes and hashes.
- A fresh-workspace Windows 11 test does not prove update, rollback, signing or guard
  acceptance.

**Bundled daemon probe.** After `pnpm run build` and
`pnpm --filter @orca/app run build:daemon`, run `node tools/probe-bundled-daemon.js`. It repeats
the Desktop workflow's authenticated `hello` check, which `desktop.yml` runs on every platform
before packaging; a nonzero exit fails the job. It requires authentication, checks the bundle's
version and process and store identity, bounds transport and output, and cleans up its child
and workspace. Only its sanitized summary or failure code reaches the log. It checks the bundle
under the runner's Node. It does not prove packaged Electron launch, Apple Silicon, signing,
Gatekeeper, TCC or the installed-app acceptance in #388.

## The renderer build

The app is three programs built by two tools:

| Part | Runtime | Built by | Output |
| --- | --- | --- | --- |
| `main` | Node | `tsc -b` with the workspace (ESM) | `dist/main` |
| `preload` | Node | `tsc -b`, its own project (CommonJS) | `dist/preload/index.cjs` |
| `renderer` | Chromium | Vite (`packages/app/vite.config.ts`) | `dist/renderer` |

**Why plain Vite, on the renderer only.** Only the renderer needs bundling (JSX, CSS imports,
HMR). Main and preload build with the workspace's `tsc -b`, in dependency order with project
references. Bundling all three would need a second build graph for `protocol` and `core`.
Packaging uses `electron-builder`; its daemon bundle is separate
([Updating](UPDATING.md)).

`pnpm run build` runs `tsc -b`, then `vite build`. Vite's `emptyOutDir` is scoped to
`dist/renderer`, so neither clears the other's output.

**The preload must be CommonJS (#198).** `createWindow()` sets `sandbox: true`, and Electron
runs a sandboxed preload as a plain script. An ESM preload is refused, the error goes to the
renderer's console, and the only symptom is `window.orca === undefined`. If you move the file:

- The source is `src/preload/index.cts`. Under `module: NodeNext` a `.cts` file emits CommonJS;
  no compiler option sets the output extension.
- `packages/app/tsconfig.preload.json` is its own composite project, because the package's
  `include` (`src/**/*.ts`) does not match `.cts`. It is listed in `tsconfig.build.json`, and
  the root `tsconfig.json` names the `.cts` so typecheck and type-aware lint see it.
- **Keep the preload's imports to `electron` plus type-only imports.** The single
  `import electron = require("electron")` is what `verbatimModuleSyntax` requires for a
  CommonJS file. It has a documented `eslint-disable`.

**Checking the bridge on a headless box:** run `orca demo --dir <dir> --keep`, then
`orca --config <dir>/orca.config.yaml serve`, then launch the built app under `xvfb-run` and
check the status bar reads `connected`. `ELECTRON_RUN_AS_NODE` must not be set. `xvfb-run`
swallows Electron's flags unless they are behind `/bin/sh -c`.

**`pnpm --filter @orca/app dev`** (`packages/app/scripts/dev.js`) compiles main and preload once,
starts the Vite dev server, and launches Electron with `ORCA_RENDERER_URL` pointing at it. The
main process loads that URL and opens devtools. The renderer hot-reloads; main and preload
changes need a restart (the script's header says why).

**The dev loop does not relax the shipped CSP.** `renderer/index.html` has the production policy
(`default-src 'self'`, no `unsafe-inline`), and the build ships it as is. The dev server swaps
in a wider policy in memory only, keyed on `ctx.server` (`htmlPlugin` in `vite.config.ts`).

**`assetsInlineLimit` is 0.** Vite emits every asset as a file, never a `data:` URI, because
`default-src 'self'` blocks `data:`. The default 4 kB limit would inline the two Noto symbol
subsets and turn every status glyph into tofu.

**What the renderer may import:** `@orca/protocol` and `@orca/design`, nothing else from the
workspace (ADR 0008). `no-restricted-imports` covers `packages/app/renderer/**` and
`packages/app/src/**`. The only other way out is `window.orca`, whose type is
`packages/app/src/bridge.ts`.

**The renderer is its own TypeScript project** (`packages/app/renderer/tsconfig.json`): DOM lib,
`jsx: react-jsx`, bundler resolution, and `@orca/*` mapped to sources so `dev` and `typecheck`
need no prior build. Its tests live in `packages/app/renderer/test/**/*.test.{ts,tsx}` because
they compile against that project; `vitest.config.ts` includes both globs.
`renderer/test/harness.tsx` sets up what `main.tsx` installs above React.

### Demo workspaces

`demo --dir <path>`, or `demo --keep` to keep the temp workspace, leaves an `orca.config.yaml`
wired to the scripted agent and its `demo-playbook.yaml`. Then
`orca --config <path>/orca.config.yaml run <workflow>` runs any workflow without an LLM. Edit the
playbook to change what the agent delivers per artifact kind.

To see a UI change with data on every surface, run
`node .claude/skills/orca-demo-dev/scripts/start.mjs --seed`. It builds a demo workspace once
(with editable workflow copies), seeds it through the daemon with succeeded, running, failed and
cancelled runs, waiting gates and a plan, rebuilds `@orca/design`'s dist, and starts
`orca serve` and `pnpm --filter @orca/app dev`. `.claude/skills/orca-demo-dev/SKILL.md` lists
the flags.

## The primitive preview and the type proof

`packages/app/renderer/src/ui` is the React layer over `packages/design/css/components.css`:
thin wrappers over the `orca-*` classes with no values of their own. Build screens from these.
`packages/design/src/component-api.d.ts` is the signature reference; correct it in the PR that
diverges from it.

```sh
pnpm --filter @orca/app dev     # then open #preview in the app window
```

**`#preview`** renders every primitive in both themes, driven by the design system's lists
(`RUN_STATUSES`, `SCHEDULE_CLASSES`, `STATE_VIEW_KINDS`, `THEMES`). A status added to
`semantics.json` appears without editing the page.

**`#type`** (#194) shows that glyphs look right next to the words, which the font build cannot.
`tools/font-build/build-fonts.js` proves each file has every codepoint claimed for it. `#type`
shows every type style in `tokens.json` with sample text, the eight statuses as chips and
glyphs, the connection states, ids in `mono-id`, and `mono-log` output with box-drawing rules.

Its **"bundled faces on/off" toggle** removes every bundled family from the stacks. A glyph
that falls through to the OS still renders, in another face, so the failure is silent. With
faces off, U+23F8 (`held`) is tofu on Linux. **Anything that does not change when you flip the
toggle was never coming from a bundled face.**

`packages/app/test/smoke/type-proof.spec.ts` photographs `#type` on Linux, macOS and Windows and
diffs committed baselines (#213). See [Screenshot baselines](#screenshot-baselines).

Both routes are dev-only: `routes.tsx` imports them dynamically inside an
`import.meta.env.DEV` branch, which Vite folds to `false` in a build. Keep it that way.

## Package manager

pnpm, pinned by `packageManager` in `package.json` and installed by `mise install`.

- Internal packages depend on each other with `workspace:*`.
- Every package declares what it imports. pnpm's `node_modules` is symlinked, so undeclared
  ("phantom") dependencies do not resolve.
- pnpm hard-links from one content-addressed store, so a second checkout costs about 1 MB
  instead of about 90 MB. **Hard links work only within one file system.** If checkouts are not
  on the store's file system (for example, not under `$HOME`), pnpm silently copies. Set the
  store once per machine:

  ```bash
  pnpm config set --global store-dir /srv/dev/.pnpm-store   # adjust to taste
  pnpm config get store-dir                                 # verify
  ```

  This is per machine, not a committed `.npmrc`, because the right path differs and CI wants
  the default.
- pnpm runs no dependency lifecycle scripts by default. `esbuild` (via `tsx`) and `electron`
  need theirs, so both are in `allowBuilds` in `pnpm-workspace.yaml`. Add others with
  `pnpm approve-builds` only when they really need to build.

## Lint and format

`lint` is ESLint, `typecheck` is `tsc --noEmit`, `format` is Prettier. CI runs all three.
`eslint-config-prettier` is applied last, so ESLint ignores whitespace and Prettier ignores
correctness.

- **The config is the `tools/eslint-config` workspace package**, not a root `eslint.config.js`.
  typescript-eslint cannot load against TypeScript 7, which the repo builds with. The package
  depends on TypeScript 6 (the last with the JS type-checker API); pnpm's isolation keeps `tsc`
  on 7. Revisit once typescript-eslint supports 7.x.
- **Type-aware rules are on**, minus those that fight two idioms: async ports implementing a
  sync method, and conditional spreads under `exactOptionalPropertyTypes`. Each exception has a
  comment with its reason in the config.
- **`no-base-to-string` and `restrict-template-expressions` are on.** Event display goes through
  `EventPayload` (`packages/core/src/events/event-payload.ts`): primitives keep their spelling,
  object and array fields become `[invalid]`, absent optional fields stay absent, and gate
  options accept legacy strings and labelled objects. Structured journal fields use explicit
  JSON. This is a display boundary, not validation; it does not rewrite stored events or change
  redaction. CLI and daemon plan summaries share `planEventSummary`.
- **Workflow expressions keep JavaScript coercion** through `coerceWorkflowString`, which has
  the one line-level `no-base-to-string` exception. Do not use it for event display; the tests
  enforce different behaviour for each.
- **`orca/file-header-comment`** enforces the first layout convention below.
- **Prettier** runs at `printWidth: 120` and skips `*.md` and `templates/` (`.prettierignore`).
  Prose is wrapped by hand; a template's whitespace is part of the prompt.
- The initial reformat is one commit in `.git-blame-ignore-revs`. To skip it in `git blame`:

  ```bash
  git config blame.ignoreRevsFile .git-blame-ignore-revs
  ```

### Design tokens in lint

**`pnpm run lint` enforces rule 1 of `docs/design/RULES.md`** (no literal colours, sizes, radii,
durations or z-values in component code; #153):

| Half | Run by | Covers |
| --- | --- | --- |
| Stylesheets | `pnpm run lint:css`, chained from `lint` | every `.css` under `packages/app/renderer`, and `packages/design/css/components.css` |
| TSX | the `orca/design-tokens-only` ESLint rule | inline `style={{ … }}` objects under `packages/app` |

- **CSS** rejects hex colours, colour functions, CSS colour names, `px`/`rem`/`ms`/`s` values and
  a `z-index` that is not `var(--z-*)`. It allows `0`, percentages and `fr`, `em`, `ch`, `vh`,
  `vw`, `deg`. It skips comments, quoted strings, `url()` and at-rule preludes, so
  `@media (max-width: 900px)` is fine but a literal inside that block is not. (`ch` is half an
  em in this app, because both stacks lead with symbol faces that have no "0"; see
  `docs/design/README.md`, Type.)
- **TSX** rejects a colour or a `px`/`rem`/`ms` string in an inline style, and a non-zero bare
  number for `width`, `height` or any `padding*`. A string `style` prop (`<Text style="caption">`)
  is the design system's own and is allowed.
- The scanner is `tools/eslint-config/css-tokens.js`, not stylelint, because stylelint would need
  a regex per property and miss new properties. Fixtures are in
  `packages/design/test/token-lint.test.ts`.

**The fix is to add the token.** Put the value in `packages/design/tokens.json` with a `usage`
note, run `pnpm run design:build`, and use `var(--your-token)` or `v('your-token')`. For a value
no token could sensibly name, `/* orca-allow-literal: why */` suppresses its line and the next.

There is exactly one such note in the tree: `.orca-visually-hidden` in `components.css`
(#262), on the `1px` that keeps the box in the accessibility tree. Rules for new notes:

1. Reaching for the same kind of literal again means a token family is missing, not an
   exemption.
2. A new note claims "no token could sensibly name this". It argues that in its own text, with
   a reason, not an issue number.
3. A reviewer may ask for the token instead.

## Coverage

```bash
pnpm run test:coverage            # v8 coverage -> coverage/ (html, lcov, json-summary)
node tools/coverage-summary.js    # the per-package table from the last run
open coverage/index.html          # line by line
```

- Thresholds are in `vitest.config.ts`, set just under today's numbers. They are a ratchet: fix
  a drop with a test, not a lower number. Raise them when coverage improves.
- Excluded: `packages/testing` (it runs as a subprocess v8 cannot see), `packages/*/src/index.ts`
  barrels, `main.ts` entry points, `renderer/src/main.tsx` (only runs in a real window) and
  `renderer/src/preview/**` (galleries).
- `packages/app/renderer/src` and `packages/app/src` have extra glob thresholds. A glob threshold
  is an additional check on a subset; those files still count in the overall numbers.
- CI measures coverage on Node 24, writes the per-package table to the job summary, and uploads
  `coverage/` even when thresholds fail.

## Layout conventions

- **One concern per file.** Every file except a pure re-export barrel starts with a comment
  saying what it is for. `orca/file-header-comment` enforces this in `src`; tests are exempt.
- **`packages/*/src/index.ts` is a package's public surface.** Tests import only that. CLI tests
  may reach into `src/commands`.
- **`core` does no runtime I/O** except reading workflow and template files. `engine` depends on
  ports (`EventStore`, `ArtifactStore`, `AgentHost`, `AgentSession`), never on transports.
- **The app imports only `@orca/protocol` and `@orca/design`** (`no-restricted-imports`). To give
  the app something new: add the schema to `protocol`, the handler to the daemon's method
  table, the call to the app's `DaemonClient`, and expose it on the preload bridge.
- **App preferences** (theme, per-surface density) are `packages/app/src/preferences`: plain
  Node, owned by the main process as `preferences.json` in Electron's user-data directory,
  reached through `window.orca.preferences`. They are about the person, so they never go in the
  YAML. They are edited on the Config surface in a section marked as stored by the app, and save
  immediately. `Appearance.set` (`renderer/src/appearance.ts`) applies the attribute and
  persists the patch, so `data-theme`, `data-density` and the file have one owner.
- **Renderer tests run in `happy-dom`** with the real `tokens.css` and `components.css`
  (`packages/app/test/appearance.test.ts`). Build one `Window` per scenario: happy-dom caches
  computed style and does not invalidate it when colour scheme or reduced motion change.
- **The window chrome** is `packages/app/renderer/src/App.tsx` plus `renderer/src/chrome`: title
  bar, sidebar, primary pane, docked panel, status bar. A screen is the child of `PrimaryPane`,
  the surface root (`data-surface`) that density is stored by. The two layout breakpoints come
  from `BREAKPOINTS` through `use-breakpoints.ts`, because a media query cannot read a custom
  property. Shortcuts register in the `KeyboardMap` (`useKeyboard`), never on `window`, so the
  palette (#149) lists them all.
- **UI code uses only tokens** (`docs/design/RULES.md`). `tokens.css` and `src/tokens.ts` are
  generated from `tokens.json` and `semantics.json`: edit the JSON, run
  `pnpm run design:build`, commit all four. They are committed, marked generated in
  `.gitattributes`, and skipped by Prettier and ESLint.
- **Fonts are bundled, never fetched.** `packages/design/fonts` holds woff2 subsets of IBM Plex
  Sans and Mono and the two Noto symbol faces, with their OFL licences, generated by
  `tools/font-build/build-fonts.js` (`pnpm run design:fonts`) and committed. That script, not CI,
  checks glyph coverage. Read `packages/design/fonts/README.md` before adding a glyph or weight.
- **Errors are `OrcaError` with a stable `code`.** Executors return `failed(code, …)` for expected
  failures instead of throwing. On the wire they travel as `toJSON()`, plus the three
  `PROTOCOL_*` codes for version, method and message problems.
- **`exactOptionalPropertyTypes` is on.** Use conditional spreads (`...(x ? { x } : {})`), not
  `undefined`.
- **Release notes are fragments.** A PR adds `changelog.d/<issue>-<slug>.<section>.md` and never
  edits `CHANGELOG.md`, which is rendered at release. See `changelog.d/README.md` and
  [RELEASING](RELEASING.md).
- **`tools/` scripts are plain JavaScript** run by node with no build, outside the workspace's
  `tsconfig.json`. Their tests are JavaScript in `tools/test/`, included by `vitest.config.ts`.
  Deployment tooling also has Python (`tools/deploy/orca-release.py`), outside that suite.

## Testing the app

The renderer test kit is three modules in `packages/app/renderer/test/`:

| Module | Does |
| --- | --- |
| `harness.tsx` | Installs what `main.tsx` installs above React (keyboard map, layer stack, palette sources, appearance, notification stream). `installBridge()` is the short way to a fake daemon. |
| `themes.tsx` | Mounts a component once per theme with the real CSS, and asserts on resolved colours: `inBothThemes(ui, ({ theme, container }) => …)`, then `resolved(el, "color")` against `expectedToken(theme, "status-failed")`. **Name the token; never paste the hex.** |
| `fake-bridge.ts` | A `window.orca` that answers `hello`, the five read methods and notifications from `fixtures.ts`. It pages, filters and counts like the daemon's `ReadModel`. `fake.fail(...)`, `fake.hold(...)`, `fake.notify(...)` and `fake.calls` cover the rest. The fixtures were dumped from a real `ReadModel` and are parsed through the protocol schemas, so a protocol change breaks that file first. |

### The Electron smoke test

`packages/app/test/smoke/app-shell.spec.ts` launches the built app with Playwright against a
daemon on an `orca demo` store. It checks:

- the window has a bridge (what an ESM preload broke, #198);
- `hello` reached the daemon;
- both themes render and resolve different tokens;
- axe finds no violations on any of the six surfaces in either theme;
- every status on the attention list, run tree and status bar keeps its glyph and word with
  colour removed (#167).

Each audited surface names a node only its real content produces, so the audit never runs over
a spinner. The spec fails unless `AUDITED` names every surface in `@orca/design`'s
`SURFACE_IDS`. It reaches each surface by the `⌘<n>` digit its position gives it.

It is also the only place **scrolling is measured** (#277). `scroll-sweep.test.tsx` runs under
happy-dom, which has no layout, so it only checks that each surface and each Plan mode in
`PLAN_MODES` declares a scroll region. The smoke spec shrinks the window to 1280×340 and checks,
for every surface and for the docked panel with the Plan inspector, that the right box
overflows, scrolls to its end, and shows its last child there. It then restores 1200×800, the
size later specs expect.

`orca demo` runs the program to completion, so it leaves no waiting gate, no failed run and one
host. `test/smoke/daemon.ts` adds a second host, a failed run and a parked gate through the
daemon's own RPC and config file. **Do not change `orca demo` for this**; it is a first look
at ORCA and has its own users.

Run it:

```bash
pnpm run build && pnpm run app:smoke
xvfb-run -a pnpm run app:smoke          # on a headless Linux box
```

Linux needs `xvfb-run` and unprivileged user namespaces for Chromium's OS sandbox, as the
[App smoke workflow](../.github/workflows/app-smoke.yml) checks. If that is unavailable, report
the blocker or use an environment that keeps the sandbox. **Keep the OS sandbox on.** The
separate `webPreferences.sandbox: true` setting also stays on, and the test checks it.

### The type proof

`packages/app/test/smoke/type-proof.spec.ts` (`pnpm run app:type-proof`) checks that the bundled
faces render the same on Linux, macOS and Windows (#213). `#type` is dev-only, so this spec does
not use the built renderer. It compiles main and preload with
`tsc -b packages/app/tsconfig.preload.json`, starts a Vite dev server, and opens Electron at
`ORCA_RENDERER_URL` plus `#type`, as `packages/app/scripts/dev.js` does. **The production bundle
must stay unchanged.** Besides the screenshots it checks that no bundled `@font-face` ended at
`error`, and that the faces toggle changes the measured width of the declared glyphs.

When glyphs change, review the type-proof baselines on every platform.

### Native encrypted admission-intent acceptance

`pnpm run build && pnpm run app:admission-intents` runs the production app and the built
authenticated daemon on disposable data.

1. The `admission-daemon.ts` fixture runs the real CLI `serve` over one agent-free start-to-end
   workflow. It does not use `orca demo`, scripted agents or request seeding.
2. Before the daemon starts, a synthetic ownership file exercises the compiled
   `OwnershipStore.record` and `flush`. Evidence is a passed stage or an allowlisted errno from
   `lastError` (else `UNKNOWN`), never a raw cause, message or path.
3. The test starts a run through the real preload bridge and `operator.discover`, closes
   Electron, reopens the same profile, and recovers the same retained intent and admission.
   Public receipt ids, an authenticated `admissions.get` and the server run count show replay
   recovered the original work. It covers restart after acceptance, not a crash before
   acknowledgement.

**Profile identity.** The temp profile is canonicalized before Electron starts. Each process
must have matching canonical paths and matching, meaningful directory identities. Raw string
equality is recorded separately. Missing or unreliable identity never counts as a match.
Reports hold only the comparison booleans.

**Where it runs.** The `admission-intents` Playwright project runs on the macOS and Windows
type-proof runners in `app-smoke.yml`, after the type-proof report uploads. It needs a full
build. A type-proof failure does not suppress it; neither result is optional. Each has its own
output directory and artifact.

**Native storage is required.** The test records `isEncryptionAvailable`, the Electron version
and a Keychain or DPAPI provider label. `getSelectedStorageBackend` (Linux only) is not invented
elsewhere. Missing storage, an encrypt or decrypt failure, or a blocked permission prompt fails
acceptance. A skip, or the negative test, never counts as a pass. The negative test changes only
the availability function in its own process and checks the bridge refuses before any
`runs.admit` or journal write.

**Never, to make this pass:**

- unlock or create a keychain, change ACLs, disable a sandbox, or force a plaintext backend;
- approve an OS permission prompt automatically.

A watchdog outside Electron can end only the disposable child if a prompt blocks shutdown. Any
OS permission or credential entry needs a person's approval. The workflow provisions no OS
storage.

**Evidence is allowlisted:** method names and counts, public discovery and receipt ids,
availability, hashes and booleans. Never log request parameters, retry keys, tokens or
credentials. Never upload a profile, store, protected journal or key material. Traces,
screenshots and video are off.

**Running a changed gate.** Select the branch as the workflow **definition** ref and give the
exact checkout SHA in the `ref` input. An old `main` definition with a newer checkout does not
run new steps. Check both the definition ref and the tested SHA; the native job prints both.
Release verification has the same rule.

### Native revision workflow acceptance

`pnpm run build && pnpm run app:revision-workflow` runs the built app against an authenticated
compiled CLI daemon on disposable data. It is its own project on the macOS and Windows jobs, with
its own results and artifact. Select the integration branch as definition and the exact SHA as
`ref`, as above.

Through real renderer controls and the production preload, it:

1. previews the workflow's destination, requests changes, refreshes and replaces a reviewed
   correction, resumes from the command palette, and answers a gate with a rationale;
2. checks one protected journal commit holds both the first correction and its gate decision;
3. quits the whole app and relaunches the same profile to recover pending protected text (no
   daemon restart);
4. holds the app's request at a test-only transport barrier while a second client wins a
   replacement CAS. The original request then gets a real `REVISION_STALE`, and the UI keeps the
   unsent draft;
5. holds a real protected read during refresh. The checking state disables replacement without
   losing the draft; releasing it shows the current correction and requires review again.

Neither barrier fakes errors, responses, identities, credentials, payloads or retry keys.

One compiled ScriptedAgent receives the attempt. It has no state file and no deliverables. There
is no demo seed, shared counter, external agent or model. The final prompt must contain the
final text once, the revision id and human provenance, and no superseded correction. Protected
history confirms that attempt once; the UI shows Delivered and blocks late replacement. A second
run sends a gate rationale and checks it stays in decision history but never reaches the agent
prompt or workflow values, and that the first run got no extra prompt.

Store inspection is read-only and runs after writes settle. Raw protected entries, prompt logs,
config and credentials stay in the fixture; only synthetic ids, digests, counts and booleans are
attached. Traces, screenshots and video are off. The same cleanup bounds and the same bans on
prompt approval, security changes and runner provisioning apply. Local checks cannot establish
this acceptance; the exact-head macOS and Windows steps must pass.

### Screenshot baselines

The two specs' screenshots mean opposite things:

| Spec | Screenshots are | Why |
| --- | --- | --- |
| `app-shell.spec.ts` | **Evidence, never fixtures.** Attached to the report, never committed or diffed. | OS chrome over live data would fail for reasons that are not bugs. |
| `type-proof.spec.ts` | **The fixture.** Per-platform baselines, diffed with `toHaveScreenshot()`. | `#type` is a fixed page; a pixel difference means something. The ticking `reconnecting` and `disconnected` rows are hidden before capture, not budgeted for. |

There are four baselines per platform: light and dark columns, bundled faces on and off. Each is
a screenshot of one theme column (a locator), not the page. They sit beside the spec:

```
packages/app/test/smoke/type-proof.spec.ts-snapshots/
  type-bundled-light-type-proof-linux.png
  type-bundled-light-type-proof-darwin.png
  type-bundled-light-type-proof-win32.png
  …
```

On Linux the two faces-off images use a separate control in
`packages/app/test/smoke/control-fonts/`, named `type-fallback-control-*.png`. Its pinned fonts
stop a sparse runner's OS fonts from defining the comparison. Real native fallback still shows
in attached screenshots and Chromium font reports, as evidence, not as a coverage pass. The
control is test-only and does not change the app's stacks. Its README has source hashes,
licences, coverage checks and rebuild steps. New control baselines need an exact-ref Tyler
capture, visual review and an explicit baseline commit.

**Creating baselines the first time.** Never on a developer machine: a baseline must come from
the machine it is compared on. On a platform with no baseline, Playwright writes the image and
fails the job.

1. Push the branch, then manually dispatch **App smoke** with `ref` set to its SHA. All three
   `type-proof` legs fail with "A snapshot doesn't exist". Opening a PR does not run them.
2. Download the three `type-proof-<os>` artifacts.
3. Unpack them into `packages/app/test/smoke/type-proof.spec.ts-snapshots/`. **Look at the
   images**: tofu, wrong weights and fallback faces are visible only to a person. Commit them
   with the reason in the message.
4. Push and dispatch App smoke again on the new SHA. The legs pass.

**Updating baselines.** The answer to a diff is never a larger `maxDiffPixelRatio`.
`playwright.config.ts` allows `0.002` for antialiasing only.

1. Open the HTML report from the `type-proof-<os>` artifact and look at expected, actual and
   diff.
2. Decide: **a bug** (lost codepoint, stack no longer reaching a family, a token changed a size)
   is fixed and the baseline stays. **An intended change** (new glyph, re-subset face, type-scale
   edit) is a baseline update.
3. Regenerate with a manual App smoke run, or locally for **this platform only** with
   `pnpm run app:type-proof:update` (`xvfb-run -a` on a headless box). It runs
   `--update-snapshots`, which rewrites only this platform's four files. Check a locally made
   Linux baseline against the runner's before trusting it.
4. **Put the reason in the commit message**: what changed and why the new picture is right.

A runner image change is the usual cause of an unexplained diff. The answer is still a
deliberate update with the reason written down, never a looser threshold.

**Where it runs.** `.github/workflows/app-smoke.yml`, not `ci.yml`. PRs do not start it.
Dispatch **App smoke** with a SHA in `ref` to run the smoke test and all three type-proof
platforms. `ci.yml` installs with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and fetches the binary only
for the upgrade launch check; the smoke workflow installs it. Playwright uses the workspace's
`electron`, so `playwright install` is never needed. Release publication runs the reusable
workflow on the exact merge commit, all three platforms included. A failed proof blocks tagging.

### Upgrade launch check

`pnpm run app:upgrade-launch` copies a store ORCA **0.6.0** wrote
(`packages/app/test/fixtures/store-v0.6.0`) into a temp workspace, serves it with this
checkout's daemon and opens the built app. It checks every old run is still served, the app
handshakes, and Runs and Plan render the old data.

- `ci.yml` runs it on PRs that touch what ships and always on `main`, fetching Electron for that
  step only.
- Release verification runs it in App smoke's `smoke` job, where it is required.
- A manual run on a ref from before the check existed reports "not applicable".
- **Never regenerate the fixture with current code.** Its README says how it was made and when
  to add a newer one beside it (#863).

### Native Linux acceptance

`pnpm run app:linux-native` drives the **installed** `.deb` (`/opt/ORCA/orca-desktop`) in a
throwaway desktop session the specs start: Xvfb, headless Weston, a session bus, a locked GNOME
keyring and the real gcr unlock prompt, answered with xdotool. It covers the window not
reappearing on Wayland (#858) and the keyring prompt (#857). It runs as the `linux-native` job
of App smoke on hosted `ubuntu-24.04`. See
[packages/app/test/native-linux/README.md](../packages/app/test/native-linux/README.md).

## Flaky tests are fixed, not waited out

A test that needs a sleep or a retry is wrong. A skip without an issue never gets turned back on.
`pnpm run lint` enforces three rules in test files (`orca/no-flaky-test-waits`, from T3 Code's
testing rules, #863):

1. **No `waitForTimeout`.** Wait for the condition: a locator assertion, `expect.poll`, an event
   or a `Deferred`. A sampling interval inside a bounded stability check is the one exception,
   with an `eslint-disable-next-line` giving the reason.
2. **No `retries` or `retry` above 0.** Playwright keeps `retries: 0`; Vitest has no `retry`.
3. **A skip names its issue.** `it.skip`, `test.skip`, `describe.skip` and `.fixme` need
   `// quarantine: #<issue> <why>` on the line above. `skipIf`/`runIf` for a platform and
   `it.todo` are not quarantines. `.only` is refused.

## Test memory

The self-hosted runners run about twenty test files at once, so one memory-hungry file is
multiplied. Twenty workers peak at about 7 GiB against a 12 GiB limit ([CI runners](ci-runners.md)).

- **A spy keeps every call.** `vi.spyOn` and `vi.fn` keep every call's arguments and results until
  restored or cleared. Spying on `fs.readSync` in a loop held up to 1.8 GiB per file. Use
  `interceptReadSync()` from `packages/cli/test/intercept-read-sync.ts`, which records nothing.
  If you need the spy, restore or clear it right after its assertions. `no-restricted-syntax`
  warns on `vi.spyOn(fs, "readSync")`.
- **`--logHeapUsage` does not show buffers.** Buffers live outside the JS heap. Read
  `process.memoryUsage().arrayBuffers` in the test, or the container's cgroup memory in CI.
- **Heap flags do not help.** `--max-old-space-size`, `--max-semi-space-size`,
  `MALLOC_ARENA_MAX` and turning coverage off changed nothing. Look for retained buffers before
  raising the limit or lowering workers.
- **A split file runs beside its parts.** Splitting moves memory into parallel processes. Check
  the peak after a split.

## Tests worth reading first

| Test | Shows |
| --- | --- |
| `packages/engine/test/sdlc.e2e.test.ts` | The Plan→Deploy loop with retries, review rounds, follow-ups and the auto gate. |
| `packages/engine/test/program.e2e.test.ts` | Decomposition, dependency-ordered dispatch, blocked items on failure. |
| `packages/engine/test/containers.test.ts` | Loop, parallel, subworkflow, resume and cancel with a plugin node. |
| `packages/engine/test/run-overrides.e2e.test.ts` | The selection record (#186), including replay after config changes. |
| `packages/engine/test/local-workspace-branch.test.ts` | The `local` provider checking out `orca/<slug>` (#139). |
| `packages/engine/test/model-selection.e2e.test.ts` | Model overrides, re-applying after drift, and an unknown model failing before the turn (#187). |
| `packages/engine/test/workflow-pinning.test.ts` | Resuming on a stored v1 when only v2 is on disk; version-not-found (#179). |
| `packages/integrations/test/acp-facade.test.ts` | ORCA driven as an ACP agent, with gates forwarded as permission requests. |
| `packages/core/test/plan.test.ts` | The pure planning layer: grammar, risk matrix, graph, decision matrix, scheduler, signals, Mermaid. |
| `packages/engine/test/plan.service.test.ts` | Cross-request registration, stage and decision dependencies, risk holds, `custom:plan-await`. |
| `packages/engine/test/plan-dispatch.test.ts` | `onWaiting: wait` with `waitTimeoutMs`, and `failFast`. |
| `packages/engine/test/plan.e2e.test.ts` | The shipped program: matrix decisions, stage pipelining, build-phase waits, `plan-resume`. |
| `packages/store/test/jsonl-log.test.ts` | On-disk sequencing, torn-tail recovery, stale lock holders. |
| `packages/store/test/lease-store.test.ts`, `packages/engine/test/run-lease.test.ts` | The run lease: one winner, heartbeat and lapse, `RUN_LEASED`, a broken holder stopping. |
| `packages/cli/test/commands.test.ts`, `plan.test.ts`, `bootstrap.test.ts` | The CLI as a user meets it, `--json` included. |
| `packages/cli/test/format.test.ts` | One assertion per event type. |
| `packages/integrations/test/acp-facade-prompts.test.ts` | The facade's prompt grammar (`/status`, `/run <id> k=v`). |
| `packages/integrations/test/t3code-session.test.ts` | The T3 Code adapter against a fake RPC. |
| `packages/app/test/appearance.test.ts` | The renderer under the real CSS: themes, density, reduced motion, `⌘⇧L` / `⌘⇧D`. |

## The scripted agent

`packages/testing` ships an ACP agent that reads each prompt's deliverables block and writes
files from a **playbook** (per artifact kind, in order). It makes the e2e tests and the demo
deterministic and LLM-free. Try it with
`pnpm exec tsx packages/testing/src/scripted-agent/main.ts --playbook pb.yaml`.

- **Config options.** The playbook's `configOptions` are advertised in `session/new`.
  `scriptedAgentSpec({ configOptions })` sets them through `ORCA_CONFIG_OPTIONS_JSON`. Each
  session has its own copy. `session/set_config_option` updates `currentValue`, returns the full
  list, and appends `{ sessionId, configId, value }` to the prompt log (#185).
- **Drift.** An entry with `setConfig: { configId, value }` makes the agent switch its own option
  and send `config_option_update` during that turn (#187).
- **Shared `--state`.** Each prompt with deliverables holds the `@orca/store` cross-process
  mutex at `<state-file>.lock` from reading state, through entry selection and the turn's
  notifications, permission requests and writes, to the final counter save. The parent
  directory is created first; a missing state file is created under the lock. A prompt without
  deliverables creates no state. Without `--state`, counters reset each prompt.
- **Commit boundary.** An exception before the final save commits none of that prompt's
  increments, even if files were written. Cancellation at the pre-write checkpoint leaves that
  entry unconsumed and commits earlier entries. Skipped and permission-denied entries consume
  counters. This serializes counters; it is not a crash-atomic file and counter commit.
- **Lock behaviour.** The mutex releases on return or throw. A cancelled waiting turn keeps its
  flag until it reaches the cancellation check. Acquisition has the store's 60-second bound. A
  hung playbook can block other state users until termination or timeout. Dead same-host owners
  are recovered by owner token and PID; live, unknown, malformed or empty owners are never
  removed for age. There is no cross-host or PID-namespace recovery. Tests:
  `packages/testing/test/scripted-agent-state.test.ts`.
