- **app:** on the Linux `.deb`, once `apt` has upgraded ORCA while it runs, the title bar offers
  **Restart to finish update**: it drains and stops the bundled daemon, hands the workspace store
  to the installed version as the Windows updater does, and starts it, so the new version can
  carry an older-format store forward (#905).
