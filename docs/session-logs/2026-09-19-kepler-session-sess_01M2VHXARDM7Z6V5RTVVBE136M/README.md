# Kepler session `sess_01M2VHXARDM7Z6V5RTVVBE136M` — 2026-09-19

The first Kepler-driven ORCA run that reached the end (issue #98, step 5). `sess_…136M` is the
ORCA facade session Kepler opened over ACP (`orca acp`, config `orca.kepler.config.yaml`, store
`/srv/dev/orca-live/.orca-kepler`). One prompt was typed into it:

> create a new file that contains a poem. And save it to the test repo you are in.

The facade turned that into request `req_01M2VHYT2ZB4FX089QWYKHXMSW` (`source.kind:
acp-session`) and started the program workflow. Both runs it produced are here, unchanged:

| File | Run | Workflow | Span | Result |
| --- | --- | --- | --- | --- |
| `run_01M2VHYT32PB17R5X5CT6ZZEPA.jsonl` | program run for the request | `program@2` | 00:44:44 – 00:54:37 UTC | completed / success |
| `run_01M2VJ3XKDV6KV9HCRP099JR3S.jsonl` | child dispatched for work item `add-poem-file` | `ai-sdlc@1` | 00:47:31 – 00:54:01 UTC | completed / success, "Work item delivered." |

Agent on every node: `claude` (`@zed-industries/claude-code-acp` 0.16.2 with native Claude Code
2.1.276 via `CLAUDE_CODE_EXECUTABLE`), host `local`, workspace `/srv/dev/repos/orca-sandbox`.

## What happened

Program run: `decompose` wrote one work item (`add-poem-file`) with two risks and an external
dependency on `slugify` (warned, not blocking); `assess-risks` wrote the risk register;
`schedule` put the item on the critical path; the gate auto-approved; `dispatch` spawned the
child (`child.spawned` at seq 112) and waited; `summarize` wrote the report; `done`.

Child run: `plan` → `design` → `spec-gate` (auto, `risk: low`) → `await-deps` (nothing to wait
for) → `build` → `test` → `tests-passed` (`passed: true`) → `review` → `review-verdict`
(`approve`) → `deploy` → `done`. Every node on attempt 1, no follow-up prompts. The build agent
created branch `feat/poem` from `main` and committed `343ace1 Add POEM.md`; tests 8/8. `deploy`
wrote `status: blocked` (no git remote, no GitHub repo, no CI) and did not push or create a repo.

## Worth noticing in the log

- The work-item context reached the prompts (artifacts under `.orca/work/add-poem-file/`),
  unlike the CLI `--var` path (#135).
- `deploy`'s `status: blocked` is never read; the child ends `success` and the program reports
  the item delivered (#136).
- Every stage agent `cat`-ed the previous run's flat `.orca/work/*.md` as "prior" context (#137).
- The build agent's branch choice differs from the first run's and leaves the shared checkout
  on `feat/poem` (#139).
- All 14 `agent.permission` events are `allow` under `permissions.default: allow` (#140).
- Agent text is coalesced and tool calls summarised; tool output is not in the log (see
  REAL-AGENT-TEST.md §6).
