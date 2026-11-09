- **app:** Add a durable closed update window, verified fixed-path state/binary backups,
  and resumable same-boot restoration. Preserve failed-candidate evidence and refuse
  reopening until validation or full restoration succeeds. Native installation remains
  disabled pending complete owner wiring and real-Mac verification (#387, #571).
- **cli:** Fence participating writers before initialization and support authenticated,
  read-only replacement inspection without permission resets, credential rotation,
  first-run claim adoption or automatic continuation recovery.
