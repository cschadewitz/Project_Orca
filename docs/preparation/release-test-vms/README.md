# Disposable Proxmox release-test VMs

Prepared for Casey on 30 October 2026 against `main`
`85b7ceb99aa63a4f17fc2b50cc3546410321fe68`. **Plan only: no VM has been provisioned,
capacity measured, candidate selected or installed acceptance recorded.**

Start with two reusable desktop VMs: Windows 11 x64 for the NSIS installer and Ubuntu
24.04 Desktop x64 for the tar.gz. Use fresh workspaces for the first private round.
Keep Windows 10 x64 as best-effort compatibility, unverified until separately exercised;
it does not need a third mandatory VM. This is a proposed test matrix, not a change to
the release owner's offered-platform decision or the coordinator gates.

## 1. What Casey needs to do

1. Check current Proxmox capacity and choose the node, storage, existing test network,
   VM IDs and legal Windows installation/license route.
2. Create the two VMs, finish OS setup and updates, install Git, and create a normal
   non-admin test account. Keep setup administration separate from testing ORCA.
3. Shut down each guest and save a clean OS snapshot with no ORCA installation, app
   profile or workspace. Confirm that this snapshot can actually be restored.
4. Hand the coordinator the VM/OS inventory and console access using existing access
   arrangements. The coordinator fills the candidate card and runs the linked tests.

There is no need for a development checkout, Node, pnpm, provider CLI, paid agent or
build toolchain in these first-round VMs. The packaged app carries its Electron runtime
and bundled daemon. Advanced synthetic store fixtures may need a separate, explicitly
recorded fixture toolchain later; do not substitute a source-built app for the package.

This document prepares future actions; it does not authorize executing them now.
It changes no VM, network, credentials, security setting, feed, release or deployment.

## 2. Existing procedures to reuse

