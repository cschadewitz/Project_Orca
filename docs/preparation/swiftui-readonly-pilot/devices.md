# Native prerequisites and device acceptance

All hardware and delivery results below are **not run / unknown**. Model names are
test candidates, not a claim that Casey or Cal owns them. Obtain the exact inventory
and permission to use an isolated test account before a native spike. This Linux
preparation environment cannot establish SwiftUI, signing or physical-device behavior.

## Build and installation prerequisites

| Stage | Exact prerequisite to record before running | What it can establish |
| --- | --- | --- |
| Offline contract checks | Python 3 + pinned `jsonschema` requirement; this repository at a recorded SHA | Portable schema/fixture consistency only |
| Native synthetic simulator spike | Consented Mac, preferably Apple Silicon; **candidate pin: stable Xcode 27, macOS Tahoe 26.6 or later supported by that Xcode**, iOS 27 SDK/runtime, plus a separately installed iOS 18 simulator runtime if available for that host. Full Xcode, not Command Line Tools alone; license/first-launch components completed by owner. Record `sw_vers`, architecture, `xcodebuild -version`, `xcodebuild -showsdks`, `xcrun simctl list runtimes` and exact runtime build. | Build/decoder/SwiftUI/accessibility automation. No signing account, APNs entitlement or network connection needed for bundled fixtures. Missing minimum runtime remains an acceptance gap. |
| Physical fixture app | Supported iPhone and exact iOS build, passcode and screen lock, reliable USB cable or deliberately configured pairing, trust relationship and Developer Mode for development-signed runs. Appropriate development signing team/certificate/profile and bundle ID; owner-controlled setup under separate authorization. Record install/build provenance without exporting keys or device serials. | Real layout, VoiceOver, Keychain/Data Protection, suspension and device performance; still no live ORCA connection. |
| Connected private spike | Accepted #472 facade at an exact SHA, isolated synthetic workspace/device enrollment, agreed host/VPN/TLS identity and independent revocation operator; separately authorized test access. | Read scope, TLS, reachability, revocation and authenticated recovery. Simulator reachability is not physical cellular/VPN evidence. |
| Mirrored Watch spike | Actual Watch model/case size, watchOS build, compatible paired phone/iOS, battery condition, notification settings and cellular provisioning status (if applicable). #475 provider/enrollment contract and separate permission for APNs sends. | Physical notification routing; no native Watch app or Watch approval claim. |
| TestFlight acceptance | Account holder, paid Developer Program membership status, app/bundle ownership, signing and Connect roles, privacy/review notes, export-compliance review and owner-approved upload. Exact signed build and daemon contract compatibility retained. | Distribution gate only after physical/security/accessibility/support evidence; never implied by simulator success. |

Apple's [Xcode requirements](https://developer.apple.com/xcode/system-requirements)
currently list Xcode 27 on macOS 26.6+, iOS 27 SDK, iOS deployment targets 15–27
and device/simulator support from iOS 17. The **proposed app floor is iOS 18**, not
the SDK's minimum. This pin is a preparation candidate, not an install instruction
or an assertion of available runtimes. Recheck the table and installed runtime
builds at execution; record any pin change in evidence before tests.

