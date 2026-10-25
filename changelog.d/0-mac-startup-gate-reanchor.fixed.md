- **app:** On macOS, only a packaged app mounts the update-recovery startup gate, so
  development runs and the app smoke tests start normally instead of opening only the
  recovery shell.
- **app:** A packaged Mac app no longer opens only the recovery shell after Migration
  Assistant, a Time Machine restore, a renamed home folder, a moved or deleted workspace,
  or a crash during first-launch setup or enrollment. An open update window that no
  update attempt holds is re-anchored to its directories' new identities; when its
  records are lost or unreadable, the recovery shell offers a confirmed reset. A recorded
  update attempt still keeps startup closed.
