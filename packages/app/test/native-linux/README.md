# Native Linux acceptance

Scripted checks of the **installed** `orca-desktop` package in a disposable Linux desktop
session. They cover the bug classes that only showed up on a real Ubuntu 24.04 desktop and
that the other Playwright projects cannot see:

| Spec | Covers | What it asserts |
|---|---|---|
| `reopen-cycles.spec.ts` | #858 | On X11 (Xvfb) and on Wayland (headless Weston), `ORCA_NATIVE_CYCLES` (default 5) quit/reopen cycles each show the window within 8 s (`BrowserWindow.isVisible()`, and on X11 a mapped window named ORCA), connect to the bundled daemon, render the shell, and leave no ORCA or daemon process after quit. |
| `release-notice.spec.ts` | #888 | Against a local release-list stub (`ORCA_RELEASES_URL`): an install older than the newest stable release with an amd64 `.deb` shows the title-bar notice, with the `apt` command and **Open release page**; a current install shows nothing; an unreachable list is silent and the window is still visible within the usual budget. |
| `package-restart.spec.ts` | #905 | With first-run setup done, `sudo apt-get install` upgrades to a second package of the same build stamped higher (`ORCA_NATIVE_NEXT_DEB`) beneath the running app. **Restart to finish update to X** appears; clicking it writes `update-handoff.json.<claim>` (from the running version, to the installed one, drained), the old app exits, the installed one starts by itself and its daemon spends the record. A second launch with no app workspace follows the offer as apt moves up, back and up again, then clicks it: the handoff is refused after the stop, nothing new starts, the app stays, and its message names the recovery. Then `ORCA_NATIVE_CURRENT_DEB` is reinstalled. Defined only when both are set. |
| `sqlite-switch.spec.ts` | #339 | Started with `ORCA_SQLITE_SWITCH=1` (the switch is off otherwise): first-run setup and one sample run on files, then **Switch to SQLite** in Config's Workspace storage. The app exits, the installed one starts by itself, and its daemon switches the store (marker on SQLite, `metadata.sqlite` there, no switch journal left). Reopened, Config says SQLite, the run is still listed and a second sample runs. Then **Switch back to files** the same way: marker on files, database gone, both runs listed, and a third sample runs on files. |
| `config-reopen.spec.ts` | #1192 | After first-run setup, an agent added in Config > Raw (Validate and review, Save reviewed changes, Apply saved configuration) is bound for reopening by the save itself. Quit and reopen connects to the bundled daemon with no setup step, and the agent is on Agents (screenshot attached). |
| `remote-enroll.spec.ts` | #1206 | After first-run setup, a remote and an agent that delegates to it are added in Config > Raw (saved and applied). Config's Remote daemons section then enrolls it with the fingerprint typed in: the record lands in the app's own workspace, with the key pinned and the credential issued by the worker over a loopback sshd. A delegated run then runs exactly once on a real worker daemon and succeeds in the app (screenshots attached). Needs `/usr/sbin/sshd`. |
| `keyring-prompt.spec.ts` | #857 | With a locked GNOME login keyring and the real gcr unlock prompt: Cancel on a fresh install gives the before-send refusal and no run, with no in-app Retry. Quit, reopen and Unlock admits the sample once and it succeeds. Another reopen still lists exactly one run. Locking again with a journal on disk and cancelling gives the recovery-only refusal, Launch disabled, and no new run. |

## Run it

```sh
# Ubuntu 24.04, as an unprivileged user (Chromium's sandbox refuses root)
sudo apt-get install xvfb dbus dbus-bin gnome-keyring gcr libsecret-tools xdotool weston openssh-server
pnpm run build && pnpm --filter @orca/app run build:daemon
pnpm --filter @orca/app exec electron-builder --linux deb --x64 --publish never
sudo apt-get install ./packages/app/dist/release/ORCA-*-linux-amd64.deb
pnpm run app:linux-native
```