Development-signed device execution needs Apple's
[Developer Mode setup](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
Simulator builds do not establish that setup. TestFlight installation uses the
distribution path, not a requirement to enable Developer Mode. A development
profile is not TestFlight approval. Account roles and membership custody must be
confirmed independently: an individual account's additional Connect users do not
become Developer Program team members. See [Apple roles](https://developer.apple.com/help/account/access/roles/)
and [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

## Minimum/current OS and device matrix

| ID | Candidate target | Required observations |
| --- | --- | --- |
| D1 | iPhone SE (3rd generation), iOS 18.x minimum candidate; exact patch/build to pin from actual available device | Compact viewport, portrait/landscape, largest Dynamic Type, final content reachable, VoiceOver/keyboard navigation. Do not assume an upgraded phone can be downgraded. |
| D2 | Actual primary iPhone on current stable iOS 27.x candidate, exact model/patch/build pending inventory | All screens, protected storage, foreground/background/kill/relaunch, lock/unlock, revoke and cache expiry. Revalidate current stable release at execution. |
| D3 | Large-screen iPhone simulator on the selected current runtime; physical large phone if part of cohort | Layout, long IDs/text, rotation and large text; simulator result explicitly scoped to layout. |
| D4 | Actual inherited Watch + compatible paired iPhone; model/watchOS/pairing unknown | #475 mirroring under locks, Focus, independent power modes and phone absence. Unsupported Watch is a recorded limitation, not silently removed from milestone acceptance. |
| D5 | Same physical phone updated from previous pilot build, then clean install/reinstall/restore test | No automatic restored enrollment, no cross-account cache, protected cache cleanup and truthful disconnected state. Separate signing/device authorization required. |

If all actual phones require a newer floor, owners can select that explicitly;
do not claim iOS 18 support from compilation alone. Watch support follows verified
pairing and delivery behavior, not an invented watchOS floor. iPad, native macOS,
visionOS, Android and independent Watch operation are outside this matrix.

## Required cross-cases

Run screen/decoder cases on D1–D3. Run privacy/lifecycle/network cases on D1/D2
physical devices where available and notification cases on D4; keep missing cells
as `unknown`, never `pass`. Use controlled synthetic failures before live tests.

| Area | Cases to execute | Evidence to retain |
| --- | --- | --- |
| Accessibility | VoiceOver reading/focus/announcements; every Dynamic Type category; light/dark/increased contrast; Reduce Motion; Switch Control; Full Keyboard Access; compact and rotated phone | Sanitized screen recording/checklist, clipped/unreachable text and focus failures, exact settings/device/build. No streaming announcement spam. |
| Freshness/lifecycle | First load, empty/error, offline cold start, cached offline, cache expiry, background/lock/kill, wall-clock jump, reconnect, gap/duplicate/out-of-order hint, old response, changed boot/policy/identity | Ordered fixture IDs, accepted/dropped ticket/generation, last-observed label and convergence result. No secrets or raw payload logs. |
| Network | Wi-Fi → cellular and reverse; airplane mode; VPN absent/disconnected/conflicting; captive portal; host down; DNS/TLS expiry/rotation/wrong host; IPv6-only; local-network permission denied | Topology class, failure category, recovery latency and whether data stayed stale. No TLS bypass, global ATS exception or raw-RPC workaround. |
| Power and presence | iPhone Low Power Mode on/off × Watch Low Power Mode on/off × phone nearby/absent (eight combinations), with battery level/condition; on reachable Wi-Fi and cellular where actually supported | Each combination separately, Watch app closed/opened, actual path, missed/delayed alerts and successful/failed phone reads. Unsupported cellular cells stay unknown. |
| Notification routing (#475) | Phone locked/unlocked, Watch locked/unlocked, Focus on/off, permission allowed/denied, duplicate/delayed/expired hint, missing push, invalid route, wrong account, revoked registration | Provider acceptance, device display, tap and authenticated read are separate observations with times. A notification never records approval. |
| Privacy/security (#472/#473) | Canary summaries/artifacts/errors; malicious text; wrong run/artifact binding; direct mutation attempts; revoke during read; logout/account switch; passcode removal; backup/restore; app-switcher preview | Denial + no effect evidence, no sensitive data in cache/log/preview/backup, sanitized failure record. Offline revocation limits documented. |

Apple documents that Watch Low Power Mode can turn off Wi-Fi/cellular data with the
phone absent until a network-using app opens; measure instead of promising alerts
or VPN inheritance. [Watch away from phone](https://support.apple.com/en-us/108300).
LAN tests must account for [local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
Later credential storage must implement the reviewed
[passcode/device-only Keychain class](https://developer.apple.com/documentation/security/ksecattraccessiblewhenpasscodesetthisdeviceonly),
whose accessibility does not make locked/background recovery automatically work.

## Evidence record for each case

Record case/fixture ID; expected and observed result (`pass`, `fail`, `blocked`,
`unknown`); app source/build and artifact digest; daemon SHA/protocol/schema;
Mac architecture/macOS/Xcode/SDK/runtime builds; phone and Watch model/OS/pairing;
network class; both power modes; Focus/lock/permission state; timestamp/timezone;
sanitized screenshot/log reference; operator; defect link and retest result.
Retain failures alongside passes. Omit account emails, tokens, serials, enrollment
codes, private hostnames and personal notification content. No matrix cell is
accepted merely because another OS/device passed.
