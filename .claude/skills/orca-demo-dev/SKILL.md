---
name: orca-demo-dev
description: Start the ORCA demo daemon and the desktop app in dev mode (Vite + Electron) against a demo workspace with history, a plan and editable workflows. Use when asked to run, start, launch or restart the app or the demo daemon, to look at a UI change in the real app, or to get a populated workspace to click through.
---

# Run the demo daemon and the app in dev mode

One script does the whole setup:

```bash
node .claude/skills/orca-demo-dev/scripts/start.mjs
```

Run it from the repository root (or the worktree root). It stays in the foreground until the
app window closes or it is interrupted, and stopping it stops both processes.

**From Claude Code, run it in the background** (Bash with `run_in_background: true`) and read
its output file. It is ready once the log shows `[orca-demo] daemon listening on …` and then
`[app] [orca] renderer dev server on http://localhost:5273/`; the Electron window opens a few
seconds after that. To stop it, stop that background task, which ends the daemon and Electron
with it.

## What it does

1. **Workspace.** It runs `pnpm run demo --dir <workspace> --quiet` once. That executes the
   `program` workflow end to end with scripted agents (no LLM), which leaves finished runs, a
   work-item breakdown, a plan with dependencies, risks and a decision, and a working
   `orca.config.yaml`. Later starts reuse the workspace. That history is generated once and
   does not grow by itself. To get more, start runs from the app's palette or with
   `pnpm run orca --config <workspace>/orca.config.yaml run ai-sdlc --var 'workItem={"slug":"x","title":"X"}'`.
2. **Editable workflows.** The demo config points at the repo's `workflows/*.yaml`. The
   workflow editor only edits files inside the configuration directory, so the script copies
   the workflows into `<workspace>/workflows/` and changes the config to
   `workflows: [workflows/*.yaml]`. Edits and publishes made in the app change those copies,
   never the repo's files.
3. **`@orca/design` dist.** `pnpm exec tsc --build packages/design`. The renderer and its
   tests import the package through `dist/`. A stale dist shows a sidebar missing surfaces
   that `semantics.json` declares.
4. **Daemon.** `pnpm run orca --config <workspace>/orca.config.yaml serve` on
   `http://127.0.0.1:6722`, with token auth. The token is at `<workspace>/auth/local-client.token`.
5. **App.** `pnpm --filter @orca/app dev` with `ORCA_WORKSPACE` and `ORCA_DAEMON_TOKEN_FILE`
   set to the workspace. Renderer changes hot-reload through Vite. Main-process and preload
   changes need a restart.

## Options

| Option | Effect |
| --- | --- |
| `--dir <path>` | Use this workspace instead of the default `<os tmp>/orca-dev-demo-<hash of the checkout>`. Each worktree gets its own default. |
| `--seed` | Populate every surface (below). Seeds a workspace once; `--fresh --seed` gives a new seeded one. |
| `--fresh` | Delete the workspace and build a new one. It refuses a non-empty directory that has no `demo-playbook.yaml`, so it never deletes something it did not make. |
| `--daemon-only` | Start only the daemon. It prints the two environment variables the app needs. |

## Populated screens (`--seed`)

The demo alone leaves only finished runs. `--seed` (`scripts/seed.mjs`) submits more work
through the daemon's own `requests.submit` and `runs.cancel`, so the store holds real runs and
events, not hand-made files. Before the daemon starts it changes the config in two ways:

- It adds four scripted agents, each with its own playbook: `scripted-slow`, `scripted-flaky`,
  `scripted-risky` and `scripted-planner`. They have no roles, so a request only gets one
  through its role overrides.
- It sets `humanInput: { mode: pause }`, so gates wait for an answer instead of approving
  themselves.

| Request | Agent override | What it shows |
| --- | --- | --- |
| Export invoices as CSV | none | A succeeded run |
| Rate-limit the login endpoint | builder → slow | A run still **running**. Its build step takes 25 minutes. |
| Rotate the API signing keys | designer → risky | A run **waiting** at the spec gate. It's on Attention. |
| Fix the flaky checkout test | tester → flaky | A run **failed** after three build attempts |
| Move sessions to Redis | builder → slow | A run **cancelled** mid-build, with a reason |
| Billing export (program) | decomposer, planner → planner | **Waiting** at the plan gate. It adds 5 work items, 3 risks and a decision to the plan. |

The Agents surface lists five agents. Answering the two gates in the app moves the runs on:
approving the plan dispatches the Billing items. `node scripts/seed.mjs` seeds a daemon that is
already running on a prepared workspace. If the workspace isn't prepared, it prepares it and
says to restart with `--seed`, because a running daemon doesn't load new agents.

## When it fails

- **`the daemon exited … before it was listening`**: something else holds port 6722. That's
  usually a daemon left over from an earlier session. Find it with
  `Get-NetTCPConnection -LocalPort 6722` (PowerShell) or `lsof -i :6722`, and stop it.
- **Vite says port 5273 is in use**: an earlier dev app is still running. Stop it first.
- **A screen looks wrong only in the app, not in tests**: the renderer hot-reloads, but
  `packages/app/src/main` and the preload are compiled once at start. Restart the script.
- **The workspace is in a strange state** (a half-published draft, a run you don't want):
  start again with `--fresh`.

Claude cannot see the Electron window without computer-use access to it. To check a UI change
visually, ask the person for a screenshot or for that access.
