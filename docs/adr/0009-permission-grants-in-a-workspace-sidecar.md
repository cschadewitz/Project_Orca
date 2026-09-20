# ADR 0009 — "Allow always" writes to a workspace sidecar, layered under the configured rules

**Status:** accepted

## Context
A `PermissionPolicy` (`packages/core/src/model/agent.ts`) is a `default` decision and an
ordered list of rules, evaluated first‑match‑wins by `decidePermission`
(`packages/agents/src/permissions.ts`). Until now it was loaded configuration and nothing
else: a person wrote it, and nothing ever wrote it back.

`inputs.answer` (#160) offers "allow always" alongside "allow once", and the desktop app
(#161) puts a button on it. Both need somewhere for the answer to go, and something to
decide what exactly was granted. Two questions: where does a written grant live, and what
rule does one answered request justify?

Options considered for the location:

1. Edit `agents[].permissions` in `orca.config.yaml` in place.
2. Keep grants in the `.orca` store.
3. Append a policy event to the event log.
4. A sidecar file beside the config, layered over the configured rules.

## Decision
Option 4: `orca.permissions.json` in the config directory, read as a layer *after* the
agent's configured rules.

- **Precedence is configuration first, then the sidecar.** `layerPermissionPolicies`
  concatenates rule lists in that order and evaluation is first‑match‑wins, so a configured
  `deny` can never be undone by something a machine wrote. The `default` comes from
  configuration alone; the sidecar schema has no `default` field, because answering one
  prompt must not change the answer to every other one.
- **The sidecar is `agents: { <id>: { rules: [...] } }`**, each rule carrying `addedAt` and
  `grantedFor` (the tool call title, verbatim). It is meant to be read: a standing
  permission grant that teammates and code review can see is the safer default for something
  security‑relevant, and that is the whole reason it is a file in the project rather than a
  row in a store.
- **A third layer slots in without a schema change.** `layerPermissionPolicies` is variadic
  and the document shape carries no notion of its own scope, so a user‑scoped
  `permissions.json` layers *under* the workspace one by being passed after it. v0.4.0 ships
  the workspace sidecar only.
- **Paths in a written rule are workspace‑relative**, resolved against `Run.workspace.cwd`
  at evaluation time. That is what lets a grant made in one git worktree still fire in the
  next one, which sits at a different absolute path.
- **JSON, not YAML.** `@orca/agents` owns the file IO and depends on `@orca/core` and the
  ACP SDK only; a YAML sidecar would mean a new dependency edge for a format, which is the
  wrong trade for a file that is two levels of nesting deep. Rules are serialised with a
  fixed key order so a rewrite is a minimal diff.
- **Read‑modify‑write is serialised** by a `link()`‑created lock and replaced by
  `tmp`+`rename`, so two runs answering "always" at the same moment both land. The store's
  `withFileLock` is the fuller version of the same idiom and is not reused: `agents` sits to
  the right of `store` in the layering.

### What one request justifies
`derivePermissionRules` turns one answered request into rules, and the interesting half is
what it refuses. The kind is always carried, never dropped. An `execute` call is scoped to
its exact command — its locations are the directory it ran in, and a path‑scoped `execute`
rule would grant every command in that tree. Any other kind with locations is scoped to
those exact paths, one rule per location. A kind with no locations is scoped to its title,
anchored `^…$` with the metacharacters escaped.

It refuses, rather than generalise, a parent directory; anything outside the workspace
(`/etc/hosts`, `~/.ssh`, a sibling checkout), because "always" is scoped to the workspace
and the sidecar's location is what says so; the workspace root itself; and anything carrying
a run id, ULID, digest, timestamp or temp directory, which would be a rule that can never
match again. A refusal is reported to the caller, which honours the answer once and does not
pretend to have recorded it.

## Consequences
+ The hand‑written half of the config stays hand‑written. Nothing appends to the Nth element
  of a curated `agents:` array, so a machine write can never collide with a human edit.
+ A grant is a reviewable diff, and one a `.gitignore` decision can be taken about
  deliberately rather than by accident.
+ `#176` (agents write policies, v0.5.0) has a file to edit with a schema and a writer.
− Two places to look when asking "why was this allowed". `decidePermission` reaching a rule
  in declared order makes the answer deterministic, but it is still two files.
− The writer is conservative enough that some answers cannot be recorded at all. That is
  intended — the alternative is a grant broader than what was agreed to — but it means
  "always" is sometimes honestly reported as "once".
