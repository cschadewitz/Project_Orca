- **daemon:** Delegate a workflow step to another ORCA daemon. An agent with
  `type: orca-daemon`, a `profile` from the new `remotes:` list and a `workflow` runs each of
  its steps as a run of that workflow on the remote daemon, over the same pinned SSH tunnel as
  the app's SSH profiles, with a credential the remote issued. The remote run is admitted once
  per step attempt, even across dropped connections, and shows in that daemon's own run list.
  Remote progress appears on the step, remote gates are asked on the parent and answered back,
  cancelling the parent cancels the remote run, and the remote run's artifacts are brought back
  to the step's deliverables. Refusals that a retry cannot fix fail the step with
  `DELEGATION_REFUSED` and a reason.
