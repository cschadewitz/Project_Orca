# Feedback template

Part of the [Windows/Linux candidate guide](tester-guide.md). Use one copy per experience:
a success, a failure, a confusing step or an idea. **Every field is optional.**
`unknown`, `not tested` and `prefer not to share` are all good answers. Fill it in from
what you saw. Don't look in logs or ORCA's folders for missing details.

Write in your own words. Leave out:

- anything on the [never send](when-something-goes-wrong.md#collect-details-safely) list
- prompts, code, screenshots, real project names, and paths outside your throwaway
  folders
- names of people, accounts, computers or workplaces

Hardware and OS details can identify someone in a small group; leave them out if you
prefer. Send the report only through the route on your card. Never post it on public
GitHub.

```text
Report alias (a random word, not your name or account):
Kind: success / stuck / failure / confusing step / idea

1. Candidate
   Version on the candidate card:
   Version shown in ORCA's status bar (orca-daemon …), if you got that far:
   File used (name only):
   SHA-256 matched the card: yes / no / not checked

2. Platform and runtime
   Platform: Windows / Linux
   OS name and version, as the prerequisites check on your platform page showed it:
   Architecture: x64 / arm64
   Linux only, file type: tar.gz / AppImage
   Windows only, install: installer completed / stopped before installing
   Git version (git --version):

3. Where you got to
   Last step completed (P1–P9 Windows, P1–P6 Linux, F1–F10 sample):
   Step where you stopped, and why:

4. What happened
   Steps you took (generic labels such as "trial project", "trial workspace"):
   What you expected:
   What actually happened, in your own words:
   ORCA's on-screen message, copied only if it has no paths or names:
   Security warning seen: none / browser / SmartScreen / antivirus / Linux sandbox / other:
   Prompts you did NOT expect (sign-in, key, administrator, permission question):
   Repeated? once / happened again on one retry / not retried

5. Sample result (if you reached F8)
   Runs showed one orca-beta-local-check run marked "succeeded": yes / no / not reached
   Project unchanged (git status empty, one commit): yes / no / not checked
   Reopen (F10) showed the same single run: yes / no / not tried

6. Stopping
   Anything still running 30 seconds after closing ORCA: no / yes (names only) / not checked

7. Help and evidence
   Did anyone give you a hint? none / yes, at step …, kind of hint:
   Sanitized terminal excerpt (Linux, only if the coordinator asked; at most 3 lines):

8. Anything else you'd like to see changed:
```

Diagnostics are not part of this round. There is no diagnostics field to fill in, and no
file to attach. Sending this report gives no one access to your computer and does not
ask you to try anything again.
