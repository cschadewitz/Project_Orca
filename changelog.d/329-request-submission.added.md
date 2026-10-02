- **engine/daemon:** Add durable Request admission with protected inputs, stable recovery
  IDs and ownership before execution. Daemon and configured CLI/ACP submissions use the
  integrated generation provider. Admission list/inspect/reconcile are available through token-mode daemon
  RPC and local CLI/ACP commands; local reconciliation returns a receipt without
  implicitly starting execution. No app recovery form is supplied.
