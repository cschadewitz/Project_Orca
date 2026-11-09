- **app:** On an Attention card, `Enter` on a focused button presses that button. It used to
  answer with the card's selected option instead, so tabbing to **Deny** or **Always deny** on a
  permission ask and pressing `Enter` sent **Allow once**. The same holds in every list and
  canvas: `Enter` on a focused button or link is the control's, while a list's or a tree's own
  `Enter` on its selected row is unchanged.
- **app:** A push no longer moves focus while a person is working in an Attention card. A new
  permission ask, or a gate answered from somewhere else, used to move focus to another card or
  out of a half-typed note, so the next letters became card shortcuts and `Enter` could answer
  the wrong card. Focus now stays put, and moves to the next card only when the focused card
  itself goes.
- **app:** A palette row for an Attention card acts on the card it names, or on nothing. It
  used to act on whichever card was current when it ran, so a card answered elsewhere while the
  palette was open could turn "Answer" or "Cancel the run" into an answer or a cancel for a
  different run. When the named card has gone or changed, nothing is sent and the surface says
  so.
- **app:** Holding `Enter` in the command palette no longer confirms a destructive row. The
  key's auto-repeat counted as the second press, so a cancel could run without its confirmation
  being read.
