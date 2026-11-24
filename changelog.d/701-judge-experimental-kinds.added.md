- **agents:** experimental, off-by-default switches under `review.plainRules.experimental.kinds` let
  the plain-language rule judge also answer tool calls to MCP servers ORCA relays (`mcpCalls`), as a
  one-time allow for a rule naming that server and tool, and give advice on file writes ORCA makes
  itself (`edits`) and on command asks (`commands`) while the person is still asked. Deny and ask rules
  still win, nothing is saved as a standing grant, and each kind needs its own owner grant (`orca auth
  issue --judge-disclosure --judge-disclosure-kind <edits|mcp-calls|commands>`). The judge is still not
  switched on.
