INACTIVE TWO-TASK INPUT DRAFTS
Prepared 2026-10-05 for #502. This packet proposes no live action.

First task
fence-fix.vars.json supplies every v4 input and pins the existing combined candidate 1b8f196e4df22066efda3c0ed1331a64d9061c4d. It fixes only #498's asynchronous publication-fence rejection issue and regressions in three explicit paths. This is useful integration work on the combined source while keeping the unchanged v4 review budget manageable.

Second task
helper-adoption.follow-on.json is deliberately NOT an admission payload. It omits expectedHead and marks the actual first-task commit and collector stale-reason decision as prerequisites. Four existing files are proposed. A later base requires its own reviewed import/base selection and a confirmed-unused workflow version, because current v4 hardcodes the original candidate. No workflow definition or artifact limit is changed by this packet.

Review budget
v4 allows eight optional full-source parts, each <=12000 UTF-8 bytes, and result JSON <=8192 bytes. Files are split individually; count only actual changed final files, including committed and uncommitted changes. First-task initial files are 11795 + 19369 + 13325 = 44489 bytes, currently 1+2+2 = 5 parts. Normal regression growth has headroom, but the exact final count is mandatory. The second task's initial four files total 59571 bytes, six parts. These are forecasts, not a waiver or completed review.

Commands
Both drafts avoid package-manager execution. Direct TypeScript build uses the selected candidate's tsconfig.build.json; it does not call root build/typecheck scripts that contain pnpm. CLI bin paths are deliberately resolved from installed manifests rather than copying .pnpm directory names. This algorithm is part of the draft, not permission to choose arbitrary tooling. The next owner handoff validates the four bindings read-only. No full rebuild/install/native diagnostics should be repeated to validate a command plan.

Authority sequence
1. Review this packet.
2. Existing owner agent: bounded inactive input/CLI preflight only (owner-readonly-handoff.txt).
3. Owner explicitly approves source import, paired base/v4 activation, controlled restart, and one admission with the exact first-task inputs, stopping at the unanswered human gate.
4. Bind the already prepared relocation proposal to the actual daemon-owned root and original provisioning receipt. Separately approve copying/relocation and root-local checks.
5. Only after proof and a separate ready decision does the coding agent start.
6. Review the first commit before binding the follow-on task.

No source implementation, project check, import, active configuration change, daemon operation, admission, dependency copy or gate answer has occurred here.
