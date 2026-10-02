- **engine/daemon:** Add durable Request admission with protected inputs, stable recovery
  IDs and ownership before execution. Daemon and configured CLI/ACP submissions use the
  integrated generation provider. Admission list/inspect/reconcile are token-mode daemon
  RPC methods; no CLI/ACP recovery command or app action is supplied.
