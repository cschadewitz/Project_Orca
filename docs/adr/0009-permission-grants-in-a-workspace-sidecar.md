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

**The defaults apply only when the config left `default:` unset**, and that is why `default`
stays optional all the way through parsing: `permissions:` absent and
`permissions: { default: ask }` are two different policies now, not one. Writing `default:` at
all — `ask` exactly as much as `allow` — is an author saying what happens when no rule matched,
and appending rules that match things on their behalf would be answering a question they did
not ask. Somebody who wrote `default: ask` with no rules asked to be asked about everything,
and quietly allowing in‑workspace edits on top of that would be ORCA deciding it knew better.
So an explicit `default` is the opt‑out, whichever decision it names, and `defaultRulesApply`
in `@orca/core` is the one place that is decided.

`effectivePermissionPolicy` is the one place the three layers are assembled, and every
evaluator goes through it: the ACP session that answers `session/request_permission`,
`loadEffectivePermissionPolicy` (which only adds the sidecar file reading), and `config.get`,
which labels each rule `config` / `permissions` / `default` so a surface can show the floor as
a floor rather than as config somebody wrote.

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

**2026‑09‑21 (#271):** the reading half landed. Everything above was decided in v0.4.0 and
the writer shipped with it, but nothing ever evaluated the file: `openAcpSession` answered
`session/request_permission` against the agent's configured policy, the engine's session
factory passed no sidecar path, and `loadEffectivePermissionPolicy` had no production caller
at all. So a person who answered "always" was told the grant was recorded — it was — and was
then asked the same question on the next tool call, in that run and in every later one.

`openAcpSession` now takes `permissionFiles` and evaluates through
`loadEffectivePermissionPolicy` **on every ask**, not once per session: "always" is answered
*while a session is open*, so a policy captured at `session/new` would still be the old one
when the next tool call arrived. The path is bound in `makeSessionFactory`
(`packages/cli/src/bootstrap.ts`) to `permissionPolicyPath(app.configDir)` — the same value
the daemon's `ControlModel` receives — so the file that is written and the file that is read
are the same file by construction, for `orca run`, `orca resume`, `orca serve` and the ACP
facade alike. Two smaller corrections travel with it: the session now passes the run's
workspace as the evaluation scope, without which the workspace‑relative paths this ADR
insists on could never match anything; and a sidecar that is corrupt is logged once at warn
and skipped for the ask rather than failing it, because an unreadable file must not be able
to block an agent. **2026-10-01 clarification:** this fallback can lose restrictions too:
the sidecar schema allows deny/ask rules, and dropping them can expose a later default
allow. Configured rules still precede the overlay. A conservative error policy is not
established by rereading; see [R07 reconciliation](../../Current_State/addenda/2026-10-01-main-reconciliation.md).

**2026‑10‑14 (C4‑01):** an agent could grant itself everything. With no `workspace:` the
config directory *is* the run's workspace, so this file, `orca.config.yaml`, the `.orca`
store and `auth/` (with the local owner token) were all "inside the workspace", where the
default rules allow edits. An agent that wrote `{"match":{},"decision":"allow"}` here had
every later `execute` approved, because the file is re‑read per ask. Three changes:

- **ORCA's own files are outside every rule.** `decidePermission` denies a call that touches
  one before any layer is consulted, so no configured rule, sidecar rule, default or
  `default: allow` opens them. Read‑only to an agent: every config filename in the config
  directory, the config file actually loaded, this sidecar and the store — except the store's
  `work/` and `program/`, where the shipped workflows have agents write deliverables
  (`.orca/work/…` from a workspace that holds the store). Unreadable as well:
  `auth/` and the store's `private-execution` and `private-workflows` directories, which hold
  its keys. The ACP client's `fs/read_text_file` and `fs/write_text_file` handlers refuse
  the same list. Paths are compared as the file system resolves them —
  symlinks followed, `..` taken physically — and segment by segment. The CLI's
  `makeSessionFactory` binds the list beside the sidecar path (`orcaProtectedPaths`).
- **ORCA's own file executor is decided by the policy (#703).** An agent given `fs/*` has
  ORCA do its file I/O, and before this the handlers checked only the session roots and the
  list above, so an agent that never asked wrote what the policy would refuse. Now each call is
  decided, just before its I/O and with the policy read fresh, as the `read` or `edit` call an
  ask for it would carry (`owned-fs-gate.ts`). An `allow` proceeds and a `deny` refuses. An
  `ask` is put to a person on the agent's behalf, with one-time options only, and only that
  answer's `allow_once` lets this one operation through; the answer to the agent's own earlier
  ask is not reused, so one answer covers one operation. After every await the turn must be
  the same live one, and after the answer the policy is read again and a deny that appeared
  meanwhile wins. A call outside a live turn is refused. Each decision is recorded like an
  ask's, prefixed `fs:`. Both handlers serve only this session's own ACP session id, and the
  live-turn check runs again in the same step that starts the host I/O. On a local host the
  target is resolved physically, links followed (a dangling one too) (`resolveOwnedFsTarget`):
  a path that leads outside every session root once resolved is refused; when the file it
  reaches is not the path as written, the policy decides both and the stricter answer stands;
  and the I/O goes to the resolved file (`owned-fs-io.ts`). Only an ordinary file is read or
  written. An existing file is bound to the identity (device and inode) the decision saw: just
  before the open it must still be an ordinary file with that identity, the open follows no
  final link and neither waits nor takes a terminal (`O_NOFOLLOW`, `O_NONBLOCK`, `O_NOCTTY`
  where the platform has them), and the descriptor's identity and type are compared before a
  byte is read or written. A new file is bound only on Linux and only when its parent
  directory exists: the parent is opened as a directory and checked by identity on the
  descriptor, and the file is created exclusively through `/proc/self/fd/N/name`, which
  resolves through that open directory as `openat` would; Linux without a usable
  `/proc/self/fd` refuses a new file. Every other new file is best effort and outside the
  identity-bound guarantee (#1034): one whose directories must be made first, and any new file
  on macOS and Windows, where Node has no directory-bound creation. There each directory an
  effect happens in is checked by identity and physical path just before the effect; a change
  found before the first effect refuses the operation, and one in the instant between a check
  and its effect is found only afterwards, if at all, and then reported as an unknown effect.
  Nothing is removed afterwards. A write is complete only when all of its content was written. A
  path whose identity cannot be established, or that is not an ordinary file, is
  refused. This is still not an operating-system boundary. Remote (SSH) hosts are explicitly
  outside this: their paths are compared as written and their I/O is not identity-bound, as
  before; verifying them is tracked separately (#1032). A reusable permit still waits for
  physical target verification. Each operation's authorization is recorded
  (`agent.fs.authorized`) and made durable before its I/O can start: it is synced through the
  event store's exact-event barrier (`synchronizeEvent`), as a turn record is, and a store
  without that barrier, or a record that cannot be written, refuses the operation. The record
  names the file only by a bounded, root-relative display reference; the absolute path and the
  file it resolved to stay in the daemon. After the record the policy is read again and must
  still allow the operation (an `allow` must still be `allow`; an operation a person allowed
  once must not have become `deny`), the turn must still be live and the target unchanged, or
  the operation is refused. Its outcome follows (`agent.fs.completed`), through a recorder
  bound when the authorization was made to its step, session and turn: completed; failed (a
  read, or a write that failed before changing anything); not dispatched when a check after
  the record refused; or effect-unknown, a write that failed once it may have changed the
  file, which the agent is told is not safe to retry as if it had not run. An authorization
  with no outcome, as after a crash, or with an effect-unknown one, is execution-unknown
  (`ownedFsExecutions`): ORCA never repeats the operation, and no transaction spans the file
  and the record. The `fs:` decision log is written alongside and not awaited. This is the
  client-owned ACP file path only: an agent's native tools and its own MCP connections do not
  pass through it, and keeping an agent on this path is an operating-system boundary's job.
- **A plain-language rule allows one call at most, inside hard boundaries (#702).** A config
  rule may carry `judge: { criterion }` in place of a `decision`; a rule with both, or a judged
  rule that matches a `command`, is refused. The loader carries judged rules apart from the
  typed ones (`PermissionPolicy.judged`, named `config:N` by their place as written, with a
  content revision), so everything that decides synchronously, the file gate and the hooks
  included, decides exactly as if they were not there. Only a session given a judge consults
  them (`judged-lane.ts`), and only for the agent's own asks: after the typed rules answer
  `ask` or `deny`, and only when no typed `deny` or `ask` rule matches the call anywhere, no
  sidecar was unreadable, the call is a `read` or `search` that is not command-like and
  claims no MCP tool (#1021), and ORCA
  itself verified every target as a regular file inside the workspace and outside every
  protected path (`verifyPlainRuleTargets`). A judge's `covered` becomes allow once, never
  allow always; the policy is read again first and the rule must still be there unchanged, with
  no new restriction, and the targets verified again must be the same files the judge was shown
  (same real paths and file-system identities). The targets are checked on the daemon's own
  file system, so the lane is open only for a session on the local host. Every other outcome leaves the typed
  answer, and a turn that ended meanwhile is answered as expired. The event records the
  verdict, the rule's id and the judge's config ref, not the rule's revision. Nothing wires a
  judge yet; saved judged rules (a version-4 sidecar) come with the app's save method.
- **Each decision names what decided it (#702).** `explainPermission` is the one evaluation
  and `decidePermission` its decision: it reports whether ORCA's own files, a rule, the
  fallthrough or the command restriction decided, and for a rule its index. The loader records
  each evaluated rule's origin beside it: the layer (`config`, `sidecar`, `default`), the
  rule's index in that layer as written (a sidecar index counts the entries skipped as expired
  or wildcard, so it names the entry a person sees), and for a sidecar the sha256 of the very
  bytes the rule was parsed from. An allow turned into an ask behind an unreadable sidecar is
  marked `capped`. `agent.permission` carries this as an optional `rule`, for asks and `fs:`
  calls alike. For a restricted command that is asked, it cites the first part an explicit ask
  rule decided before a part that only fell through to an ask default. The event carries
  the layer and index but never the sidecar `revision`: that sha256 is a deterministic
  fingerprint of the whole permission file, and an ordinary event reaches every reader and
  export of the run log, where it could correlate one workspace's policy across runs. The
  loader keeps it in memory for owner-private audit data, and the event schema drops one a
  writer sends. The record is a record of the evaluation, not of the person's answer, and it is not a
  durable authorization record either: it says which rule ORCA consulted, not what then ran.
- **A wildcard `allow` in this file is ignored**, with a warning. Everything ORCA writes here
  is derived and scoped, and the Config surface narrows a kind by a path, a prefix, the
  workspace or a title; an `allow` naming no kind, or a kind and nothing that narrows it
  (`isWildcardPermissionRule` in `@orca/core`), is the shape of an agent's work, not a
  person's. A wildcard belongs in `orca.config.yaml`, where it still works. `config.get`
  leaves an ignored rule out of the effective policy too. A wildcard `deny` or `ask` stays.
- **An unreadable sidecar no longer exposes a default allow.** This settles the 2026‑10‑01
  clarification: every `allow` decided *after* a sidecar that could not be read — a later
  sidecar's, a default rule's, the fallthrough's — is an `ask` until it is repaired. The
  configured rules come first and decide as before. In an unattended run that refuses
  in‑workspace edits until the file is fixed, which the warn log says.

**What this does not cover.** An ACP agent's own tools — built‑in file editing, its shell —
act with the user's operating‑system permissions and need not ask ORCA anything, so none of
the above binds them; nor does it see a hard link made out of its view. In a hardened setup
the config directory should not be an agent workspace: point `workspace.root` at a
sub‑directory, or use the `git-worktree` provider with `isolateRoots: true`, so these files
are outside every agent root and ORCA's own requests about them are asked. A hard boundary
is the operating system's — a separate user or a sandbox — as `docs/daemon-security.md`
says of `auth/`.

**2026‑11‑23 (#702): a standing rule is reviewed, can end, and is ORCA's alone.** Three
changes, all on this file and its writer, with no second store:

- **Shown before it is saved.** `inputs.list` carries `standing` on a permission ask
  (protocol 2.8): the rule each "always" direction would write, derived from the same
  recorded tool call and workspace the write uses. The app's **Always allow** / **Always
  deny** open that rule with its agent and lifetime, and only **Save rule and …** sends; the
  plain **Answer** never writes. Where the preview says nothing can be scoped, or a 2.7 daemon
  sent none, there is nothing to save and the one-time answers still work. Each preview
  carries a `ref` (sha256 over the run, step, request, agent, direction and normalised
  rules); `inputs.answer` must echo it as `always.previewRef`, and the daemon derives the
  rule again and refuses `CONFIG_STALE` before answering anything when it no longer matches,
  so what is saved is what was shown or nothing.
- **A lifetime.** A rule may carry `expiresAt`. `inputs.answer`'s `always.durationMs` (at most
  90 days) is stamped on the daemon's clock; absent, the rule stands until removed, as
  before. An expired rule stays in the file for the diff and decides nothing: it is skipped
  per ask, and `config.get` leaves it out of the effective policy. An answer for a grant
  already on file extends that line in place (never shortens it) rather than appending a
  twin. A value that is not an instant makes the file unreadable rather than "forever".
  **A file holding any timed rule is version 3** (`PERMISSION_LIFETIME_VERSION`). Released
  0.7.0 and 0.7.1 read version 1 and strip `expiresAt`, so in a version 1 file a timed allow
  would be permanent to them; any other version they refuse, skipping the file with every
  later `allow` turned to `ask`, refusing to replace it and refusing to edit it on the
  Config surface. The writer stamps the version from the content, so removing the last
  timed rule makes the file version 1 again, and a version 1 file that carries `expiresAt`
  is refused. Version 2 is left to the inactive typed scoped-rule envelope.
  Removing a rule on the Config surface is how one is revoked; the next ask is decided
  without it.
- **No remembered native grant.** An automatic allow selects only an agent's `allow_once`
  and refuses (`allow:no-one-time-option`) when none is offered, instead of falling back to
  `allow_always`. A remembered option would have the agent stop asking, so an expired,
  removed or narrowed rule would never be consulted again. A person is offered one-time
  options only too: the live card already was, and now a parked ask and one forwarded to an
  upstream ACP client are as well, so an answer can never hand the agent a remembered grant.
  The deny fallback to `reject_always` is unchanged: it can
  only stop the agent.
- **Command-word rules.** A rule may match an `execute` call by its command's words:
  `command: "git push"` or `command: "npm *"`, where a final bare `*` is any further words.
  The command is `rawInput.command` when the agent sent one, else the title. A command rule
  can `deny` or `ask`, never `allow`: words are what the agent shows, not what runs. The
  executable a word resolves to, the working directory, a git alias, an npm script or a
  config file decide what a command does, and ORCA attests none of them while the agent runs
  the command in its own process, so a word match is a hint, not proof for an automatic yes.
  A config with a command `allow` is refused. For the same reason no standing allow is
  written or honoured for an `execute` call: `derivePermissionRules` refuses one
  (`unverified-command`), and a sidecar `execute` allow, by title or by command, is ignored
  like a wildcard, so such a call is answered once each time by a person. An allow for a
  command family waits for an executor ORCA runs itself and can constrain (#703). The match
  is lenient: the command is split into simple commands on `&&`, `||`, `;`, `|`, `&` and
  newlines, and a rule catches a part when the program appears by name and the rule's words
  follow in order with anything between, so `git push` catches `git -C repo push`,
  `sudo git push` and `bash -c "git push"`, and also `git log --grep push`. The call gets the
  strictest answer any part gets; a `cd` part decides nothing. **Once any layer holds a
  command rule, no `execute` call is allowed** (`unverifiedExecuteAllowed`): allow rules are
  skipped for it, so a legacy title allow ahead of a restriction cannot win, and a call no
  deny catches is asked, whether the allow would have come from a rule, a kindless rule or
  `default: allow`, and whether or not the agent sent its command apart from the title. A
  policy with no command rule anywhere decides as it did. In `orca.config.yaml` an agent
  whose `permissions` hold a command rule must not also say `default: allow` or carry an
  allow with no `kind` or `kind: execute`; such a config is refused with what to change
  (`COMMAND_POLICY_PERMISSIVE`): set `default: ask` or leave it unset, and give each allow a
  kind other than `execute`. A command rule in the sidecar, from "Always deny", turns the
  same restriction on for that agent. Two defensive cases count as restricted too: a call the
  agent left unclassified (no kind, or `other`), or whose input carries a command
  (`rawInput.command`) whatever kind it claims, is never allowed in a restricted policy, and a
  `command` rule's deny or ask reaches it; and when a sidecar cannot be read, it might have
  held a restriction, so the policy is marked `commandsRestricted` and no `execute` or
  unclassified call is allowed, not even by the configured rules ahead of it, until the file
  is repaired. All of this reads what the agent's adapter reports: its kind, title and
  `rawInput` are advice, not facts ORCA checked. An untrusted adapter can misreport a call,
  so these rules add friction and refusals but give no enforcement guarantee; that takes an
  executor ORCA runs itself (#703) or an operating-system boundary. A sidecar holding a command
  rule is version 3, and a config holding one must say `version: 2`, so 0.7.x refuses them.
  The "Always deny" review offers the exact command plus wider patterns (`npm run *`,
  `npm *`), each with its own preview ref, and says a family rule refuses the whole family.

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
