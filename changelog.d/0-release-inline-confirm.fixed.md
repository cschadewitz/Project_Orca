- **app:** Releasing a claim on the Agents surface asks on the row instead of in a menu.
  **Release** is a quiet button at rest; pressing it arms the row in the danger tone, with
  **Keep** (focused, so a second `Enter` keeps the claim) and **✕ Confirm release**, and a
  second line saying what releasing does: the work item goes back to the scheduler, its run
  loses the claim, and another run may claim it. Keep, `Esc`, moving focus away or arming
  another row disarms it, and nothing is sent until Confirm. The controls are named by the
  work item's title. The command palette's release row on the Agents surface now arms on the
  first `Enter` and sinks below the safe commands, as the Plan surface's already did.
