- **agents:** review judges can use your own API key through a secret reference. A secret
  gains an optional `destination`, which pins its value to the one judge endpoint ORCA sends
  it to: only such a pinned secret can be a judge's key, and a pinned secret can never be
  referenced by an agent or MCP server (the config check and session open both refuse it).
  The key is read on the daemon's own machine at each use, after the run owner's secret use
  check, and is never cached, logged or serialized. Judges are still not switched on.
