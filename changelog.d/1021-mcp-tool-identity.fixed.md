- **agents:** Permission rules now match a Gemini CLI MCP call by its `server: tool`
  identity, read from the call's `_meta`, instead of Gemini's `tool(args)` title. An
  operator deny or ask rule for an MCP tool now applies to Gemini, and an allow rule or
  "always" grant for one server no longer allows the same tool name on another server.
  Deny and ask rules also still match the raw title. A call with malformed MCP metadata
  is never allowed by a title rule and cannot be granted "always".