For `package-restart.spec.ts`, also build the same tree stamped higher and name both packages
(it runs `sudo apt-get install`, so sudo must not prompt):

```sh
pnpm --filter @orca/app exec electron-builder --linux deb --x64 --publish never \
  -c.extraMetadata.version=99.0.0 -c.directories.output=dist/release-next
ORCA_NATIVE_CURRENT_DEB=$(readlink -f packages/app/dist/release/ORCA-*-linux-amd64.deb) \
ORCA_NATIVE_NEXT_DEB=$(readlink -f packages/app/dist/release-next/ORCA-99.0.0-linux-amd64.deb) \
pnpm run app:linux-native
```

No `xvfb-run`: the specs start their own display, bus, keyring and compositor, with a clean
environment, so nothing from the desktop you run them on (your keyring above all) is touched.
`ORCA_NATIVE_EXECUTABLE` points them at another build, such as
`packages/app/dist/release/linux-unpacked/orca-desktop`; the default is `/opt/ORCA/orca-desktop`.

The package these specs install is a **regression build of the ref under test**, stamped with
the root `package.json` version and checked like Desktop's before the privileged install. It
is not the published release artifact. Exact-package acceptance stays with `desktop.yml`'s
`.deb` step and the tester pass on the release candidate's own package.

In CI this is the `linux-native` job of `.github/workflows/app-smoke.yml`, on a GitHub-hosted
`ubuntu-24.04` runner (it needs sudo for apt and `/opt`), by manual dispatch and from release
publishing.

## How the pieces work

- **`session.ts`** starts `Xvfb -displayfd`, a private `dbus-daemon`, and
  `gnome-keyring-daemon` with a password-protected login keyring that it then restarts
  locked (`secret-tool lock` hangs on gnome-keyring 46). The bus is started with `DISPLAY`
  set, so the gcr-prompter it activates opens on this display. `XDG_CURRENT_DESKTOP=GNOME`
  makes Electron use `gnome_libsecret`; without it Electron picks `basic_text`, which is a
  different path. A watcher answers every "Unlock Login Keyring" window with xdotool: Escape
  to cancel, or the password and Return to unlock. Input goes through XTEST to the focused
  window; `xdotool --window` sends synthetic events, which GTK and Chromium ignore.
- **`app.ts`** launches the installed binary with Playwright's `_electron.launch({ executablePath })`
  and `chromiumSandbox: true`. Without that option Playwright adds `--no-sandbox` on Linux.
  Every launch then fails unless the browser has no `--no-sandbox` and each renderer is in a
  user namespace of its own (`requireSandbox`).
  This needs Electron's `EnableNodeCliInspectArguments` fuse left on, which the package does
  today. If a hardening pass turns it off, these specs fail at launch and need an otherwise
  identical unfused build. Quit is a real Ctrl+Q on X11. Headless Weston has no input
  injection, so on Wayland the app menu's Quit item is clicked from the main process.
- **`flows.ts`** is the tester's path by role and accessible name: first-run setup of a
  disposable Git project and empty workspace, then Launch work with the harmless sample.
  The folder chooser is stubbed in the main process: GTK's dialog is GTK's to test.

## Checked against the bugs

Before this suite was merged it was run against builds without each fix:

- With #860's reveal fallback reverted (`ready-to-show` only), the Wayland reopen test failed
  on its first cycle with no visible window. The X11 test still passed 10 of 10, which is why
  Wayland is part of this suite.
- On `main` before #859, Launch work showed "Guided launch could not verify this target"
  instead of the keyring guidance, and the first keyring test failed.

## Not covered

- A physical GNOME Shell (Mutter) session, its prompt styling and the GTK folder chooser.
- The no-keyring (`basic_text`) desktop, which is covered by unit tests only.
- arm64, and the Windows and macOS equivalents. Windows has no keyring prompt (DPAPI).
