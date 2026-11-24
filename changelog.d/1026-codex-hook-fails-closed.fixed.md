- **agents:** With the experimental Codex tool hook on, Codex let a call run when ORCA's hook
  program crashed, hung, was killed or answered with something other than ORCA's allow or
  block. ORCA now runs its program inside a fail-closed line: any of those blocks the call,
  and a program that does not answer within 25 seconds is stopped and the call blocked.
