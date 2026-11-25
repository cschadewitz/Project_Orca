# Installing the desktop app on Linux

This page is for anyone installing the ORCA desktop app on Ubuntu or Debian. It shows how to
install, update and remove it, explains why the `.deb` is the only supported Linux path, and says
what CI checks.

## Install

The supported install is the **Debian package**, `ORCA-X.Y.Z-linux-amd64.deb` (or `-arm64.deb`),
installed with `apt`. It is the only Linux artifact that starts on a stock Ubuntu 24.04 or later
with Chromium's sandbox on and the system's protections unchanged (#853).

```sh
sudo apt install ./ORCA-X.Y.Z-linux-amd64.deb   # the ./ makes apt read the local file
orca-desktop                                    # or open ORCA from the app menu
```

To remove it: `sudo apt remove orca-desktop`. Your settings and workspaces stay where they are.

The package and its command are both `orca-desktop`.
<!-- rename-keep-start: these lines are about the GNOME screen reader, whose name really is orca -->
The GNOME screen reader on Ubuntu Desktop is a different program: package `orca`, command
`/usr/bin/orca`, installed by default. `sudo apt remove orca` removes the screen reader. The two
install side by side; this package declares no conflict with the screen reader and replaces none of
its files.
<!-- rename-keep-end -->

## Updating

The package does not update itself. About 15 seconds after start, and every six hours after that,
ORCA reads the project's public release list. When a newer stable release has a `.deb` for your
machine, the title bar shows **X.Y.Z available** with the release page and the command to run after
downloading (#888):

```sh
sudo apt install ./ORCA-X.Y.Z-linux-amd64.deb   # upgrades orca-desktop in place
```

- Nothing is downloaded or installed until you run that.
- A failed or offline check is silent and never delays startup.
- Release candidates are offered only with `ORCA_UPDATE_PRERELEASE=1`, as on Windows.
- `ORCA_UPDATE_CHECK=0` turns the check off.
- Only the installed package checks; the archive and AppImage do not.

**Restart to finish update (#905).** If ORCA is open while `apt` upgrades it, the title bar shows
**Restart to finish update to X.Y.Z**. It waits until no drafts are unsaved and no run is active,
stops ORCA's background service cleanly, hands your workspace's data to the new version, and starts
it. Use it instead of quitting and reopening, so the new version can carry your data forward if its
storage format changed ([how](UPDATING.md#automatic-carryover-after-a-desktop-update)).

If the restart cannot finish (another `apt` run changed the package, or the workspace could not be
handed over), it starts nothing and says so; the background service stays stopped. Quit and reopen
ORCA. If the workspace then refuses to open because its data is in an older format, reinstall the
version you were running and use the restart from there:

```sh
sudo apt install --allow-downgrades ./ORCA-<previous version>-linux-amd64.deb
```

## Why the package, and not the archive

Ubuntu 24.04 turns on `kernel.apparmor_restrict_unprivileged_userns`: a program may create an
unprivileged user namespace only if an AppArmor profile allows it. Chromium, and so Electron,
sandboxes its renderers in such a namespace. Without one it falls back to the SUID helper
`chrome-sandbox`, which works only when owned by root with mode `4755`.

A downloaded archive can provide neither: extraction makes the helper yours and `0755`, and nothing
in it can load an AppArmor profile. So the unpacked `orca-desktop` from the `tar.gz` aborts before
its first window with *"The SUID sandbox helper binary was found, but is not configured
correctly"*. The AppImage hits the same rule.

The package is installed by root, so its install script copies a profile to
`/etc/apparmor.d/orca-desktop` and loads it. The profile grants `userns` to
`/opt/ORCA/orca-desktop` and nothing else. Removing the package unloads and deletes it.

The install script is the repository's own,
[`packages/app/build/linux/after-install.tpl`](../packages/app/build/linux/after-install.tpl),
instead of electron-builder's:

- **`chrome-sandbox` is never setuid.** Every install sets it to `0755`, even over a helper
  something else made `4755`. Only Chromium's namespace sandbox is supported.
- **It refuses to install an app that cannot start.** Where unprivileged user namespaces are
  restricted (outside a chroot), the install must load its own profile and then see it active. If
  AppArmor is off, `apparmor_parser` is missing, the profile does not parse, the load fails, or the
  profile is not listed afterwards, the install fails with a message. A profile an earlier version
  left loaded does not count. In a chroot, or where the restriction is off, loading is best effort.
- **It refreshes no shared caches.** The package ships no MIME types. dpkg's own triggers rebuild
  the desktop database; the only change is `orca-desktop.desktop` appearing and later leaving.

The removal script and the profile itself are electron-builder's.

The profile trusts whatever binary is at `/opt/ORCA/orca-desktop`, so nothing under `/opt/ORCA` may
be writable by anyone but root. The build's `afterPack` hook
(`packages/app/scripts/linux-file-modes.js`) strips group and other write from the unpacked tree,
and the workflow refuses a package that still has any.

**Do not** work around the archive with `--no-sandbox`, by setting
`kernel.apparmor_restrict_unprivileged_userns=0`, or with `chown root` / `chmod 4755` on the
downloaded helper. Each weakens a protection for ORCA's renderers or for every program on the
machine. The package needs none of them.

## The other Linux artifacts

| Artifact | Use it for |
| --- | --- |
| `.deb` (x64, arm64) | Ubuntu, Debian and derivatives. **The supported path for testers.** |
| `.tar.gz` (x64, arm64) | Inspection (`tools/package-validation`), and distributions that do not restrict unprivileged user namespaces. Does not start on stock Ubuntu 24.04+. |
| `.AppImage` (x64) | The same tree as one file, with the same limit. |

## What is checked, and what is not

`.github/workflows/desktop.yml` installs the x64 `.deb` with `apt` on a GitHub-hosted Ubuntu 24.04
runner with the restriction on and no profile of its own. In order, it checks:

1. **The package.** Its SHA-256 is recorded. Every payload member is owned by root, with no setuid,
   setgid or sticky bit and nothing group- or other-writable.
2. **Control fields and scripts.** The name is `orca-desktop` with no Conflicts, Breaks, Replaces or
   Provides. postinst sets the helper to `0755`, has no setuid mode or cache refresh, and every
   link, alternative and profile belongs to `orca-desktop`.
<!-- rename-keep-start: the GNOME screen reader's package name -->
3. **Side by side.** The screen reader `orca` is installed too; its version, `/usr/bin/orca` and
   file ownership must be unchanged after both the install and the removal.
<!-- rename-keep-end -->
4. **The installed tree.** Helper and binary are `755 root:root`, with no special or shared-write
   bit under `/opt/ORCA`. `/usr/bin/orca-desktop` and the desktop entry's `Exec` resolve to
   `/opt/ORCA/orca-desktop`.
5. **Launch.** As the runner's unprivileged account: the profile is loaded, the helper is not
   setuid, the app starts its bundled daemon, a renderer runs in its own user namespace, `SIGTERM`
   stops the app and daemon, and `apt remove` unloads the profile.

`tools/test/linux-deb.test.js` holds the packaging config and that workflow step to this. It also
runs the install script against a fake root: it resets a setuid helper, and refuses where the
restriction is on and no profile loaded. No hosted runner can reach that refusal.

**Not covered:** the runner is not a desktop. It has no real session, the screen reader is installed
without its recommended packages and never started, and the built-in sample is not run. The
release-candidate check on a fresh Ubuntu 24.04 Desktop x64 with a standard account, recorded with
the artifact's source SHA, build run and digest, is a person's job. The arm64 package is built but
not installed by any check.
