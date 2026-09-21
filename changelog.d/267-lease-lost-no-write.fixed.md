- **engine:** an interpreter whose run lease is taken away stops without writing to the log
  it no longer owns. It used to abort the run and then append `step.cancelled` and
  `run.cancelled` through the same context — into the log the operator had just handed to
  another interpreter, which cancelled the run the takeover was meant to continue. A lost
  lease is now told apart from a cancel we own: the interpreter logs why, closes its agent
  sessions, writes nothing, and raises `RUN_LEASED` to whoever called `run()`. The run is
  left exactly as its last write found it, for the new holder to re-attempt.
- **engine:** attaching to a run takes the lease *before* it reduces the run's log, so an
  attach refused with `RUN_LEASED` leaves no half-read state behind for the next one to
  reuse. A finished run is still read without a lease and still never leaves one on file.
- **engine:** a lease lost in the moment between being taken and the run's log being loaded
  refuses the run rather than driving it. That window was the one the heartbeat could not act
  on — it fired, found no interpreter to stop, and returned — and the attach then went on to
  execute, and write, holding no lease. It now raises `RUN_LEASED` as soon as there is a
  context to stop, having written nothing.
