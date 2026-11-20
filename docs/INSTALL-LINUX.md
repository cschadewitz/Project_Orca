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
thing: it grants `userns` to `/opt/ORCA/orca-desktop` and nothing else, and leaves every other program under
the system's restriction. `chrome-sandbox` stays `0755` (not setuid) wherever user
namespaces work, which with the profile loaded includes Ubuntu 24.04. Removing the package
unloads and deletes the profile. These are electron-builder's standard Debian scripts; the
repository adds none of its own.

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
reads the package's control fields and generated maintainer scripts (name `orca-desktop`,
no Conflicts/Replaces/Provides, every link, alternative and profile `orca-desktop`'s), and
installs the screen reader `orca` beside it, whose version, `/usr/bin/orca` and file
ownership must be unchanged after both the install and the removal. Then it checks
that the profile is loaded, the helper is not setuid, the app starts its bundled daemon, a
renderer runs in its own user namespace (the sandbox is really on), `SIGTERM` stops the app
and its daemon, and `apt remove` unloads the profile. `tools/test/linux-deb.test.js` holds
the packaging configuration and that workflow step to this.

That runner is not a desktop install: it has no real session, the screen reader is
installed without its recommended packages and never started, and nothing there runs the
built-in sample. The release-candidate check on a fresh Ubuntu 24.04 Desktop x64 with a
standard account, recorded with the artifact's source SHA, build run and digest, is still
a person's job. The arm64 package is built but not installed by any check.
