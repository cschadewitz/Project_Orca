- **app:** on Linux, where the app has no local diagnostics storage, Config no longer shows
  "Cleanup is pending… Retry cleanup" while diagnostics are off. Nothing can have been
  collected there, so nothing is waiting to be removed. A cleanup that really is pending now
  says whether it waits on an earlier export or on retained history and key material.
