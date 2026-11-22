- **app:** after an in-app update the desktop app carries its workspace's store forward to a new
  store format by itself, only while its daemon provably holds the store's exclusive writer fence
  and the updater handed it that exact store (#897).
- **cli:** `orca store carry-forward` refuses desktop-app-owned workspaces (`APP_OWNED`) and, on
  Windows, refuses before copying anything (`UNDURABLE`) until the backup can be proven to reach
  the disk before the format marker (#897, #910).
