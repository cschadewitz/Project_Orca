- **cli:** `orca auth revoke <id>` and `orca auth rotate <id>` no longer fail with "Unknown option"
  when the credential id starts with a dash. New credential ids never start with one, and an id
  issued earlier that does is accepted as typed. In the rare case that such an id is exactly the
  name of an `orca` option (for example `--expires-at`), put `--` before it:
  `orca auth revoke -- <id>`.
