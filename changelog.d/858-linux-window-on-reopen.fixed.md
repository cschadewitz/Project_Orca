- **app:** On Linux under Wayland (stock Ubuntu 24.04 Desktop), the app no longer starts with
  no window. The window was shown only when Electron reported its first paint, and a hidden
  Wayland window often never paints, so the daemon and renderer ran with nothing on screen.
  The window is now also shown half a second after its page loads, or four seconds after it
  was created, whichever comes first.
