# Independent maintenance MCP

The inactive first increment for [#483](https://github.com/cschadewitz/Project_Orca/issues/483)
lives in [`packages/maintenance-mcp`](../packages/maintenance-mcp/README.md). Its README
defines the four closed read-only tools, fixed proposed aliases, structured log policy,
resource bounds, threat model, stdio deployment contract and remaining acceptance gates.

It has no ORCA runtime/store dependency and does not reuse the ORCA operator MCP backend
or guarded launcher. The shipped production adapter refuses all observation sources;
only injected synthetic fixtures produce health/log observations. Foreground ORCA is
reported as `not_supervised`, with no PID inference. No service, tunnel, credentials,
permissions or live-host access are installed or configured by this increment.

This is separate from [ORCA operator MCP](mcp-operator.md). Production observation,
independent supervision, official tunnel-client0.0.15 integration and actual-client
activation/revocation acceptance remain future work. Source review must not close #483.
