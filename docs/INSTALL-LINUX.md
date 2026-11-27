# Installing the desktop app on Linux

The supported Linux install is the **Debian package**, `ORCA-X.Y.Z-linux-amd64.deb` (or
`-arm64.deb`), installed with `apt`. It is the only Linux artifact that starts on a stock
Ubuntu 24.04 or later with Chromium's sandbox on and the system's protections unchanged
(#853).

```sh
sudo apt install ./ORCA-X.Y.Z-linux-amd64.deb   # the ./ makes apt read the local file
orca-desktop                                    # or open ORCA from the app menu
```

To remove it, `sudo apt remove orca-desktop`. Settings and workspaces you chose stay where
they are.

The package is `orca-desktop` and so is the command, **never `orca`**: on Ubuntu Desktop
that name belongs to the GNOME screen reader, which is installed by default as package
`orca` with `/usr/bin/orca`. `sudo apt remove orca` removes the screen reader, not ORCA. The
two install side by side; ORCA's package declares no conflict with the screen reader and
replaces none of its files.

## The command line

The package also installs ORCA's command line as **`orca-cli`** (#1207), `/usr/bin/orca-cli`:

```sh
orca-cli --help
orca-cli remote enroll build-box --host-key SHA256:...
```

It is the same CLI the app runs as its background service, started by the installed app's own
binary, so it is always the installed version. It is `orca-cli` for the same reason the app
is `orca-desktop`: plain `orca` is the screen reader. The docs write every command as
`orca-cli …`, and a remote profile you create in the app uses it unless you name another
command ([MULTI-MACHINE.md](MULTI-MACHINE.md)). From the archive, run
`resources/bin/orca-cli` in the unpacked directory, or link it onto your `PATH`.

## Updating

The package does not update itself. Instead, about 15 seconds after it starts and every six
hours after that, ORCA reads the project's public release list and, when a newer stable
release has a `.deb` for your machine, shows **X.Y.Z available** in the title bar (#888).
It offers the release page and the command to run once you have downloaded the package:

```sh
sudo apt install ./ORCA-X.Y.Z-linux-amd64.deb   # upgrades orca-desktop in place
```

Nothing is downloaded or installed until you do that. If ORCA is open while `apt` upgrades it,
the title bar then shows **Restart to finish update to X.Y.Z** (#905). It waits until no drafts
are unsaved and no run is active, stops ORCA's background service cleanly, hands your
workspace's data over to the new version and starts it. Use it rather than quitting and reopening, so the new version can carry
your data forward if its storage format changed.

If the restart cannot finish (another `apt` run changed the package meanwhile, or the workspace
could not be handed over), it starts nothing and says so; ORCA's background service stays
stopped. Quit ORCA and open it again. If the workspace then refuses to open because its data is
in an older format, reinstall the version you were running, which still opens it, and use the
restart from there:

```sh
sudo apt install --allow-downgrades ./ORCA-<previous version>-linux-amd64.deb
``` A check that fails or finds you
offline says nothing and never delays startup. Release candidates are offered only when
`ORCA_UPDATE_PRERELEASE=1` is set, the same rule as the Windows updater, and
`ORCA_UPDATE_CHECK=0` turns the check off. Only the installed package checks: the archive
and the AppImage do not.

## Why the package, and not the archive

Ubuntu 24.04 turns on `kernel.apparmor_restrict_unprivileged_userns`: a program may create
an unprivileged user namespace only if an AppArmor profile allows it. Chromium, and so
Electron, sandboxes its renderers in exactly such a namespace. When it cannot make one it
falls back to the SUID helper, `chrome-sandbox`, which only works when it is owned by root
with mode `4755`. A downloaded archive cannot carry either of those: extraction makes the
helper yours and `0755`, and nothing in it can load an AppArmor profile. So the unpacked
`orca-desktop` from the `tar.gz` aborts before its first window with *"The SUID sandbox helper
binary was found, but is not configured correctly"*, and the AppImage meets the same rule.

The package is installed by root, so its install script can do what the archive cannot. It
copies a profile to `/etc/apparmor.d/orca-desktop` and loads it. That profile does one
thing: it grants `userns` to `/opt/ORCA/orca-desktop` and nothing else, and leaves every
other program under the system's restriction. Removing the package unloads and deletes the
profile.

The install script is the repository's own,
[`packages/app/build/linux/after-install.tpl`](../packages/app/build/linux/after-install.tpl),
in place of electron-builder's. Three things set it apart:

- **`chrome-sandbox` is never setuid.** It is set to `0755` on every install, including
  over a helper something else made `4755`. electron-builder's script would fall back to
  `chmod 4755` when its install-time probe could not create a user namespace. This package
  supports Chromium's namespace sandbox only, with the profile above where it is needed.
- **It refuses rather than installing an app that cannot start.** If the system restricts
  unprivileged user namespaces (outside a chroot), the install must load its own packaged
  profile and then see it active. If AppArmor is not enabled, `apparmor_parser` is missing,
  the profile does not parse, the load fails or the profile is not listed afterwards, the
  install fails with a message saying so. A profile an earlier version left loaded never
  counts. It does not disable the sandbox or fall back to the setuid helper. In a chroot,
  or where the restriction is off, loading the profile is best effort.
- **It refreshes no shared caches itself.** The package ships no MIME types and its desktop
  entry declares none. dpkg's own triggers already rebuild the desktop database when
  `/usr/share/applications` changes (desktop-file-utils) and the MIME database when
  `/usr/share/mime/packages` changes (shared-mime-info), which this package never touches.
  The only derived change is `orca-desktop.desktop` appearing in, and later leaving, the
  desktop database.

The removal script and the profile itself are electron-builder's.

Because that profile trusts whatever binary sits at `/opt/ORCA/orca-desktop`, nothing under
`/opt/ORCA` may be writable by anyone but root. electron-builder unpacks Electron without
applying a umask and fpm copies modes as they are, so the build's `afterPack` hook
(`packages/app/scripts/linux-file-modes.js`) strips group and other write from the unpacked
tree first, and the workflow refuses a package that still carries any.

**Do not** work around the archive with `--no-sandbox`, by setting
`kernel.apparmor_restrict_unprivileged_userns=0`, or by `chown root` / `chmod 4755` on the
downloaded helper. Each of those turns off or weakens a protection, either for ORCA's
renderers or for every program on the machine; the package needs none of them.

## The other Linux artifacts

| Artifact | Use it for |
| --- | --- |
| `.deb` (x64, arm64) | Ubuntu, Debian and their derivatives. **The supported path for testers.** |
| `.tar.gz` (x64, arm64) | Inspection (`tools/package-validation`), and distributions that do not restrict unprivileged user namespaces. It does not start on stock Ubuntu 24.04+. |
| `.AppImage` (x64) | The same tree as a single file, with the same limit as the archive. |

## What is checked, and what is not

`.github/workflows/desktop.yml` installs the x64 `.deb` with `apt` on a GitHub-hosted
Ubuntu 24.04 runner with the restriction on and no profile of the job's own. It first
records the package's SHA-256 and checks every payload member's numeric mode and owner: all
root's, no setuid, setgid or sticky bit, nothing group- or other-writable. It reads the
control fields (name `orca-desktop`, no Conflicts/Breaks/Replaces/Provides) and the
generated maintainer scripts: postinst sets the helper to `0755`, contains no setuid mode or
cache refresh, and every link, alternative and profile belongs to `orca-desktop`. It then
installs the screen reader `orca` beside it, whose version, `/usr/bin/orca` and file
ownership must be unchanged after both the install and the removal. Before launching, it checks the installed tree (helper and binary
`755 root:root`, no special or shared-write bit under `/opt/ORCA`) and the entry point:
`/usr/bin/orca-desktop` and the desktop entry's `Exec` both resolve to
`/opt/ORCA/orca-desktop`. It then launches as the runner's own unprivileged account and checks
that the profile is loaded, the helper is not setuid, the app starts its bundled daemon, a
renderer runs in its own user namespace (the sandbox is really on), `SIGTERM` stops the app
and its daemon, and `apt remove` unloads the profile. `tools/test/linux-deb.test.js` holds
the packaging configuration and that workflow step to this, and runs the install script
against a fake root: it resets a setuid helper, and refuses where the restriction is on and
no profile loaded. No hosted runner can reach that refusal.

That runner is not a desktop install: it has no real session, the screen reader is
installed without its recommended packages and never started, and nothing there runs the
built-in sample. The release-candidate check on a fresh Ubuntu 24.04 Desktop x64 with a
standard account, recorded with the artifact's source SHA, build run and digest, is still
a person's job. The arm64 package is built but not installed by any check.
