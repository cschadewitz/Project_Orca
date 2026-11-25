# Contributing to ORCA

This guide is for anyone, person or agent, who turns a request into GitHub issues or opens a pull
request here. It explains how to track work, avoid duplicates, group what ships together and
check what you published. For setup, tests and code conventions, read
[Development](docs/DEVELOPMENT.md). Agents also start at [AGENTS.md](AGENTS.md).

You can read the [documentation index](docs/README.md) and [capability ledger](docs/ROADMAP.md)
without installing anything. Collaborator access alone does not ask you to change code, operate
hosts, change credentials or invite others. For a docs-only PR, follow
[documentation-only review](docs/DEVELOPMENT.md#documentation-only-review), and keep source,
review, CI, deployed and native evidence apart.

## Track work in GitHub

- Track public-safe work and follow-ups in GitHub issues and PRs. Reuse existing owners and link
  the implementation, evidence and remaining acceptance.
- Write for an eventual public audience. Keep out of the repository, issues, PRs and the site:
  work that cannot become public, private host or account details, credentials, private commands
  and the owner's personal notes.

The site's read-only workboard is built from issue labels ([#692](https://github.com/cschadewitz/Project_Orca/issues/692)):

| Issue label | Board column |
| --- | --- |
| `status:backlog` | Backlog |
| `status:ready` | Ready |
| `status:in-progress` | In progress |
| `status:review` | Review |
| `status:blocked` | Blocked |
| `status:done` | Done |
| `status:cancelled` | Cancelled |

1. A classified issue has exactly one status label. Keep unrelated labels.
2. No status label means **Untriaged**.
3. An unknown or second status label, a closed issue with an active status, or an open issue with
   a terminal status means **Needs classification**. Do not guess.
4. Done requires closed as completed. Cancelled requires closed as not planned
   (`state_reason: not_planned`). If `state_reason` is missing, report it as unknown.
5. A PR's state does not prove its parent issue is done.

Keep the site read-only, with its owner-only connection guard. This process does not change
repository visibility or authorize publishing upstream.

## Inventory before creating

1. Search open issues and PRs for the outcome, the area and alternative terms. Also read relevant
   closed issues, merged PRs, current code and docs. A closed issue alone does not prove a feature
   shipped.
2. Record what exists, what is in progress and the remaining gap, with links. Reuse a suitable
   issue and cross-reference related work. Retag an issue rather than open a duplicate.
3. Keep existing labels, assignees, state and history unless asked to change them. Add context
   instead of rewriting someone else's issue. Do not reopen completed work or recreate a shipped
   feature because a new plan uses different words.

## Write one clear outcome

Use the **Feature or planned work** template for a feature, substantial improvement or
implementation slice. State:

| Section | Contents |
| --- | --- |
| Problem and outcome | Who needs it, what is missing, what becomes possible. |
| Scope | The concrete work in this issue. |
| Acceptance criteria | Observable, testable results, including failure and recovery cases, and how they will be verified. |
| Non-goals | Tempting nearby work deliberately left out. |
| Existing foundations | Issues, PRs, code or docs to build on, what already shipped, and why this issue is still needed. |
| Dependencies and execution | Real blockers, related work, ordering, and what can run in parallel. |

Split work when the parts can be built and verified independently. Do not make every detail an
issue. A small bug can use a blank issue with reproduction steps, expected and actual behaviour,
and version or environment.

## Group by what ships together

Give each issue meant to ship with a group one primary `ship-group:<coherent-outcome>` label.
Choose a short, stable outcome name, reuse an existing group where it fits, and label every
member. A group is a deliverable, not every issue touching one package. Cross-reference other
groups in the body; never give one issue several primary groups. A small independent issue needs
no group.

These are separate:

| Dimension | Meaning |
| --- | --- |
| Ship group | Which issues ship together. |
| Topic or area labels | What the issue is about. Keep useful existing ones. |
| Release bump labels | `release:major`, `release:minor`, `release:patch` or `release:none` ([Releasing](docs/RELEASING.md)). |
| Milestone | An explicitly chosen release plan. Leave new issues without one until milestone planning is asked for. Keep existing assignments. A group or dependency never assigns a version. |

The template's ship-group text is a proposal, not a label. Select the matching label when
triaging; if it does not exist, agree the name before creating it. Nothing here automates labels
or triggers releases.

## Make dependencies precise

- **Hard dependency:** `Blocked by #123 — needs the exported schema before this can be completed.`
  Use real links and explain the prerequisite. Write `None` when there are no hard blockers. (The
  numbers here are examples.)
- **Related or soft dependency:** `Related to #124 — coordinates terminology, but can proceed
  independently.` A shared topic, shared files or a preferred order is not a hard blocker.
- State the order where it matters, and say what can run in parallel. A shared ship group does not
  mean serial work.

For a batch, sketch the graph of hard dependencies before publishing, following blockers outside
the batch too. Check every link resolves, there are no self-links or cycles, and prerequisites
come first. If there is a cycle, split the shared prerequisite or change the scope; do not hide it
in an ordering note. Name unresolved dependencies instead of inventing issue numbers, and resolve
them before the plan counts as ready.

## Publish and read back

1. Check the inventory again for work created or finished while you planned.
2. For a batch, keep a map from draft names to issue numbers, and replace draft names with real
   `#` links after creating them.
3. Read every created or edited issue back from GitHub and check:
   - title, body and acceptance criteria match the intended outcome;
   - each grouped issue has its one primary ship-group label; topic and bump labels, assignees,
     state and milestones are intact;
   - blocker and related links point at the right issues, the order agrees with them, parallel
     work is clear, and the hard-dependency graph has no cycles;
   - no duplicate issue or unrequested milestone was added.
4. Report the published links and anything unresolved. A successful write response is not
   verification.
