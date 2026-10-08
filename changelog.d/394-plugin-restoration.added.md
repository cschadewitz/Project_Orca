- **engine/cli:** Plugins can opt in to versioned restoration of custom executors
  from bounded, validated non-secret inputs in a recorded generation. Recovery
  constructs an isolated registry after trusted installed-code/dependency identity
  verification, and refuses unverified, unavailable or incompatible plugins.
  Host/workspace/plan/input callbacks and mixed legacy compositions
  remain unsupported across engine-process restarts.
