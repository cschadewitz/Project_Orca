- **protocol:** `workflows.list` and `workflows.get` (protocol 1.7), the workflow files as a
  display graph: nodes with the per‑type fields a viewer shows, edges with their conditions
  and labels, and the graphs written inline inside a `loop` or a `parallel` carried under the
  `parent::node` ids the engine addresses them by — so a nested graph can be drawn where it
  is or fetched again by id. Both are `READ_METHODS`, so `orca serve --read-only` answers
  them. `WorkflowView.versions` is which versions of a workflow the daemon can *see* — the
  one on disk plus the ones the store's runs recorded — and `workflows.get` still serves only
  the one on disk, because ORCA keeps no copy of the definition a finished run used.
- **protocol:** `runs.get` gains an optional `traversal`: the nodes a run took, in order, one
  entry per attempt, with the status, the timestamps, the child runs a container spawned and
  `viaEdge` — which edge of the definition the run arrived on. An edge nobody authored is
  never invented: a retry, a run resumed mid‑graph and a workflow the daemon no longer has
  all leave it absent.
- **protocol:** the `workflows.changed` notification. Nothing emits it yet and that is
  deliberate — there is no workflow reload path in the runtime — so a client may subscribe
  now and will hear one when workflow editing can honestly send it.
- **app:** `workflows.list` and `workflows.get` on the daemon client and the preload bridge
  (`window.orca.workflows`), ready for the workflow viewer. No UI yet.
