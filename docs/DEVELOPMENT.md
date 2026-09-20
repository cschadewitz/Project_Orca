# Development

```bash
mise install                 # Node 24 + pnpm 12 (any Node >= 22 works)
pnpm install
pnpm run typecheck           # tsc --noEmit over every package + tests, then again over the
                              # renderer (packages/app/renderer/tsconfig.json) with JSX/DOM lib
                              # a plain Node package never needs
pnpm run lint                # eslint (type-aware) over the same set, then the CSS token
                              # check; --fix as `pnpm run lint:fix` (eslint only)
pnpm run format              # prettier --write . (`format:check` to only report)
pnpm test                    # vitest: unit tests + e2e against a real ACP subprocess
pnpm run test:coverage       # the same run, with coverage and its thresholds
pnpm run build               # tsc -b project references -> packages/*/dist
pnpm run demo                # program run with scripted agents (from sources via tsx)
node packages/cli/dist/main.js demo   # same, from the compiled build
pnpm run orca serve          # the daemon, on 127.0.0.1:6722 until Ctrl-C
pnpm --filter @orca/app dev  # the app against that daemon, renderer hot-reloading
pnpm run build && pnpm --filter @orca/app start   # the same app from the built output
pnpm run app:smoke           # Playwright drives the built app against a demo daemon
                              # (needs the Electron binary; xvfb-run it on a headless box)
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
| `preload`  | Node     | `tsc -b`, its own project    | `dist/preload/index.cjs` |
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

**The preload is CommonJS, and that is not a style choice.** `packages/app` is
`"type": "module"` and main is emitted as ESM, but `createWindow()` sets `sandbox: true`,
and Electron evaluates a sandboxed preload as a plain script. An ESM preload is refused
outright — `"Unable to load preload script"`, `"Cannot use import statement outside a
module"` — and Electron reports that to the *renderer's* console rather than failing the
launch, so the only symptom is `window.orca === undefined` and every screen landing on a
renderer with no bridge. The sandbox is worth more than the module format, so the format
gives way (#198).

The mechanics, in case you move the file:

- The source is `src/preload/index.cts`, not `.ts`. TypeScript has no compiler option for
  an output extension, so the input extension is the only thing that yields `.cjs`; under
  `module: NodeNext` a `.cts` is emitted as CommonJS automatically.
- `packages/app/tsconfig.preload.json` is its own composite project, because the package's
  `include` is `src/**/*.ts` and does not match `.cts`. It is listed in
  `tsconfig.build.json`, and the root `tsconfig.json` names the `.cts` explicitly so
  `pnpm run typecheck` and ESLint's type-aware rules both still see it.
- **Keep the preload's imports to `electron` plus type-only imports.** Nothing in it needs
  Node, so only the single `import electron = require("electron")` is aware of the format.
  That `require` form is what repo-wide `verbatimModuleSyntax` demands of a file emitting
  CommonJS; it carries a documented `eslint-disable`.

To check the bridge by hand on a headless box: `orca demo --dir <dir> --keep`, then
`orca --config <dir>/orca.config.yaml serve`, then launch the built app under `xvfb-run`
and confirm the status bar reads `connected`. `ELECTRON_RUN_AS_NODE` must not be set, and
`xvfb-run` swallows Electron's own flags unless they sit behind `/bin/sh -c`.

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
tests live beside it in `packages/app/renderer/test/**/*.test.{ts,tsx}` rather than in
`packages/app/test` for the same reason — they compile against that project, not the root
one — and `vitest.config.ts` includes both globs. `renderer/test/harness.tsx` assembles
what `main.tsx` installs above React (keyboard map, layer stack, palette sources,
appearance) so a test can mount the chrome the way the app does.

`demo --dir <path>` (or `demo --keep`, which keeps the temp workspace instead of
removing it afterwards) leaves a complete setup behind — `orca.config.yaml` wired to
the scripted agent plus its `demo-playbook.yaml` — so `orca --config <path>/orca.config.yaml
run <workflow>` exercises any workflow without an LLM. Edit the playbook to change what
the agent delivers per artifact kind.

## The primitive preview, and the type proof

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

`#type` is the second dev-only route, and it answers what the font build cannot (#194).
`tools/font-build/build-fonts.js` proves every declared file contains every codepoint
claimed for it; only a renderer can show that the glyphs look right *next to the words*, at
chip scale, in both themes. `#type` shows every type style in `tokens.json` with real sample
text, the eight statuses as chips and as bare glyphs, the connection states, two ids per row
in `mono-id` so the tracking can be read, and a block of `mono-log` output with the
box-drawing rules the stream uses.

Its point is the **"bundled faces on/off" toggle**, which swaps the declared stacks for the
same stacks minus every bundled family. The failure it catches is silent: a glyph that falls
through to the OS still renders, just in a different typeface, and nobody notices in a
screenshot taken on the machine that happens to have the font. With the faces off, U+23F8
(`held`) renders as tofu on Linux. **The rule for reading it: anything that does not change
when you flip the toggle was never coming from a bundled face.**

Cross-platform is no longer done by eye: `packages/app/test/smoke/type-proof.spec.ts`
photographs this page on Linux, macOS and Windows and diffs committed baselines (#213). See
"Screenshot baselines" under [Testing the app](#testing-the-app) for how those are made and
the one honest way to update them.

Both routes are dev-only in the strong sense: `routes.tsx` reaches them through a dynamic
`import()` inside an `import.meta.env.DEV` branch, which Vite folds to `false` in a build,
so neither the pages nor their CSS are emitted. Keep it that way if you add to them.

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

**Rule 1 of `docs/design/RULES.md` — no literal colours, sizes, radii, durations or
z-values in component code — is enforced by `pnpm run lint`** (#153), in two halves:

| | What runs it | What it covers |
| --- | --- | --- |
| Stylesheets | `pnpm run lint:css`, chained from `lint` | every `.css` under `packages/app/renderer`, and `components.css` for colours and stacking order |
| TSX | the `orca/design-tokens-only` ESLint rule | inline `style={{ … }}` objects under `packages/app` |

The CSS side rejects hex colours, the colour functions, CSS colour names, `px`/`rem`/`ms`/`s`
quantities and a `z-index` that is not a `var(--z-*)`. It allows `0`, percentages and the
relative units (`fr`, `em`, `ch`, `vh`, `vw`, `deg`) — those describe a ratio to something
already chosen rather than making a new decision — and it does not scan comments, quoted
strings, `url()` or at-rule preludes, so `@media (max-width: 900px)` is fine while a literal
inside that block is not. The TSX side rejects a colour notation or a `px`/`rem`/`ms` string
in an inline style, and a non-zero bare number for `width`, `height` or any `padding*`, since
React renders those as pixels. A string-valued `style` prop is the design system's own
(`<Text style="caption">`) and is left alone.

It is a hand-written scanner in `tools/eslint-config/css-tokens.js` rather than stylelint:
the rule is one sentence, and stylelint can only express it as a regex per property — a
check that silently stops covering new code the moment someone uses a property nobody
listed. The fixtures are in `packages/design/test/token-lint.test.ts`, so `pnpm test`
catches a regression too.

**The escape hatch is to add the token**, and it is almost always the right fix: put the
value in `packages/design/tokens.json` with a `usage` note, run `pnpm run design:build`,
and reference it as `var(--your-token)` or `v('your-token')`. Both lint messages say so, so
the fix is in the failure. For a value no token could sensibly name, an
`/* orca-allow-literal: why */` comment suppresses the line it is on and the next; reaching
for it twice for the same kind of value means a missing token, not a missing exemption.

`packages/design/css/components.css` is checked in full, the same as anything under
`packages/app/renderer`. It used to be checked for colours and stacking order only, because it
carried ~190 literal type sizes and box heights; #211 removed them. No rule there writes a type
size any more — an element takes an `.orca-text-*` class, and each rule carries a
`/* type: <style> */` note naming the class it expects.

**Nothing remains: the count is 0.** #211 left 38 of those notes, #240 took five, and #244
took the last 32 (`grep -c orca-allow-literal components.css` returns 1, and that one is the
paragraph at the top of the file explaining the rule). They were never 32 numbers. They were
five families `tokens.json` did not have — `bar-*` for a band of chrome, `badge-*` for a mark
that carries a word, `mark-*` for decorative geometry, `col-*` for a fixed track sized to what
it holds, and the spacing half rungs `space-1-5` and `space-2-5` — plus `control-xs` and
`control-sm-5` extending the control scale, four boxes that simply needed naming, and two
values that turned out to be arithmetic written out as a number.

The rule that produced that work is unchanged and is the reason to keep counting: **reaching
for one of those literals a ninth time is the signal to add the family, not another note.** At
zero, a new note is a stronger claim than it used to be — not "no token names this yet" but "no
token could sensibly name this" — so it argues for itself in its own text, with a reason rather
than an issue number, and a reviewer is entitled to ask for the token instead.

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

The renderer joined the report in #154. `renderer/src/main.tsx` and `renderer/src/preview/**`
stay out: the entry point only runs in a real Electron window — the smoke test is what
exercises it — and the preview routes are galleries a person looks at. `packages/app/renderer/src`
and `packages/app/src` also carry their own glob thresholds. A glob threshold is an
*additional* check on a subset, not a partition: the files it matches are still counted in
the whole-report numbers as well.

CI measures coverage on one Node version (24), writes the per-package table into the
job summary, and uploads `coverage/` as an artifact — including when the thresholds
fail, which is when the numbers are worth reading.

CI skips the whole typecheck/lint/test/build matrix when a push or PR changes only
documentation: `docs/**` and any Markdown outside `templates/` (the prompt templates are
Markdown but the engine loads them, so they count as code). A small `changes` job diffs
against the merge base and gates the matrix with a job-level `if`, so a docs-only PR still
shows a green check rather than none — see the comments in `.github/workflows/ci.yml`.

A second, much cheaper workflow — `.github/workflows/changelog.yml` — fails a pull request
that changes anything under `packages/` and adds no fragment under `changelog.d/`. The
opt-out is the `no-changelog` label, which is why the check is its own workflow: it runs on
`labeled` and `unlabeled` too, and re-running one `git diff` on a label change is cheap
where re-running the whole matrix would not be.

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
- The window chrome is `packages/app/renderer/src/App.tsx` plus `renderer/src/chrome`: title
  bar, sidebar, primary pane, docked panel, status bar. A screen is the child of
  `PrimaryPane`, which is the surface root (`data-surface`) that density is remembered by;
  the two layout thresholds come from the design system's `BREAKPOINTS` through
  `use-breakpoints.ts`, because a CSS media query cannot read a custom property. Shortcuts
  register in the `KeyboardMap` (`useKeyboard`), never on `window` directly, so the palette
  (#149) can list every one of them.
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
- Release notes are a file, not a list to edit: a pull request adds `changelog.d/<issue>-<slug>.<section>.md`
  rather than touching `CHANGELOG.md`, which is rendered at release time. CI enforces it for
  any change under `packages/`, with `no-changelog` as the opt-out label. `changelog.d/README.md`
  has the naming and `docs/RELEASING.md` the rest.
- `tools/` is plain JavaScript run straight by node — no build, outside the workspace's
  `tsconfig.json` — so the tests that cover it are JavaScript too, in `tools/test/`, and
  `vitest.config.ts` includes that glob alongside the packages'.

## Testing the app

The renderer's test kit is three modules in `packages/app/renderer/test/`, and a screen
test uses all three.

- **`harness.tsx`** assembles what `main.tsx` installs above React — the keyboard map, the
  layer stack, the palette source registry, appearance and the notification stream — so a
  component can be mounted the way the app mounts it. `installBridge()` is the short way to
  a fake daemon.
- **`themes.tsx`** mounts a component once per theme with the real `tokens.css` and
  `components.css` in the document, and asserts on the colour the design system actually
  resolves: `inBothThemes(ui, ({ theme, container }) => …)`, then `resolved(el, "color")`
  against `expectedToken(theme, "status-failed")`. **Name the token, never paste the hex** —
  naming it is what makes the assertion mean "this element is bound to this token", and a
  pasted value proves nothing and survives the token changing. happy-dom resolves `var()`
  against a stylesheet selected by `[data-theme]`, which is all this needs, so jsdom was not
  added; two of its quirks are worked around inside `themes.tsx`.
- **`fake-bridge.ts`** is a `window.orca` answering `hello`, the five read methods and
  notifications from `fixtures.ts` — the whole of "the daemon" as far as a test is
  concerned, since the renderer can reach exactly one thing outside itself. Its defaults
  genuinely page, filter and count the way the daemon's `ReadModel` does, so a screen that
  ignores `limit` cannot pass its test and then page wrongly against a real daemon.
  `fake.fail(...)`, `fake.hold(...)` (assert a loading state), `fake.notify(...)` and
  `fake.calls` cover the rest. The fixtures were dumped from a real `ReadModel` run over
  `packages/daemon/test/fixture.ts` and are parsed through their protocol schemas, so a
  protocol change breaks that file rather than a screen test much later.

**The Electron smoke test** (`packages/app/test/smoke/app-shell.spec.ts`) is the one test
that launches the real thing: Playwright's Electron driver against the *built* app and a
daemon on an `orca demo` store. It asserts the window comes up with a bridge in it — which
is exactly what an ESM preload broke (#198) — that `hello` reached the daemon, that both
themes render and resolve different tokens, that axe finds no violations on **Attention,
Runs or Agents** in either theme, and that every status on the attention list, the run tree
and the status bar still carries its glyph and its word with the colour taken away (#167).
Plan and Config are asserted to be the unbuilt `StateView`s they are in v0.4.0, rather than
audited — a screen that says "not built yet" passes an axe run and means nothing by it, so
the day one of them grows content that assertion fails and says which.

Run it with `pnpm run build && pnpm run app:smoke`; on a headless box,
`xvfb-run -a pnpm run app:smoke`, and in a container without unprivileged user namespaces
also set `ORCA_SMOKE_NO_SANDBOX=1`. That is the *OS* sandbox and is unrelated to
`webPreferences.sandbox: true`, which stays on everywhere and is one of the things the test
checks.

The audit needs a workspace `orca demo` does not leave behind — it runs the program to
completion, so there is no gate waiting, no failed run and one host, and three of the
surfaces render empty states. `test/smoke/daemon.ts` adds a second host, a failed run and a
parked gate on top of the demo store, through the daemon's own RPC and its own config file,
and **not by changing `orca demo`**, which is somebody's first look at ORCA and has its own
users.

**The type proof** (`packages/app/test/smoke/type-proof.spec.ts`, `pnpm run app:type-proof`)
is the second spec and answers the half of #213 that no single machine can: whether the
bundled faces render the same on Linux, macOS and Windows. Because `#type` is dev-only by
design — `routes.tsx` gates it behind `import.meta.env.DEV` so it never reaches a shipped
bundle — this spec does not use the built renderer. It compiles main and preload with
`tsc -b packages/app/tsconfig.preload.json`, starts a Vite dev server, and launches Electron
with `ORCA_RENDERER_URL` pointed at it plus `#type`, which is exactly what
`packages/app/scripts/dev.js` does. **The production bundle is unchanged and must stay that
way.** Alongside the pictures it makes two assertions that need no baseline at all: that no
bundled `@font-face` ended at `error`, and that flipping the bundled-faces toggle changes
the measured width of the declared glyphs — if it does not, the faces were never on.

### Screenshot baselines

Two specs take screenshots and they mean opposite things, which is worth being explicit
about because the obvious reaction to either is to make it behave like the other.

- `app-shell.spec.ts` screenshots are **evidence, never fixtures**. They are attached to the
  Playwright report so that a failed assertion comes with a picture of the window, and none
  of them is committed or diffed. The app draws OS-rendered chrome over live data; a pixel
  baseline of it would go red for reasons that are not bugs.
- `type-proof.spec.ts` screenshots **are the fixture**. `#type` is a fixed page whose whole
  purpose is that a pixel difference means something, so it commits per-platform baselines
  and diffs against them with `toHaveScreenshot()`. The page's one moving part — the
  `reconnecting` and `disconnected` rows, which carry a ticking duration — is hidden by the
  spec before the shutter opens rather than budgeted for in the threshold.

Four baselines per platform: the light column and the dark column, with the bundled faces on
and off. They are committed beside the spec, in Playwright's own layout:

```
packages/app/test/smoke/type-proof.spec.ts-snapshots/
  type-bundled-light-type-proof-linux.png
  type-bundled-light-type-proof-darwin.png
  type-bundled-light-type-proof-win32.png
  …
```

Each is a screenshot of a **locator** — one theme column — and not of the page, which keeps
a committed PNG to the thing under test rather than to a window's worth of chrome.

**Creating them the first time.** They are not generated on a developer's machine, because a
baseline is only useful if it was taken on the machine that will be compared against it: a
Linux baseline shot on a laptop and a Linux baseline shot on `ubuntu-latest` are different
pictures of the same page. So **CI produces the first set**. On a platform with no baseline,
Playwright writes the image it just took to the baseline path and fails the job — which is
the behaviour to want, since a run that silently accepted whatever it saw would be recording
a bug as the truth. The `type-proof` job uploads
`packages/app/test/smoke/type-proof.spec.ts-snapshots/` as an artifact named
`type-proof-<os>`, so the procedure is:

1. Open the pull request. All three `type-proof` legs go red with "A snapshot doesn't exist".
2. Download the three `type-proof-<os>` artifacts from the run.
3. Unpack all three into `packages/app/test/smoke/type-proof.spec.ts-snapshots/`, **look at
   the images** — tofu, wrong weights and fallback faces are visible to a person and to
   nothing else — and commit them with the reason in the message.
4. Push. The legs are now green, and stay green until a glyph changes.

**Updating them deliberately.** A diff is a question, not a chore, and the answer is never a
larger `maxDiffPixelRatio`. `playwright.config.ts` budgets `0.002` for antialiasing moving
under a runner image and nothing else; a face falling through to the OS changes whole words
and is orders of magnitude above it. When a leg goes red:

1. Open the HTML report from the `type-proof-<os>` artifact and look at the three-up
   expected / actual / diff. **That is the deliverable** — the numbers only say how much
   moved, and the picture says what.
2. Decide which it is. *A bug* — a subset lost a codepoint, a stack stopped reaching a
   family, a token changed a size — is fixed, and the baseline stays as the thing that
   caught it. *An intended change* — a new glyph, a re-subset face, a deliberate type-scale
   edit — is a baseline update.
3. For an intended change, regenerate from CI the same way the first set was made, or
   locally for **this platform only** with `pnpm run app:type-proof:update` (`xvfb-run -a`
   on a headless box). That script exists so the update has a name: it is
   `--update-snapshots`, which rewrites the current platform's four files and leaves the
   other two platforms' alone, so a local run can never silently bless a picture it did not
   take. A locally regenerated Linux baseline should still be checked against the runner's
   before it is trusted.
4. **Put the reason in the commit message**, naming what changed and why the new picture is
   right. A baseline update with no reason in it is indistinguishable from a regression
   being blessed, which is the one failure mode this check cannot survive.

A runner image moving under us is the expected cause of an unexplained diff, and the answer
is still a deliberate update with that written down — never a loosened threshold.

It runs from `.github/workflows/app-smoke.yml`, not `ci.yml`, on pull requests touching
`packages/app`, `packages/design`, `packages/daemon` or `packages/protocol`. `ci.yml` keeps
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` and so has no Electron to launch; the smoke workflow
installs without it. No browser binaries are involved — the driver uses the workspace's own
`electron`, so `playwright install` is never needed. The workflow has no `push` trigger and
no `workflow_call`, so the faces are not re-checked at release time; that is **#254**, filed
and deliberately deferred rather than overlooked.

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
