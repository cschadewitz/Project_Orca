- **app:** Saving the Agents policy panel no longer erases a grant written while the draft was
  open, or puts back one somebody revoked. The draft holds the rules of the agents a person
  edited rather than a copy of `orca.permissions.json`, and Save writes them onto the file as
  it is now, so an "allow always" answered meanwhile for another agent is kept; one that
  changed the same agent's rules stops the save with a conflict and **Reload**. What is typed
  while a save is out stays in the draft, and **Discard** waits for the write instead of
  hiding a save that still lands.
