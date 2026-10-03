- **app:** Adopt the approved macOS bundle ID `com.schadewitz.orca`, retaining the
  Windows packaging identity for existing NSIS upgrades. App names and data paths
  stay unchanged; signing remains disabled. Existing Mac permission and Keychain
  continuity requires native validation before distribution; no data migration is included.
