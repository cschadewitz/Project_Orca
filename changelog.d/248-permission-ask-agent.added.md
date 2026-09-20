- **protocol/daemon:** `OpenInputView` and the `input.opened` notification carry `agent` —
  `{ id, hostId, hostType? }`, the same three fields and the same names as `AgentView`, so a
  client folds one vocabulary. A permission ask holds an agent's turn open and the card has
  to say whose; until now that was an `agents.list` away, and the attention surface's design
  forbids a card that needs a further call. It is optional because a workflow gate is nobody's
  agent: absence means no agent is blocked, never a field that failed to load. `hostType` is
  absent when the host has left the config, rather than guessing the commoner transport.
  Protocol version 1.6.
