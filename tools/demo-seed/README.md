# Demo seed

Fills an ORCA workspace with a lot of realistic demo data, through its running daemon, so every
surface of the app has something on it. It is made for a **fresh install** that is about to be
checked by eye: after the first-run setup, run it once and the app shows dozens of runs in every
state, four plans, gates and permission prompts waiting on Attention, sixteen agents and a dozen
workflows and templates.

It needs no model and no network. The agents are ORCA's scripted ACP agent
(`packages/testing/src/scripted-agent`), bundled into one file, each with its own playbook.

## Build and copy

```sh
node tools/demo-seed/build.mjs          # -> tools/demo-seed/dist/orca-demo-seed/
```

The folder is self-contained: `seed.mjs`, its data, `scripted-agent.mjs`, and the repo's
`workflows/` and `templates/` under `assets/`. Copy it to the machine that runs ORCA. It needs
Node 22 or later there, or the installed ORCA's own binary (`--agent-node`, below).

## Run

On the machine running the daemon, after the app's first-run setup has created the workspace:

```sh
node orca-demo-seed/seed.mjs --workspace <app workspace folder>
```

1. **Prepare.** It writes `<workspace>/demo-seed/` (the agent bundle, playbooks, workflows,
   templates and skills) and adds the agents, workflow and template globs, a capability catalog
   (three MCP servers and two skills, none enabled), two secret references (env names, no
   values), the planning defaults and `humanInput: pause` to `orca.config.yaml` with
   `config.set` and `config.apply`. New agents need a daemon restart, so it stops and says so
   (exit code 2).
2. **Restart the daemon**: quit and reopen ORCA (or restart `orca serve`).

   **With the desktop app's bundled daemon**, a config written from outside the app is not
   bound for reopening, and the reopened app refuses to start its daemon. So for the app,
   prepare with `--config-out <file>`: the seed writes its files and the finished config to
   `<file>`, and changes nothing through the daemon. Then, in the app: Config > **Raw**, paste
   the file, **Validate and review**, **Save reviewed changes**, **Apply saved
   configuration**, and quit and reopen ORCA. Saving binds the config for reopening (since
   0.8.0-rc.3). Only on builds before that (0.8.0-rc.2 and older, #1192), also bind before
   quitting: Config > Form > **Review saved configuration for reopening** > **Bind reviewed
   saved configuration**. `packages/app/test/native-linux/visual-sweep.spec.ts` does exactly
   this; `SWEEP_LEGACY_BIND=1` adds the extra bind for those older builds.
3. **Populate.** Run it again with `--phase populate`. It submits the work, then spends up to
   2½ minutes answering the gates it should answer, cancelling the run it should cancel,
   deciding a plan decision and moving risks, and prints what the store holds.

| Option | Default | What it does |
| --- | --- | --- |
| `--workspace <dir>` | required | The app workspace (the folder with `orca.config.yaml`). Its `auth/local-client.token` is the daemon token. Before either phase changes anything, the seed checks that the daemon's own config path (`config.get`) is this workspace's `orca.config.yaml`, and refuses otherwise. |
| `--url <url>` | found from `/proc` on Linux | The daemon, `http://127.0.0.1:<port>`. Found automatically only when exactly one daemon running as you names this workspace's config on its command line and holds a loopback listener on its own `--port`; the URL keeps that listener's address (`127.0.0.1` or `[::1]`), so the token goes to that socket and no other. Anything less certain (two such daemons, no `--port`) is refused: pass the URL. Only a loopback address is accepted, and redirects are refused, so the token stays on this machine. `ORCA_DAEMON_URL` works too. |
| `--token-file <file>` | `<workspace>/auth/local-client.token` | |
| `--phase prepare\|populate\|all` | `all` | `all` prepares, and populates only if no restart is needed. |
| `--scale <n>` | `1` | Submit the work items and workflow runs `n` times. |
| `--agent-node <path>` | this Node | What runs the agents. The installed ORCA binary works (`/opt/ORCA/orca-desktop`); the seed then sets `ELECTRON_RUN_AS_NODE=1` for the agents. |
| `--config-out <file>` | off | Prepare only: write the seeded config to `<file>` instead of saving it through the daemon, for pasting into the desktop app's Config > Raw (above). The file is the **whole** workspace config, including anything already in it that you might not share, so it is created new and private (mode 600); an existing file or link at the path is refused. Keep it out of anything you share, such as sweep screenshots, and delete it after pasting. |
| `--settle <seconds>` | `150` | How long populate keeps answering and deciding. |
| `--force` | off | Populate again on a seeded workspace (`demo-seed/seeded.json` marks one). |

## What it makes

**Runs** (scale 1: about 50, more as programs dispatch). Each of the 24 `ai-sdlc` work items has
one behaviour, through a role override onto a scripted agent:

| Behaviour | Agent | On screen |
| --- | --- | --- |
| succeeds | the role's default | Succeeded |
| running | slow builder | Running for 45 minutes |
| waits at the gate / approved / rejected | cautious designer (high-risk spec) | Waiting on Attention; or answered by the seed |
| waits for permission | builder that asks first (a write outside the workspace) | A permission prompt on Attention |
| fails tests / missing deliverable / reviewer refuses | flaky tester / forgetful builder / refusing reviewer | Failed, three different ways |
| review loop | picky reviewer | Changes requested, then approved |
| stuck | stuck builder | A turn that never ends |
| cancelled | slow builder, cancelled after 8 s | Cancelled, with a reason |

Titles include a very long one, an unbroken one, an accented one and a Japanese one, on purpose.

**Workflows**: copies of `ai-sdlc`, `program` and `plan-resume`, a strict-review copy of
`ai-sdlc`, and six of its own, each a different shape on the canvas: a twelve-step line
(`release-train`), parallel branches (`parallel-audit`), a chain of three gates
(`approval-chain`), a nested workflow (`nested-release`), a ten-lane fan (`wide-graph`) and one
with very long id, name and version. Each gets runs.

**Programs**: four requests through `program`, each with its own planner agent and its own new
plan (`billing-<stamp>`, `search-<stamp>`, `mobile-<stamp>`, `platform-<stamp>`, with one
stamp per invocation): work items with dependencies, risks and decisions.
Billing's plan is approved, so its items run; its decision is decided and a risk moved to
mitigating. The others wait at the plan gate, with risks accepted and realized.

**Agents**: six role agents (one advertises a model list), the behaviour agents above, one
planner per program, one with a very long name, and one whose command does not exist.

**Templates**: the repo's prompt templates plus eight under `demo/`, one long enough to scroll.

## Things to know

- Runs execute in the workspace's project folder, as real runs do: the scripted agents write
  their artifacts under `<project>/.orca/work/` and `<project>/.orca/demo/`. Use a throwaway
  project.
- The store grows by about 5,000 files at scale 1 under the file store. The desktop app checks
  at most 8,192 files under `.orca` and `auth` when it reopens a workspace, so a large `--scale`
  can make the app refuse the workspace.
- The seed never adds work to a plan that already exists: each program names a plan key with
  this invocation's stamp, and it skips a program whose key is somehow taken. Plan decisions
  and risk updates only go to plans this invocation made: new since it started, and fed only by
  its own program request.
- Populate is once per workspace (`demo-seed/seeded.json`). The work-item slugs inside the
  programs are fixed, so prefer a fresh workspace to `--force`.
