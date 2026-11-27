- **agents:** the experimental Codex app-server driver (still refused for sessions) now checks
  Codex's whole package before every start, not only its executable: the bundled sandbox
  (`bwrap`), the code-mode host and `rg` must each be a plain file with the SHA-256 ORCA pinned
  for that Codex version. Codex prefers a `bwrap` on its `PATH` to its own and checks only its
  own, so ORCA also refuses to start it when a `bwrap` on that `PATH` could be replaced by your
  own user, rather than being root's alone, and refuses an agent whose `PATH` comes from a secret
  (#1286).
