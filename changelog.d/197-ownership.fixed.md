- **engine:** Fence execution writes, artifact recording and work-item projection
  under the same ownership guard as lease mutation. Expired heartbeats stop local
  execution even when renewals fail or hang; obsolete holders cannot replace a
  successor's lease or append after a forced takeover.
