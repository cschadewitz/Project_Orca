**Supported downloads.** This release attaches two installs, and they are the only
supported ones: the Windows 11 x64 installer, code-signed by **Casey Schadewitz**, and the
Ubuntu 24.04 Desktop amd64 `.deb`. Before running the Windows installer, open its
**Properties → Digital Signatures** and check that the signer is exactly Casey Schadewitz.
If SmartScreen warns, choose **More info**, and choose **Run anyway** only when the
publisher it shows reads exactly Casey Schadewitz; stop at any other SmartScreen screen and
at any browser or antivirus warning. Windows arm64, Linux arm64, the Linux `.tar.gz` and
AppImage, and macOS builds are not attached and not supported in this release. The macOS
builds use the new bundle ID `com.schadewitz.orca` (was `dev.orca.desktop`), so OS
permissions, notifications and Keychain access do not carry over; upgrading an existing
Mac install is not a validated path, and no Mac acceptance is claimed.
