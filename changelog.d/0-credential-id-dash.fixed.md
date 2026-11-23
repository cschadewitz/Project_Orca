- **cli:** `orca auth revoke <id>` and `orca auth rotate <id>` no longer fail with "Unknown option"
  when the credential id starts with a dash. New credential ids never start with one, and ids
  issued earlier are accepted as typed.
