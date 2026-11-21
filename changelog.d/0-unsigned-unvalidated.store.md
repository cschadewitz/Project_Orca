**Supported downloads.** Two installs are supported: the Windows 11 x64 installer,
code-signed by **Casey Schadewitz**, and the Ubuntu 24.04 Desktop amd64 `.deb`. A final
release attaches only those two. A release candidate's page also carries the ordinary,
unsigned build output (other Windows, Linux and macOS files); none of those is signed,
validated or supported, so use only the two named here. Before running the Windows
installer, check that its SHA-256 matches the one listed beside it on the release page and
that **Properties → Digital Signatures** shows a valid signature from exactly Casey
Schadewitz. If SmartScreen warns, choose **More info**, and choose **Run anyway** only when
the publisher reads exactly Casey Schadewitz and both checks passed; stop at any other
SmartScreen screen and at any browser or antivirus warning, and report what it said.
Windows arm64, Linux arm64, the Linux `.tar.gz` and AppImage, and macOS are not supported
in this release. The macOS builds use the new bundle ID `com.schadewitz.orca` (was
`dev.orca.desktop`), so OS permissions, notifications and Keychain access do not carry
over; upgrading an existing Mac install is not a validated path, and no Mac acceptance is
claimed.
