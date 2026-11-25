# M10 maintenance observer source review — 9 October 2026

Scope: the remaining bounded production-observer/launcher preparation in #483,
based on main `db579fb7ac9cfce2e4e6901713088a80602311da` and merged #485
(`a299db8bb9d7eb47c103090b9f62d7af3f3db29b`). The draft PR records the exact
final head. #483 remains open for source/identity binding and live acceptance.

Read repository `AGENTS.md` and development instructions. `/workspace/.agents` was
empty; there were no nested repository `AGENTS.md` or `SKILL.md` instructions.
No subdelegation or shared app entrypoint changes were used.

## Evidence on the final source

Environment: Linux validation container, Node 24.19.0, Vitest 5.0.2,
TypeScript 7.0.2, ESLint 10.11.0, Prettier 3.9.9. Checks used installed binaries.

| Check | Result |
| --- | --- |
| `vitest run packages/maintenance-mcp/test --maxWorkers=2` | 84 passed, four files; synthetic kernel/children/journal/stdio/launcher only |
| Scoped TypeScript source and test check | Passed; temporary config extended root tsconfig with only maintenance source/test includes and repository Node type roots |
| `tsc -b packages/maintenance-mcp` | Passed; independent package build |
| `eslint packages/maintenance-mcp/src packages/maintenance-mcp/test` | Passed |
| `prettier --check packages/maintenance-mcp` | Passed; prose is ignored by repository formatter policy |
| Changed prose UTF-8/LF/newline/whitespace/fences/local links | Passed |
| Synthetic rendered tunnel YAML parse | Passed using existing YAML dependency; no profile/key/tunnel was opened or executed |
| `git diff --check` | Passed |

The initial preloaded server SDK resolved to 2.2.0 despite current main's declared
2.3.0. Early tests were provisional. A filtered frozen pnpm attempt refused to replace
the preloaded modules directory without a TTY; it did not purge that directory.
Instead, exact server 2.3.0, client/core 2.2.0 and Zod 4.6.5 were installed into an
isolated writable validation directory with npm lifecycle scripts disabled. Only the
local maintenance-package server symlink was redirected to that install. The final
84-test run, scoped statics and build resolved server **2.3.0**, client **2.2.0** and
Zod **4.6.5**. No repository dependency manifest or lockfile was changed.

During implementation, an abort test was updated when the boot reader was tightened
to stop before the next source call. A template test initially matched the unpopulated
`tunnel_id` field as if it were a populated identifier; its identifier pattern was
corrected. Focused lint issues were fixed. Self-review also tightened memory-key
duplication checks and malformed unit key/value rejection before the final pass.

## Self-review

- Public MCP schemas still advertise exactly four closed read-only tools. There is
  no shell/path/unit/bus selector, raw-log export, service mutation or ORCA runtime import.
  Default stdio remains refusing; observer stdio is an explicit entry.
- Host acquisition uses only fixed root-owned proc descriptors and root statfs;
  partial reads are bounded before decode, descriptors close on errors, integer
  capacities are validated and boot is checked on both sides of acquisition.
- Source query arguments and clean child environment are fixed. Service identities
  remain null in the shipped policy. Approved source preparation refuses root, another
  UID, system-manager fallback and foreground-ORCA inference. Actual work-route services
  under Casey's UID are therefore unavailable to a separate maintenance UID.
- Journals are selected by exact current-user UID/unit/boot, fixed lookback and record
  cap. Only dedicated structured fields are projected. Every record's provenance is
  validated; secret bodies, paths, argv, cursor and malformed/binary fields are discarded.
  Empty/omitted/capped snapshots do not establish complete journal coverage.
- Source stdout and discarded stderr share the byte bound. Warnings fail closed.
  Query overflow/abort/deadline kills only that read child; completion waits for close.
  Existing two-slot backend timeout behavior prevents unbounded orphan reads and keeps
  discovery ready. Native filesystem operations and external query memory still need
  supervisor limits; source code does not claim ingress/session or process-memory proof.
- Candidate templates contain placeholders only, have independent runtime/key/profile
  references, clear environment before startup and have no ORCA service dependency or
  restart propagation. Candidate hardening/resource limits need host verification.
- Discovery retains unavailable boot and unverified caller identities. Observed kernel
  boot, bridge UUID and policy hash never grant authority or attest the deployment.

No remaining source finding was identified within this bounded preparation review.
This is self-review, not independent security clearance or activation approval.

## Explicit remaining gates

The [runbook](../maintenance-observer-runbook.md) separately lists activation,
revocation and outage prerequisites. Manager/UID/unit pins, agent-01 deployment/root
namespace binding, narrow journal visibility and producer compatibility are unresolved.
Official client execution, real-host sources, denied/fresh/existing-session revocation,
rate/session/slow-reader controls, service supervision, logout/reboot and ORCA outage
acceptance were not run. Sharing agent-01 cannot survive agent-01 host outage.

Historical #485 CI evidence was reused, not rerun or represented as this head's proof.
No broad repository suite, Actions dispatch, release, deployment, access/credential
change, host installation, identity/tunnel/service creation or paid operation was performed.
