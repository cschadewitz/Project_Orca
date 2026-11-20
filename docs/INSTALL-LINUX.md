# Installing the desktop app on Linux

The supported Linux install is the **Debian package**, `ORCA-X.Y.Z-linux-amd64.deb` (or
`-arm64.deb`), installed with `apt`. It is the only Linux artifact that starts on a stock
Ubuntu 24.04 or later with Chromium's sandbox on and the system's protections unchanged
(#853).

```sh
sudo apt install ./ORCA-X.Y.Z-linux-amd64.deb   # the ./ makes apt read the local file
orca                                            # or open ORCA from the app menu
```

To remove it, `sudo apt remove orca`. Settings and workspaces you chose stay where they are.

## Why the package, and not the archive

Ubuntu 24.04 turns on `kernel.apparmor_restrict_unprivileged_userns`: a program may create
an unprivileged user namespace only if an AppArmor profile allows it. Chromium, and so
Electron, sandboxes its renderers in exactly such a namespace. When it cannot make one it
falls back to the SUID helper, `chrome-sandbox`, which only works when it is owned by root
with mode `4755`. A downloaded archive cannot carry either of those: extraction makes the
helper yours and `0755`, and nothing in it can load an AppArmor profile. So the unpacked
`orca` from the `tar.gz` aborts before its first window with *"The SUID sandbox helper
binary was found, but is not configured correctly"*, and the AppImage meets the same rule.

The package is installed by root, so its install script can do what the archive cannot. It
copies a profile to `/etc/apparmor.d/orca` and loads it. That profile does one thing: it
grants `userns` to `/opt/ORCA/orca` and nothing else, and leaves every other program under
the system's restriction. `chrome-sandbox` stays `0755` (not setuid) wherever user
namespaces work, which with the profile loaded includes Ubuntu 24.04. Removing the package
unloads and deletes the profile. These are electron-builder's standard Debian scripts; the
repository adds none of its own.

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
Ubuntu 24.04 runner with the restriction on and no profile of the job's own, then checks
that the profile is loaded, the helper is not setuid, the app starts its bundled daemon, a
renderer runs in its own user namespace (the sandbox is really on), `SIGTERM` stops the app
and its daemon, and `apt remove` unloads the profile. `tools/test/linux-deb.test.js` holds
the packaging configuration and that workflow step to this.

That runner is not a desktop install: it has no real session, and nothing there runs the
built-in sample. The release-candidate check on a fresh Ubuntu 24.04 Desktop x64 with a
standard account, recorded with the artifact's source SHA, build run and digest, is still
a person's job. The arm64 package is built but not installed by any check.
