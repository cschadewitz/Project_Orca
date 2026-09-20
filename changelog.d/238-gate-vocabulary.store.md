Two event payloads grew, both additively, and neither old shape stops reading, so **an
existing `.orca` store needs no migration** — point this release at one and it replays as it
did, including runs parked at a gate.

`human.answered` gains `note`: the free text a person writes beside their answer. It was
accepted by `inputs.answer` and by `orca answer` before, and it went to the *operator's* log,
because the event had nowhere to put it — reasoning that a person believed they had attached
to a decision, living instead in whichever terminal the daemon was logging to. It is now
recorded with the answer. The run still branches on the answer alone. The field is absent on
every answer written before this release and on every answer given without a note, and it
must stay absent rather than render as empty.

`human.requested` gains `agent`: `{ id, hostId }`, the agent whose turn a permission ask is
holding open (#248). It is recorded rather than looked up because the `input.opened`
notification is a pure function of this one event, and a push that had to scan a log to say
who is waiting would turn every append into a projection. Only what the moment of asking
knows is stored; a host's *transport* is configuration, so it is resolved from the registry on
a read and never frozen here. A workflow gate has no agent and writes no field, and a
permission ask recorded before this release has none either — `inputs.list` answers for those
logs from the `agent.session.opened` scan it already did.

Not a store change, but in the same area and worth reading together: a workflow's gate and
decision options may now be records rather than words (#247). That is the *authoring* shape
in `orca.config.yaml`'s workflows; what the log holds has been
`{ id, label, consequence?, destructive? }` since v0.4.0's wave zero, and a bare word still
reads as an option that is its own id and label.
