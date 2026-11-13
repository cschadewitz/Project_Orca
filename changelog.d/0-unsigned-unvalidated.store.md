**Desktop builds are unvalidated, and the files attached to this prerelease are
unsigned.** No Windows, Linux or macOS file attached here is code-signed or notarised, and
none has installed-artifact acceptance. Windows testers receive a separately distributed
installer signed by **Casey Schadewitz** instead; don't use the attached Windows files. If
SmartScreen warns about that signed installer, choose **More info**, and choose **Run
anyway** only when the publisher reads exactly Casey Schadewitz, its SHA-256 matches the
one you were given, and its signature check showed `Valid` for that signer. Stop at any other SmartScreen screen, at any browser, antivirus or macOS Gatekeeper
warning, and at any unsigned file's warning, and report what it said. The macOS `.dmg` and
`.zip` use the new bundle ID `com.schadewitz.orca` (was `dev.orca.desktop`), so OS
permissions, notifications and Keychain access do not carry over; upgrading an existing
Mac install is not a validated path, and no Mac acceptance is claimed.
