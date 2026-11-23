- **agents, engine:** Each file read or write that ORCA performs for an agent is now recorded in
  the run before it starts (`agent.fs.authorized`), and its outcome after
  (`agent.fs.completed`: completed, failed, or not started because a last check refused it).
  If the authorization cannot be recorded, the operation does not start. If the daemon stops
  between the two, the operation is shown as execution-unknown rather than assumed done or
  repeated.
