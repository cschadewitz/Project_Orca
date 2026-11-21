# A store written by ORCA 0.6.0

`store/` is the `.orca` directory `orca demo` leaves behind when it is run by the **v0.6.0**
CLI (store epoch `ownership-fences-v1`). The upgrade launch check
(`packages/app/test/smoke/upgrade-launch.spec.ts`, `pnpm run app:upgrade-launch`) copies it
into a fresh workspace, serves it with the CLI built from the commit under test, and opens
the built app on it. So every run proves that today's daemon and app still read what a
person upgrading from 0.6.0 has on disk (#863).

It is old **on purpose**. Do not regenerate it with the current CLI, and do not edit it by
hand: a fixture that the current code wrote, or that someone patched to pass, proves
nothing about upgrades. When a newer release becomes the oldest one we support upgrading
from, add a second directory beside this one rather than replacing it.

## What is in it

Five runs (`program`, `program::decide` and three `ai-sdlc` items), the demo plan with
three finished work items, their decisions, risks, claims and artifacts. No secrets: the
demo uses scripted agents, and 0.6.0 wrote no `private-execution` key for it.

Every absolute path the demo recorded is the placeholder `/tmp/ORCA_FIXTURE_ROOT`.
`startStoreFixtureDaemon` in `packages/app/test/smoke/daemon.ts` replaces it with the
temporary workspace when it copies the store (JSON-escaped inside `.json` and `.jsonl`).
The placeholder is why the fixture was generated in that exact directory.

## How it was made

```sh
git worktree add /tmp/orca060 v0.6.0
cd /tmp/orca060 && pnpm install --frozen-lockfile && pnpm exec tsc -b tsconfig.build.json
mkdir /tmp/ORCA_FIXTURE_ROOT && cd /tmp/ORCA_FIXTURE_ROOT
node /tmp/orca060/packages/cli/dist/main.js demo --dir /tmp/ORCA_FIXTURE_ROOT --keep --quiet
cp -a /tmp/ORCA_FIXTURE_ROOT/.orca <repo>/packages/app/test/fixtures/store-v0.6.0/store
```

Only `.orca` is kept. The demo's `orca.config.yaml` named the v0.6.0 checkout's scripted
agent and workflows, so the check writes its own config against the current checkout.
