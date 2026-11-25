# Archive

This folder is for anyone who needs the history behind a decision: past reviews, design
preparation, implementation notes, research and session logs. Nothing here describes the
product as it is today. For that, start at the [docs index](../README.md).

The files were moved here unchanged. They keep the old ORCA name on purpose, and the rename
codemod skips this folder, so the record says what it said when it was written.

| Folder | What it holds |
| --- | --- |
| `Current_State/` | The 2026-09-29 architecture review. Byte for byte; `BASELINE-MANIFEST.sha256` still checks it. |
| `preparation/` | Design and evidence packets written before a feature was built. |
| `implementation/` | Notes written while a feature was built. |
| `reviews/` | Dated reviews and audits. |
| `research/` | Research notes. |
| `session-logs/` | Logs of agent working sessions. |
| `v0.5.2-*.md` | The v0.5.2 checklists and implementation plan. |
| `runtime-*-parallel-contract.md`, `runtime-*-integration.md` | Dated contracts and integration records for the foundation, next and operator runtime waves. |
| `patches/` | Integration patches from those waves. They are already applied; do not reapply them. |

## Links in these files

Relative links point to where files were when they were written. Many no longer resolve,
because these files moved one folder deeper and the code they cite has moved on. To read a
file with its links working, browse the repository at commit `7a8e24ed`, the last commit
before the move.

## What stayed in `docs/preparation/`

Some preparation packets are still read by tests, CI, lint or the TypeScript build, so they
stay where that code expects them: `acp-command-conformance`, `beta-first-job`,
`copilot-cli-acp-709`, `manual-diagnostics-contract`, `opencode-acp-710`,
`owned-root-candidate-49efcc7`, `private-candidate-windows-linux`, `private-mcp-access`,
`provider-enforcement-704-705`, `tool-execution-guards` and `trusted-prepared-roots`.
