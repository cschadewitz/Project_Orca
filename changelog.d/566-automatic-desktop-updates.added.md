- **app:** the Windows app updates itself (#566). It checks and downloads in the background,
  then installs after 15 minutes without input, or when you close its last window, and only
  when the bundled daemon proves nothing is running and no window holds an unsaved draft. It
  never stops work: a busy app tries again later, and after three days the header highlights
  **Restart to update**. **Turn off automatic updates** in the command palette makes every step
  manual again.
