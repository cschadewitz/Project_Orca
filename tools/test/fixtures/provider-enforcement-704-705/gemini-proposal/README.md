# Gemini ACP authorization proposal fixtures for #705

Source: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) at
`6006c14a4decfe4b891c6263ad6ad5992e404b5b` (CLI package version 0.65.0), Copyright 2025-2026
Google LLC (per-file headers), Apache-2.0. The exact upstream license bytes are in `license-gemini-cli.txt`.
Nothing here is a provider distribution, an executable launcher or an upstream submission.

[`manifest.json`](manifest.json) records, for each `*.txt` extract, the upstream path, line
range, Git blob SHA and the SHA256 and byte length of the extract. Extracts are unmodified
consecutive lines (`sed -n 'START,ENDp'` of the pinned blob):

| Extract | Upstream lines | Used for |
| --- | --- | --- |
| `acp-session-run-tool.txt` | `packages/cli/src/acp/acpSession.ts` 694-840 | runTool permission route, run before and after the diff |
| `acp-utils-permission-options.txt` | `packages/cli/src/acp/acpUtils.ts` 85-200 | the options this request actually offers |
| `tools-confirmation-outcome.txt` | `packages/core/src/tools/tools.ts` 1106-1114 | checks the test's synthetic enum mirror |
| `tools-invocation-tail.txt` | `packages/core/src/tools/tools.ts` 108-113 | context for the diff's `tools.ts` hunk |
| `shell-imports.txt`, `shell-display-title.txt` | `packages/core/src/tools/shell.ts` 21-26, 253-258 | context for the diff's `shell.ts` hunks |
| `shell-sandbox-on-confirm.txt` | `packages/core/src/tools/shell.ts` 487-499 | the sandbox-expansion callback a response reaches |
| `shell-policy-update-options.txt` | `packages/core/src/tools/shell.ts` 285-305 | what an always answer asks policy to remember |
| `scheduler-standard-policy-update.txt` | `packages/core/src/scheduler/policy.ts` 207-242 | the published policy update, including the exec fallback |
| `policy-utils-escape-regex.txt`, `policy-utils-args-patterns.txt` | `packages/core/src/policy/utils.ts` 10-12, 56-90 | the open-prefix rule pattern built from it |
| `sandbox-linux-merge.txt` | `packages/core/src/sandbox/linux/LinuxSandboxManager.ts` 245-268 | remembered per-command sandbox approvals merged at dispatch |

The #713 excerpts `../gemini-permission.txt` (acpSession.ts 694-815) and
`../gemini-abort.txt` (shell.ts 540-551) are read and digest-checked against
[`source-pins.json`](../../../../../docs/preparation/provider-enforcement-704-705/source-pins.json),
not copied or changed.

`proposed-upstream.diff` is ORCA-authored: a proposed modification of the three named
upstream files, made with `diff -u` against the pinned blobs and checked with `git apply`.
Blank context lines are stored empty rather than as a single space, which `git apply` and
`patch` both accept. It has not been sent to, reviewed by or accepted by the upstream
project. Its changed lines are the only code in this directory that is not upstream text.

[`gemini-authorization-705.test.js`](../../../gemini-authorization-705.test.js) imports
none of this as a package. It strips TypeScript types from the extracts, surrounds them
with labelled synthetic scaffolding and runs them with synthetic dependencies. Command and
cwd strings stay data: nothing is sent to a shell, provider, MCP server or policy store.
