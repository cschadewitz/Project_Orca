- **app:** an agent card carries **Permissions**, which opens that agent's policy as an
  inspector beside the cards: the whole effective policy in the order ORCA evaluates it, with
  the configured rules read-only — they are `orca.config.yaml`'s, and the panel links to the
  Config form rather than rewriting an array a person curated — and the `orca.permissions.json`
  grants editable. A grant can be removed, narrowed or widened by kind, path, path prefix,
  scope or title pattern, or added by hand, in which case it records the time and
  `granted for added by hand in the app` so a reader of the diff can tell it from one a run
  wrote (ADR 0009, #266).
- **app:** saving a grant sends the whole sidecar as `config.set` on the `permissions`
  document, over the Config surface's own draft model: the same `expectedRevision`, and the
  same refusal that never costs a draft — `CONFIG_STALE` shows the conflict, offers
  **Reload**, and what was edited is still there afterwards. Rules nobody touched keep when
  they were added and what for, and a fallthrough is never written into the sidecar.
- **app:** ORCA's own default rules are drawn as their own read-only group, **ORCA's
  defaults**, on the policy panel and on the Config surface's read-only view: no file holds
  them and `config.set` cannot address them, so there is no link out of the group and nothing
  to edit — writing a fallthrough in the config is what opts out of them (#140).
- **app:** the sidecar's round trip is lossless or it is refused. A key this app does not
  recognise rides through a save untouched, so editing one grant cannot delete a field on
  another; and a document with an unknown `version`, or a rule with no `match` or an unknown
  decision, shows the "cannot be edited here" state and points at the raw view rather than
  being rewritten into a shape it guessed at. A sidecar somebody hand-wrote with its keys in
  another order now counts one edit as one change rather than counting every row.
- **app:** a read-only daemon's policy panel shows its grants as text throughout. The enum
  menus already degraded; the path and pattern fields were boxes that quietly refused typing.
- **app:** a run answering "allow always" reaches the open policy panel through
  `config.changed`, so the rows are the file's rather than the ones that were read.
- **app:** a claim whose owning run cannot resume gets **Release**, with a confirmation
  naming the work item, the run it is taken from and what happens next; a claim the daemon
  would refuse says why on the control instead. What releasing did *not* fix comes back from
  the daemon in words and is both announced and shown on the row — a dead run's log never
  moves on, so the item can still read in-progress. Forcing a release out of a run that could
  still resume stays `orca claims release --force`.
- **app:** both are in the command palette as keyless actions on the object — *Edit
  permissions for `<agent>`* and *Release claim on `<work item>`*.
- **app:** neither control is drawn at all against a daemon with no `config.set` or
  `claims.release`; the policy is still readable there, because reading it is a read.
- **app:** ORCA still does not count auto-approvals. The policy panel says so where a count
  would have gone rather than tallying one in the client.
