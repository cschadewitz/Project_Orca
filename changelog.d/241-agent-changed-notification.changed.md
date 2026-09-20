- **protocol:** `agent.changed` is now one of the notification methods rather than a push
  beside them. It joins `NOTIFICATION_METHODS` and the `DaemonNotification` union, so
  `parseNotification` validates it and a client routes it off the one stream by name;
  `parseAgentChanged` is gone. It still carries no `runId` and no `seq`, because agent health
  lives in the daemon's memory and has nothing to resume from — a client that folds the
  cursor now tests for a `seq` rather than assuming one, which is the bug this fixes: the
  previous guard compared `runId`s, and on a store-wide subscription that comparison was
  already true. A daemon still sends it only to subscriptions that did not scope themselves
  to a run, and now honours `methods` for it like any other notification.
- **protocol:** `AgentView` gains `hostType` (`local` or `ssh`), taken from the host spec the
  agent's `hostId` names. It is absent when that host has left the config, rather than
  guessing the commoner transport.
- **protocol:** version 1.5. Both changes are additions — a method joins a list clients read
  by name, an optional field joins a view — so a 1.4 client keeps working and goes on dropping
  `agent.changed` as a method it has never heard of.
