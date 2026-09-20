Two event payloads grew, and both old shapes still read, so **an existing `.orca` store needs
no migration** — point this release at one and it replays as it did, including runs parked at a
gate.

`agent.update` now carries the tool call's arguments and its result alongside the title and
status it already had. Each is capped at 2,000 characters when the event is written, and stored
with the length it had before the cap, so a reader can say "this was 48,000 characters, you are
seeing 2,000" rather than guess: a tool call that reads a large file does not put the file in the
log. Both fields are optional, and every `agent.update` written before this release simply has
neither — a tool call row from an older run shows its title and offers nothing to expand.

`human.requested.options` was a list of strings and is now a list of records —
`{ id, label, consequence?, destructive? }`. `id` is what an answer carries, so a label can be
reworded without invalidating a `human.answered` already in a log. A bare string in an older log
reads as `{ id: s, label: s }`, which is exactly what it meant: the words were both the identity
and the label, and the answer recorded against them still matches. Gates written from here on
store records, so the two shapes coexist in one log without either being rewritten. Nothing in
this release produces a `consequence` or a `destructive` option yet; the fields exist so the
attention surface can carry them without a second store change.

Both changes are in the same discriminated union and landed together, deliberately: this is the
only store-format change in v0.4.0, and the cost of one grows with every real event log.
