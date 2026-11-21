# Native Linux acceptance

Scripted checks of the **installed** `orca-desktop` package in a disposable Linux desktop
session. They cover the bug classes that only showed up on a real Ubuntu 24.04 desktop and
that the other Playwright projects cannot see:

| Spec | Covers | What it asserts |
|---|---|---|
| `reopen-cycles.spec.ts` | #858 | On X11 (Xvfb) and on Wayland (headless Weston), `ORCA_NATIVE_CYCLES` (default 5) quit/reopen cycles each show the window within 8 s (`BrowserWindow.isVisible()`, and on X11 a mapped window named ORCA), connect to the bundled daemon, render the shell, and leave no ORCA or daemon process after quit. |
| `keyring-prompt.spec.ts` | #857 | With a locked GNOME login keyring and the real gcr unlock prompt: Cancel on a fresh install gives the before-send refusal and no run, with no in-app Retry. Quit, reopen and Unlock admits the sample once and it succeeds. Another reopen still lists exactly one run. Locking again with a journal on disk and cancelling gives the recovery-only refusal, Launch disabled, and no new run. |

## Run it

```sh
# Ubuntu 24.04, as an unprivileged user (Chromium's sandbox refuses root)
sudo apt-get install xvfb dbus dbus-bin gnome-keyring gcr libsecret-tools xdotool weston
pnpm run build && pnpm --filter @orca/app run build:daemon
pnpm --filter @orca/app exec electron-builder --linux deb --x64 --publish never
sudo apt-get install ./packages/app/dist/release/ORCA-*-linux-amd64.deb
pnpm run app:linux-native
```

No `xvfb-run`: the specs start their own display, bus, keyring and compositor, with a clean
environment, so nothing from the desktop you run them on (your keyring above all) is touched.
`ORCA_NATIVE_EXECUTABLE` points them at another build, such as
`packages/app/dist/release/linux-unpacked/orca-desktop`; the default is `/opt/ORCA/orca-desktop`.

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
- **`app.ts`** launches the installed binary with Playwright's `_electron.launch({ executablePath })`.
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
