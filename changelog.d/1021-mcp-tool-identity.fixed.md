- **agents:** A Gemini CLI permission ask for an MCP tool names its server and tool only in
  the call's `_meta`, which the agent writes and ORCA cannot verify. ORCA now treats that
  as a claim: operator deny and ask rules written as `server: tool` apply to it (as do
  rules on Gemini's own `tool(args)` title), but no allow rule, default or "always" grant
  decides such a call. It is asked each time unless a rule denies it, so a grant can no
  longer reach the same tool name on another server. An "always deny" for it is saved as
  `server: tool`. Grants recorded earlier from Gemini's MCP titles stop allowing.
