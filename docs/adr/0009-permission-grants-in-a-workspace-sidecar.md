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

**2026‑09‑21 (#140):** the configured `default` is no longer `allow`. An agent that leaves
`default:` unset gets `ask`, and every agent gets `DEFAULT_PERMISSION_POLICY`'s rules —
allowing reads, searches and file changes inside the run's own workspace, and `think`.

**Corrected 2026‑09‑21 (#140):** those rules are a **third layer, appended last**, after the
sidecar. The first cut of #140 folded them into the parsed config, inside
`PermissionPolicySchema`'s transform, which put them *ahead* of the sidecar and so contradicted
this ADR's central rule twice over. A default `allow` on an in‑workspace edit was matched
before the sidecar got a turn, so a `reject_always` an operator had recorded could never fire;
and anything that read the parsed config back — `orca demo`'s generated `orca.config.yaml`,
`config.get`'s per‑rule provenance — reported rules nobody had written as if a person had
written them. The layering is now **configuration → sidecar → defaults**, assembled in one
place (`loadEffectivePermissionPolicy` in `@orca/agents`), and the parsed config is exactly
what the file says. A configured `deny` still wins everything; a sidecar `deny` now beats a
default `allow`, which is what "configuration first, then the sidecar" was always supposed to
mean for a layer that is neither.

The defaults are appended whatever the configured `default` says, `allow` included. Every one
of them allows something inside the run's own workspace (or `think`), which a `default: allow`
agent was going to get anyway; the configured `default` decides everything they do not match,
and that — `ask` versus `allow` for `execute`, the network, and paths outside the workspace —
is the whole of the opt‑out. `config.get` labels them `source: "default"` so a surface can
show them as the floor they are rather than as config.

**2026‑09‑21 (#266):** the sidecar is now readable and editable over the protocol.
`config.get` returns it as a second document beside `orca.config.yaml` — its own path, its
own content‑hash revision, its raw text — together with the effective policy per agent, in
`layerPermissionPolicies`' evaluation order, each rule labelled with the document it came
from; `config.set` writes it through `replacePermissionPolicyFile` in `@orca/agents`, under
the same `link()` lock and in the same fixed key order a machine write uses, so an
operator's edit and a run answering "always" both land. A document carrying a `default` is
refused rather than stripped, which is this ADR's central rule stated at the moment somebody
tries the opposite. Nothing above changes: the file, the layering and the writer are the
ones decided here, and what is new is only that a client can see them.

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
