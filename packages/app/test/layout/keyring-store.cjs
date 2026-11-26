// Loaded by the layout spec with `-r`, after Playwright's own Electron loader. Playwright
// appends Chromium's test switches to every Electron app it launches, `--password-store=basic`
// among them, and ORCA refuses `basic_text` for run intents (src/main/admission-intents.ts).
// So without this, Config > Launch work only ever shows "Secure run-intent storage is
// unavailable" and never the form the spec has to look at. The last value of a switch wins,
// so this puts the desktop keyring back. The spec starts its own unlocked GNOME keyring on a
// private session bus; nothing reaches the keyring of the machine it runs on.
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- loaded with `-r` before the app, as CommonJS. */
const { app } = require("electron");
app.commandLine.appendSwitch("password-store", "gnome-libsecret");
