- **store:** every store open checks the store format marker and refuses a store from a newer
  ORCA or an older format, without changing it (#566).
- **cli:** `orca store format` shows a store's recorded format; `orca store carry-forward`
  converts an older-format store once, offline, after a verified backup and read check (#566).
