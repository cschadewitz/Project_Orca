# Independent maintenance MCP

The inactive preparation for [#483](https://github.com/cschadewitz/Project_Orca/issues/483)
lives in [`packages/maintenance-mcp`](../packages/maintenance-mcp/README.md). Its README
defines the four closed read-only tools, fixed proposed aliases, structured log policy,
resource bounds, threat model, stdio deployment contract and remaining acceptance gates.

It has no ORCA runtime/store dependency and does not reuse the ORCA operator MCP backend
or guarded launcher. The default stdio entry still refuses all observation sources.
An explicit Linux observer entry adds fixed kernel health reads and bounded same-user
unit/structured-journal source readers. Service identities remain null, so those reads
still refuse in the shipped policy. Foreground ORCA is
reported as `not_supervised`, with no PID inference. No service, tunnel, credentials,
permissions or live-host access are installed or configured by this increment.

The [observer runbook](maintenance-observer-runbook.md) covers the inactive independent
launcher/tunnel templates, source/identity pins, focused synthetic evidence and separate
activation, revocation and outage prerequisites. This is separate from
[ORCA operator MCP](mcp-operator.md). Reviewed source bindings, independent supervision,
official tunnel-client0.0.15 integration and actual-client
activation/revocation acceptance remain future work. Source review must not close #483.
