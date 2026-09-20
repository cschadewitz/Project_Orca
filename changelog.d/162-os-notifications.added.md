- **app:** OS notifications, per the tier table and opt-in per tier. A permission ask
  notifies immediately, a gate sixty seconds after it was asked, a failed run when it fails;
  the default is permission asks only, with an unfocused-escalation interval that lets gates
  through when the window has been ignored. They coalesce — a second ask updates the count on
  the notification already showing rather than stacking a second behind it — and clicking one
  focuses the window and opens Attention. A permission ask may take the person's attention
  only inside a window that already has focus, and nothing in the app raises a window at
  anybody. The preference lives beside the theme and the densities in `preferences.json`.