| Existing document | Use it for |
| --- | --- |
| [Coordinator checklist](../private-candidate-windows-linux/coordinator-checklist.md) | Candidate fill-ins, G1–G9, Windows trust decision, tester participation, support and retention |
| [Windows](../private-candidate-windows-linux/windows.md) / [Linux](../private-candidate-windows-linux/linux.md) | Exact download, hash, install/extract and launch P-steps |
| [First-success sample](../private-candidate-windows-linux/first-success-sample.md) | F1–F10: throwaway Git project, agent-free run, reopen |
| [Stop and troubleshoot](../private-candidate-windows-linux/when-something-goes-wrong.md) | Shutdown, process checks and sanitized reports |
| [Candidate evidence ledger](../../reviews/2026-10-27-release-readiness.md#candidate-evidence-ledger-unbound-preparation) | Separate artifact/static/install/launch/onboarding/update/restore receipts |
| [Store rehearsal](../store-compatibility-rehearsal/README.md) | Complete backup, known v0.6.0 boundaries, installed IL/IW rows and unresolved migration decisions |
| [Updating](../../UPDATING.md) / [releasing](../../RELEASING.md) | Update contracts and release mechanics, subject to current coordinator warning rules |

The #772/#779 artifact plan supplies L/W/U step IDs used by the coordinator. Its
preparation is not installed proof. Use the reviewed artifact plan revision named by
the candidate owner; do not infer a pass from a draft or from this runbook.

## 3. Prerequisites and proposed VM settings

Before provisioning, Casey records the Proxmox version, selected node, current CPU/load,
available RAM, active workloads, storage health/free capacity, snapshot support and
backup destination. **No live capacity has been checked here.** Check again before
starting a new test load, particularly alongside homelab CI.

Prefer the existing Proxmox UI: node **Summary**, **Disks/storage**, and running guests.
Optional read-only observations below run on the **selected Proxmox node**, as Casey's
existing administrator account with its normal host privileges. They do not run inside
the guest. If access is unavailable, stop and use the UI; do not add privileges or access.

```sh
# HOST: selected Proxmox node; USER: existing authorized host administrator
pveversion
uptime
free -h
pvesm status
qm list
```

One sample is not a capacity guarantee. Review headroom over a normal busy period;
avoid displacing active workloads. Run one test VM at a time if concurrent headroom is
uncertain. Two running 8 GiB guests request 16 GiB before host and other workloads;
snapshot growth, OS updates, artifacts and independent backups need additional storage.
Thin provisioning does not reserve that growth. If the selected pool cannot support
the snapshots below, choose suitable existing storage or plan a verified full VM
backup/restore baseline before testing. Do not change storage configuration for this plan.

| Setting | Windows test VM | Linux test VM |
| --- | --- | --- |
| Suggested name | `orca-test-win11-x64` | `orca-test-ubuntu2404-x64` |
| Guest | Windows 11 x64; record edition, release and full build | Ubuntu 24.04 Desktop x64; record point release, kernel and desktop session |
| Initial CPU/RAM | 4 vCPU, 8 GiB | 4 vCPU, 8 GiB |
| Initial disk budget | 100 GiB virtual disk | 64 GiB virtual disk |
| Firmware/device starting point | q35, OVMF/UEFI, EFI disk with current pre-enrolled keys, TPM 2.0 state | Existing supported Ubuntu desktop VM defaults; record firmware/devices |
| Storage/network devices | VirtIO SCSI/network if the matching Windows drivers are available during setup | VirtIO SCSI/network with normal guest drivers |
| Desktop | Proxmox console; usable at 1280×800 or larger | Proxmox console and full graphical desktop; usable at 1280×800 or larger |
| Test account | Dedicated standard account, local fixed NTFS profile; no synced home | Dedicated ordinary account, local home; never run ORCA as root |

CPU, RAM, disk and display figures are **unmeasured starting points**, not ORCA minimum
requirements or performance promises. Casey chooses a CPU model compatible with the
selected host and any intended migration; no GPU passthrough is needed for the initial
functional smoke. VM graphics results do not establish physical-GPU compatibility.

Use official OS media and checksums where supplied. For Windows, use a legitimate
installation/license route and current signed VirtIO drivers if needed. Meet Windows 11's
requirements instead of bypassing its installer checks. Proxmox's documentation covers
[UEFI, EFI state, TPM and guest devices](https://github.com/proxmox/pve-docs/blob/master/qm.adoc);
Microsoft lists [Windows 11 requirements](https://www.microsoft.com/en-us/windows/windows-11-specifications).
Verify settings against the installed Proxmox version, including current EFI keys.

Use an already approved test network and ordinary outbound access for OS updates and
the authorized private download. Do not add inbound services, production mounts, shared
home directories, personal projects, cloud sync, provider credentials or a production
daemon connection. No firewall, Defender, SmartScreen, UAC, AppArmor, SELinux, sandbox
or authentication relaxation is part of the setup. Use existing access; do not grant
collaborators or change repository visibility to fetch a package.

Install Git 2.28 or newer as a setup prerequisite, then reboot and finish outstanding
OS updates. After setup, run all ORCA steps as the test account without elevation.
Capture OS build, Git version, guest resources, firmware, storage, network and browser
versions in the inventory. If a guest agent is installed during normal setup, record
its version; it is optional for the powered-off snapshot procedure.

For each VM, Casey uses **Create VM** in the Proxmox UI: select the verified node and
unused VM ID/name; choose the OS ISO; apply the firmware/device choices above; select
the checked storage/disk size, CPU/RAM and existing test bridge; review the summary
before creating. For Windows, attach the signed VirtIO driver ISO if using those devices
and load the matching storage driver if the OS installer cannot see the disk. Finish
the normal OS installer without requirement bypasses, install any required guest drivers,
then set up the standard test account. Administrative OS setup uses Casey's authorized
setup account; the standard account never receives administrator rights to fix an ORCA
failure. Eject installation media after setup and verify desktop login and networking
before taking the clean snapshot.

## 4. Baselines, snapshots and independent backups

A snapshot is a fast reset on the same VM storage. It does not prove that a separately
saved workspace can be restored, and it does not protect against loss of that storage.
Use powered-off snapshots without RAM state, after a clean guest shutdown. Include all
VM disks and firmware/TPM state where applicable; do not assume an excluded or external
disk is covered. Check the actual storage's
[snapshot support and free space](https://github.com/proxmox/pve-docs/blob/master/pvesm.adoc).

Casey uses the selected VM's **Snapshots → Take Snapshot** in the UI, checks completion,
and records its VM ID, name and description. Suggested names:

| Baseline | Contents | Use |
| --- | --- | --- |
| `clean-os-YYYYMMDD` | Patched OS, drivers, Git, normal test account; no ORCA/profile/workspace | Restore before each clean candidate test |
| `n-populated-YYYYMMDD` | Installed known version N, synthetic project/workspace and profile; all writers stopped | Repeat an N-to-N+1 test on this same account |
| `pre-update-CASEID` | Exact stopped N state immediately before the case | Reset failed/interrupted test cases; retain separate backup below |

Before relying on `clean-os`, make a disposable marker file in the test account, shut
down and restore the snapshot, then verify that the marker is absent and the desktop
still boots. Record the outcome. A restore overwrites later VM state: export necessary
evidence first and confirm the VM ID and snapshot label each time. Do not restore a
baseline while a test or evidence export is running. Keep the original clean baseline
when refreshing OS patches; a changed OS baseline gets a new label and inventory.

For future upgrade/restore tests, also make an **independent backup outside the test
VM and its snapshot chain**, using an already authorized private backup destination.
Save the complete stopped synthetic project/workspace, config, stores, permission
sidecars, artifacts, journals, private/protected payloads and keys, adjacent authentication
state, and app `userData`. Record actual paths; do not guess a profile directory from
the app name. The inventory in the
[store rehearsal procedure](../store-compatibility-rehearsal/README.md#4-procedure-backup-matched-retention-explicit-migration-offline-restore)
is the source for completeness. Include both stores and associated state if that fixture
uses more than one; never just copy public run logs.

Stop every writer before copying, including the owned daemon and any CLI/agent session;
verify shutdown by the existing process checks. Manifest live roots, copy with permissions
preserved, manifest the backup, and re-manifest the live roots. Require equality of
paths, file kinds, sizes, hashes and relevant permissions, with no unexplained changes.
On Windows also preserve/check NTFS ownership and ACLs and the originating account/profile:
the portable `snapshot.js` helper does not certify Windows ACL or DPAPI recovery. Encrypted
profile state may be bound to that account. Exercise restore in the same guest/account
first; do not claim that a loose profile copy is portable to a fresh Windows account.

Retain N's exact installer/archive, matching daemon/runtime or external Node/toolchain
where applicable, candidate N+1 artifacts, manifests, version/commit/build-run identities
and backup hashes together. Keep app binaries separate from workspace state in the inventory.
Test independent restore **before the first N+1 open**. Snapshot rollback alone cannot
satisfy this restore check. Raw profile/store backups can contain secrets even in a
synthetic fixture; keep them private, outside Git and tester reports, under the agreed
retention policy. This task provisions no backup destination or credential.

## 5. First private round: clean installation and onboarding

The coordinator runs this once per offered OS/artifact combination on the exact selected
candidate. Repeat affected stages for any rebuilt artifact; a matching source SHA alone
does not make different build bytes interchangeable.

1. Restore `clean-os`, boot and record the guest inventory. Confirm no ORCA install,
   prior profile/workspace, saved endpoint or ORCA environment override. Resolve a dirty
   baseline by resetting this disposable VM, not by guessing which user files to delete.
2. Bind the candidate to version, full source SHA, workflow/run/attempt, exact file
   names/sizes and independent checksums. Require coordinator G1/G2 and reviewed static
   inspection before launch. Archive/PAX inspection is a package check; it does not prove
   workspace upgrade safety or VM launch.
3. Follow the existing Windows P1–P9 or Linux P1–P6. Record installation/extraction,
   actual layout, version, first screen and any security prompt separately from launch.
4. Perform F1–F10 unchanged using the agent-free `orca-beta-local-check` fixture and
   fresh throwaway folders. Record onboarding, a completed run, its visible results,
   and successful close/reopen with the prior run still available. Confirm the app uses
   only the selected synthetic workspace and bundled daemon.
5. Close ORCA and verify shutdown within the documented approximately 10-second window,
   with no owned daemon left behind. Record resource observations and UI responsiveness;
   these are observations, not a load benchmark.
6. Windows: uninstall through Settings, recording elevation prompts and leftovers.
   Linux: record the extracted app location; there is no NSIS-like uninstall. Export
   sanitized evidence before resetting the VM. Do not claim uninstall removes workspace
   or profile data; restoring `clean-os` supplies the next clean test.

**Windows warning gate:** the tester path stops at browser/SmartScreen/antivirus warnings.
Record that result; it is blocked launch, not installed acceptance. Downstream coordinator
checks may proceed only inside the disposable G3 VM under the owner's separately recorded
W1 bootstrap trust decision. This runbook supplies no such decision and no bypass steps.
Do not disable protection, strip download markings, pre-unblock files or select a download
route to avoid warnings. Preserve G5/G6 and tester stop rules even if coordinator testing
eventually runs under W1. A signature later does not guarantee absence of reputation warnings.

**Linux launch gate:** if Ubuntu refuses the Electron sandbox, stop and preserve the
failure. Do not use `--no-sandbox`, root, chmod/chown on `chrome-sandbox`, or a host/guest
security-policy change. Record Ubuntu 24.04 launch as blocked and return to the package
owner. A successful extraction alone is not a launch pass.

Fresh-workspace testing is sufficient for this round's onboarding scope only if release
notes and distribution keep existing-install updates out of scope. It does not clear C3
or make an upgrade feed safe to serve. Feed disposition remains the release owner's
explicit decision.

## 6. Future releases: app update, workspace compatibility and restore

Here **N** is the exact installed starting version and **N+1** the exact proposed next
version; the labels do not assume a patch-only or compatible store change. Capture each
version's compatibility manifest and update driver behavior. Run clean installation
again as well as these populated-state cases before claiming update support.

| Case | Procedure | Required evidence / outcome |
| --- | --- | --- |
| VM-U0: prepare N | Install the retained N package in the clean guest. Populate a synthetic workspace through that version's supported UI/scripted fixture. Inventory run IDs/statuses, visible artifacts, configuration, project Git state and profile paths. Stop, take snapshots and independent backup, and prove restore. | N actually produced the state; record exact fixture steps. Backup/restore equality and N reopening its restored state pass before N+1 opens anything. |
| VM-U1: Windows N→N+1 | Only with an independently authorized disposable HTTPS feed/token setup: check, download, exit without installing, relaunch and verify N is still installed. Then check again, download again and wait for ready before explicitly restarting to install. Follow UPDATING.md and #772 U-runs. | Download alone and ordinary exit do not install. Relaunch does not retain the app's ready state; the new check/download cycle must complete even if cached bytes can be reused. Explicit restart then replaces the package; N+1 launches its matching daemon and reopens the existing synthetic workspace. Record actual driver, version/protocol and old-run/artifact comparisons. A manual NSIS replacement is a separate case and does not prove in-app updating. |
| VM-U2: Linux N→N+1 | No desktop updater exists. Stop N, extract verified N+1 into a separate app directory, and open the same backed-up synthetic workspace/profile using the approved selection path. Retain N unchanged. | N+1's package/daemon identity, old runs and artifacts, expected state changes, new harmless sample, reopen and shutdown all recorded; no shared-file overwrite used as a rollback mechanism. |
| VM-U3: blocked/interrupted Windows update | Separate reset per case: offline/401, corrupt download, signature/trust rejection when signing is enabled, unsaved drafts, active owned run, and installer failure/timeout. Use reviewed fixtures; no live credential or protection changes. | Compare each result with the driver in N. Expected refusals preserve state. For a #660-capable N, ambiguous installer outcome keeps admission closed and does not reconnect/start another writer. Preserve journals and evidence when outcome is unknown. |
| VM-U4: independent offline restore | Stop N+1 and all writers. Keep upgraded state aside. Restore the complete pre-upgrade backup to original paths with permissions/account context; compare before launching N. Reinstall/use the retained matching N package and verify its saved state. | Full manifest/ACL equality before old startup; N opens the restored runs/artifacts under the same account. Record whether Windows permits package replacement; if blocked, report blocked and use a reviewed clean-baseline restore route rather than forcing it. List post-backup writes separately. |
| VM-U5: incomplete/mixed backup controls | On sacrificial backup copies only, omit one synthetic file or mix one upgraded file. Compare offline; never launch either binary on those copies. | Verification detects both incomplete and mixed state. Reuse the rehearsal's synthetic controls for portable hashes; add native permission/profile verification for the actual guest. |

For VM-U1, [the app state machine](../../../packages/app/src/main/updates.ts) initializes
`downloaded = false` for each new process and refuses restart until a download completes.
[The Windows driver](../../../packages/app/src/main/update-driver.ts) disables automatic
download and installation on ordinary quit. Retained installer bytes alone do not restore
the app's ready state. Record the exit/relaunch observation and the subsequent
check/download/restart cycle separately; do not restart directly after relaunch.

A read-only open can write initialization/authentication state. **Backup precedes every
first N+1 open**, including browsing an old store. Only one writer may own a fixture;
never boot a populated clone and its original as concurrent writers to shared state.
Retain the stopped N baseline for repeat cases and keep the independent backup immutable.
Restoring only a run archive, changing binaries, or reverting a version label does not
restore a workspace. Never start N on N+1-modified state. Reconcile writes since the
backup separately rather than mixing files back into the restored store.

The v0.6.0→current boundary has specific known risks: store epochs differ; desktop/direct
opens do not enforce that boundary; the managed Debian updater refuses crossing it; and
v0.6.0's Windows update driver predates #660. Do not treat its reconnect-after-timeout as
the new contract. Use the store rehearsal's IW1–IW3/IL3 evidence requirements for desktop
cases and keep installed acceptance unverified until run. Managed Debian IL1/IL2 is a
separate deployment test and still needs the owner's cross-epoch procedure decision.
Do not copy its live-host commands into these desktop VMs.

The Windows updater ignores prerelease versions containing `-`. If no suitable version
pair or authorized test feed exists, VM-U1/VM-U3 are **blocked**, not passed by a manual install.
This plan does not publish tags, alter versions, set up a feed or provision a token.

## 7. Evidence and pass/fail recording

Keep one receipt per OS/build/artifact and test case, linked to the candidate ledger.
Use its existing identity fields and stage vocabulary; do not check G1–G9 from this plan.
At minimum, record:

- Case ID, date, observer, VM ID, baseline/snapshot, OS build/architecture, test account
  type, guest CPU/RAM/disk, relevant browser/driver versions and current host-capacity check.
- Candidate and N identities: source SHA, workflow URL/run/attempt, version, file names,
  sizes and hashes; static report and native signature/trust observation.
- Steps actually performed, expected and actual result per stage, elapsed time,
  sanitized text evidence and explicit not-run cases. For command steps, record host,
  account role and exit code. Use verified version/protocol observations; do not expose
  raw hello credentials, token files or complete paths.
- For upgrade cases: synthetic fixture inventory, complete backup roots, private manifest
  references, permission/account verification, changed-state comparison, restore equality
  before N starts, and post-backup work requiring reconciliation.

Use **passed**, **failed**, **blocked**, **unknown** and **not run** accurately per stage.
An expected safety refusal passes that refusal check while the downstream install/launch
remains blocked. Unexpected mutation, lost history/artifacts, inability to restore, extra
writer, authentication bypass or unresolved security warning prevents a stage pass. Stop
dependent steps and preserve the failed case; use a known clean reset for independent cases.

Coordinator-only synthetic evidence is different from a tester report. Keep raw logs,
screenshots, backups and profiles private under the agreed retention policy; commit only
reviewed, sanitized receipts. External testers continue to use the existing text-only
[feedback template](../private-candidate-windows-linux/feedback-template.md), with diagnostics
off and no exports. No report is sent by this preparation.

## 8. Effort, cadence and deferrals

These are planning estimates, not measured timings; slow downloads, Windows setup,
activation, guest drivers or a package defect can exceed them. A blocker ends the test
case rather than consuming the remaining checklist as if it passed.

| Work | Hands-on estimate | Elapsed / limits |
| --- | --- | --- |
| Casey: two base VMs, existing healthy Proxmox and available media | 1–2 hours | Roughly 2–4+ hours with OS installs/updates; allow a half-day for unfamiliar setup or driver/license trouble |
| Coordinator: first clean candidate | 45–90 minutes per OS | Longer for a defect, warning decision or guide correction; includes recording evidence |
| Later clean candidate using baselines | 20–40 minutes per OS | Estimate assumes unchanged procedure and no failures |
| Add one populated N→N+1 and independent restore cycle | 1–2 additional hours per OS | After fixtures, backup and approved update route exist; first native ACL/profile restore may take longer |
| Build the first repeatable populated fixture/backup procedure | Half a day to a day across both OSes | Engineering estimate; covers path/permission inventory and restore rehearsal, not feed/signing provisioning |
| Optional Windows 10 observation | 20–40 minutes for a smoke on an already prepared environment | VM setup extra; Casey's desktop result is compatibility evidence only, with fresh synthetic folders |

For the first private round, prioritize the two clean guests, warning observations,
onboarding/reopen/shutdown and accurate evidence. Repeat this on release candidates,
not every PR. CI unit/source checks remain separate and do not replace native package
acceptance. Once releases update existing installs, add populated update/restore tests
for each offered update route; rerun affected cases after packaging, runtime, store,
security or updater changes. Inventory OS patch changes and refresh baselines deliberately.

Defer extra distributions, AppImage/FUSE, Windows ZIP, arm64, physical-GPU/performance
qualification, real-agent/provider testing, managed Debian migration, unattended VM
automation and a full failure-injection harness until those paths are offered or needed.
Defer Windows 10's dedicated VM while describing it as best effort/unverified. Do not
defer complete backups, independent restore proof or relevant failure cases while claiming
existing-install update support. Other installed scope can remain explicitly unverified
only through the release owner's documented distribution/notes decision.

## Validation boundary

This is repository documentation only. Relative links/fragments, UTF-8/LF/fences, source
claims and command names were checked; no host command above was executed on Proxmox.
No OS install, Electron launch, packaged acceptance, capacity measurement, upgrade,
backup or restore was performed for this plan. Official Proxmox documentation was read
through its source repository because the rendered documentation endpoints were
unavailable during preparation. Recheck version-specific settings on the actual host.

The standalone documentation check passed for both changed documents (25 local links
and fragments). The existing onboarding test file was also attempted with only its
page-format/link cases selected, but the suite failed to load because this checkout
could not resolve `yaml` imported by first-run setup; no test cases ran. Dependencies
were not installed or changed for this prose-only task. Runtime/build suites and
platform workflows were not run.
