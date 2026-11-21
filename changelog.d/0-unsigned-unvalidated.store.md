**Supported downloads.** Two installs are supported: the Windows 11 x64 installer,
code-signed by **Casey Schadewitz**, and the Ubuntu 24.04 Desktop amd64 `.deb`. A final
release attaches only those two. A release candidate's page instead carries the ordinary
build output, and its Windows installers are **unsigned**: don't install them. On a release
candidate, use the signed Windows installer only when it is separately attached or supplied
to you with its SHA-256, and verified as below. None of the other Windows, Linux or macOS
files on a candidate's page is signed, validated or supported. Before running a Windows
installer, check that its SHA-256 matches the one listed beside it on the release page (or
the one supplied with it) and that **Properties → Digital Signatures** shows a valid
signature from exactly Casey Schadewitz. If SmartScreen warns, choose **More info**, and
choose **Run anyway** only when the publisher reads exactly Casey Schadewitz and both checks
passed; stop at any other SmartScreen screen and at any browser or antivirus warning, and
report what it said. Windows arm64, Linux arm64, the Linux `.tar.gz` and AppImage, and macOS
are not supported in this release. The macOS builds use the new bundle ID
`com.schadewitz.orca` (was `dev.orca.desktop`), so OS permissions, notifications and
Keychain access do not carry over; upgrading an existing Mac install is not a validated
path, and no Mac acceptance is claimed.
