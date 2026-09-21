- **app:** the Config surface. `orca.config.yaml` as a form over the schema the daemon
  describes — a field per key with its dotted path shown, a `Menu` for an enum, a card per
  element of `agents:`, and whatever the schema cannot describe as read-only JSON — beside
  the raw file, editable, with **raw** on any field jumping to the line that key is written
  on. The save bar counts what would be written rather than what was typed, validates
  without writing, places the daemon's errors on the fields they name, and refuses to lose a
  draft when somebody else edited the file: `CONFIG_STALE` shows the conflict and offers
  **Reload**. `⌘S` saves, and the command palette lists it.
- **app:** Config shows the ADR 0009 permission sidecar as its second document (#266): each
  agent's effective policy in the order ORCA evaluates it, every rule chipped `config` or
  `sidecar`, the machine-written ones carrying when they were added and which tool call was
  answered "always", and the fallthrough named as the config's. It is readable here;
  editing grants is still to come.
- **app:** the app's own preferences — theme and per-surface density — are a section of
  Config, labelled as stored by the app rather than in `orca.config.yaml`, and save the
  moment they are chosen. There is still no settings screen.
- **app:** `orca://config` and `orca://config/permissions` open the surface on the document
  they name.
- **app:** the form and the save bar are absent, not disabled, in file mode and against a
  daemon whose `hello.methods` has no `config.set` — the method the button calls, which the
  connection snapshot now carries, rather than the `runs.control` capability above it.
  Disconnected and reconnecting keep the bar and the change count, with the reason on
  Validate and Save.
- **app:** a configuration draft survives going to another surface and coming back: the
  draft model is mounted above the surface switch, and the Agents surface's policy panel
  reads the same one rather than a second copy.
