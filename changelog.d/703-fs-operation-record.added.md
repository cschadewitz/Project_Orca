- **agents, engine:** Each file read or write that ORCA performs for an agent is now recorded in
  the run before it starts (`agent.fs.authorized`), and its outcome after
  (`agent.fs.completed`). The authorization is synced to disk first; if the event store cannot
  do that, or the record cannot be written, the operation does not start. After the record,
  the permission policy is read again and must still allow the operation, so a deny saved
  meanwhile refuses it. The record names the file by a short path relative to the workspace,
  never the full or resolved path. A write that fails after it may have changed the file is
  recorded as effect-unknown, not as failed, and the agent is told it is not safe to retry as
  if nothing happened. If the daemon stops between the two records, the operation is shown as
  execution-unknown rather than assumed done or repeated.
