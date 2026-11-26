# Contributing to ORCA

For setup, tests and code conventions, read [Development](docs/DEVELOPMENT.md).
Agents also start at [AGENTS.md](AGENTS.md). This guide describes how to turn a
request into useful GitHub issues without duplicating work or promising a release.

An invited observing developer can begin with the [documentation index](docs/README.md)
and [capability ledger](docs/ROADMAP.md) without installing tools or using private
credentials. Repository collaboration access does not itself request code changes,
host operation, credential changes or additional invitations. For a docs-only PR,
follow [scoped documentation validation](docs/DEVELOPMENT.md#documentation-only-review)
and distinguish source, review, CI, deployed and native evidence.

## Track work in GitHub

Track public-safe work and unfinished follow-ups in GitHub issues and pull requests,
reusing existing owners and linking implementation, evidence and remaining acceptance.
Write for the repository's eventual public audience. Keep work that cannot eventually
be public, private host/account details, credentials, private commands and owner
personal notes out of repository content, issue/PR tracking and the site.

Use GitHub issues as the source for the site's read-only workboard, following
[#692](https://github.com/cschadewitz/Project_Orca/issues/692). Derive columns from
issue tags using this mapping:

| Issue label | Board column |
| --- | --- |
| `status:backlog` | Backlog |
| `status:ready` | Ready |
| `status:in-progress` | In progress |
| `status:review` | Review |
| `status:blocked` | Blocked |
| `status:done` | Done |
| `status:cancelled` | Cancelled |

Each classified issue has exactly one status label; preserve unrelated labels.
No status label means **Untriaged**. Unknown or multiple status labels, a closed
issue with an active status, or an open issue with a terminal status means
**Needs classification**; do not guess. Done requires closed/completed; Cancelled
requires closed/not planned (`state_reason: not_planned`). If `state_reason` is
missing, report it as unknown rather than inventing completion or cancellation.
A PR's state does not prove its parent issue is done.

Keep the site read-only and preserve the existing owner-only connection guard.
This workflow does not change repository visibility or authorize upstream publication.

## Inventory before creating

1. Search open issues and pull requests for the outcome, affected area and likely
   alternate terms. Read relevant closed issues, merged pull requests, current code
   and documentation too: a closed issue alone does not prove a feature shipped.
2. Record what already exists, what is in progress and the remaining gap, with links.
   Reuse a suitable existing issue; cross-reference related work. Retag an issue
   when needed to reflect the agreed grouping rather than opening a duplicate.
3. Preserve existing labels, assignees, state and discussion history unless a change
   to them is specifically requested. Add missing context rather than replacing
   someone else's issue wholesale. Do not reopen completed work or recreate shipped
   features just because a new plan uses different words.

## Write one clear outcome

Use the **Feature or planned work** issue template for a feature, substantial
improvement or implementation slice. Each issue should state:

- **Problem and outcome:** who needs it, what is missing, and what becomes possible.
- **Scope:** the concrete work included in this issue.
- **Acceptance criteria:** observable, testable results; include failure or recovery
  cases when relevant, and how the result will be verified.
- **Non-goals:** tempting adjacent work deliberately left out.
- **Existing foundations:** issues, pull requests, code or docs to build on, including
  what is already shipped and why this issue still needs to exist.
- **Dependencies and execution:** real blockers, related work, ordering and what can
  proceed in parallel.

Split work when outcomes can be implemented and verified independently. Do not turn
every implementation detail into an issue. Small bugs can use a blank issue with
reproduction steps, expected versus actual behavior, and relevant version/environment;
they do not need the full planning template.

## Group by what ships together

Use one primary `ship-group:<coherent-outcome>` label on each issue intended to ship
with a group. Choose a short, stable outcome name, reuse an existing group where it
fits, and apply the same label to all members. A group is a coherent deliverable,
not every issue touching the same package. Cross-reference other groups in the body
instead of giving an issue several competing primary ship groups. An independent
small issue need not invent a group.

These are separate dimensions:

- **Ship group:** which issues are intended to ship together.
- **Topic/area labels:** what the issue concerns; keep useful existing labels.
- **Release bump labels:** `release:major`, `release:minor`, `release:patch` or
  `release:none`, following [Releasing](docs/RELEASING.md).
- **Milestone:** an explicitly chosen release plan. Leave new issues unassigned until
  milestone planning is requested; preserve existing assignments unless asked to
  change them. A ship group or dependency does not assign a version or milestone.
  One automatic exception: a pull request merged into `main` without a milestone gets
  the earliest open minor it ships in (Milestone on merge, docs/WORKSTREAMS.md).

The template's ship-group text is a proposal, not an automatic GitHub label. Select
the matching label in GitHub when triaging; if it does not exist, agree on the name
before creating it. This process adds no label automation or release triggers.

## Large work with no target release

A large feature that should not wait for, or disturb, the next release is a workstream:
follow [Workstreams](docs/WORKSTREAMS.md). By default it lands on `main` in small pull
requests behind an incubating flag; a `feature/<name>` branch is only for work that
cannot ship dark. Say which in the tracking issue.

## Make dependencies precise

- **Hard dependency:** `Blocked by #123 — needs the exported schema before this can
  be completed.` Use actual issue links and explain the prerequisite; write `None`
  when there are no hard blockers. Issue numbers here are illustrative, not defaults.
- **Related / soft dependency:** `Related to #124 — coordinates terminology, but can
  proceed independently.` Shared topics, shared files or a preferred order alone are
  not hard blockers.
- State the implementation order where it matters, and explicitly identify work
  that can run in parallel. A shared ship group does not require serial execution.

For a batch, sketch the directed graph of hard dependencies before publishing.
Follow blockers outside the batch too. Confirm every link resolves, there are no
self-links or cycles, and prerequisites come before dependents in a topological
order. If a cycle appears, split the shared prerequisite or revise the scope; do
not disguise it as an ordering note. Name unresolved dependencies explicitly rather
than inventing issue numbers, and resolve them before treating the plan as ready.

## Publish and read back

Before publishing, check the inventory again for work created or completed during
planning. When creating a batch, keep a draft-to-issue-number map and replace draft
names with the actual `#` links after creation. Then read every created or edited
issue back from GitHub and verify:

- Title, body and acceptance criteria match the intended outcome.
- Each grouped item has its one primary ship-group label; topic and bump labels are
  intact, and assignees, state and existing milestone assignments were preserved.
- Hard blockers and related links point to the right issues, ordering agrees with
  the links, parallel work is clear, and the final hard-dependency graph is acyclic.
- No duplicate issue or unrequested milestone assignment was introduced.

Report the published issue links and anything still unresolved. Successful write
responses alone are not verification of the final plan.
