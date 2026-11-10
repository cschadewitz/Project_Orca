- **app:** **Always deny** on a permission card no longer lets the call through. It sent the
  selected option, usually **Allow once**, with a deny rule; it now answers with the deny
  option, and **Always allow** with an allow option. When the ask names no single option that
  goes that way, the button is disabled and says why.
- **engine:** Permission-ask options from an ACP `reject_once` / `reject_always` kind are marked
  `destructive`.
- **daemon:** `inputs.answer` refuses an `always` whose one-time answer goes the other way
  (`NOT_SUPPORTED`), before anything is answered or written.
