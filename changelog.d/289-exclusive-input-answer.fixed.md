- **engine:** Accept one answer to a parked human-input request under concurrent
  callers. Validation rereads the durable log under ownership, shared with resume
  and cancellation, so a later answer cannot replace the accepted choice.
