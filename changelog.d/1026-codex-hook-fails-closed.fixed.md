- **agents:** With the experimental Codex tool hook on the pinned Codex (0.171.0 through its
  ACP adapter 2.9.0, on Linux), a failure of ORCA's own hook program no longer lets the call
  run. A crash, a kill, a hang past 25 seconds, a missing runtime, or an answer that is not
  exactly ORCA's allow or block now blocks the call. The hook still runs under Codex's own
  hook runner, which lets a call through if that runner fails. A session opens only after ORCA
  has checked that this protection blocks on that install. Codex's support tier is unchanged.
