- **engine:** an artifact that is in the index but whose body cannot be read no longer renders as
  an empty string. The read raises `ARTIFACT_MISSING` naming the artifact, its version and its
  content hash, so the step fails and the retry policy or a person decides, and the failed read is
  not cached — the next render tries again once the store is whole.
