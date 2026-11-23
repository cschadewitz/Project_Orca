- **agents:** experimental, off-by-default switches under `review.plainRules.experimental.kinds` let
  the plain-language rule judge also answer file writes ORCA makes itself (`edits`) and tool calls to
  MCP servers ORCA relays (`mcpCalls`), each as a one-time allow, and give advice on command asks
  (`commands`) while the person is still asked. Deny and ask rules still win, nothing is saved as a
  standing grant, and each kind needs its own owner grant (`orca auth issue --judge-disclosure
  --judge-disclosure-kind <edits|mcp-calls|commands>`). The judge is still not switched on.
