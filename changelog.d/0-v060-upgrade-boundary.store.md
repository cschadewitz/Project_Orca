**Upgrading from 0.6.0.** 0.6.0 shipped store epoch `ownership-fences-v1`, protocol 1.8
and capabilities `runs.read`, `runs.control`, `runs.subscribe`, `plan.read` and
`plan.write`. This release carries store epoch `operator-journals-v4` and protocol 2.0, and
adds the release capabilities `workflows.validateInputs` and `inputs.live`. The epochs and
protocol versions the notes below name on the way (`protected-execution-v2`,
`config-generations-v3`, protocol 1.9 and 1.10) were never released. They are steps
inside this one upgrade, not versions any release shipped. A 0.6.0 desktop app or
daemon cannot talk to a 2.0 daemon or app, so upgrade both together. This release's managed
updater refuses activation and recovery across the epoch change; direct CLI or daemon
startup does not enforce it. Upgrading an installed 0.6.0 across this epoch, by the 0.6.0
updater or manually, has not been verified on installed builds. Opening an existing store
with this release writes to it, even for read-only commands. Before the upgrade, keep a complete, consistent backup of the store,
protected material and keys with the 0.6.0 binary. Rolling back means restoring that
backup; reinstalling 0.6.0 over an upgraded store is not supported.
