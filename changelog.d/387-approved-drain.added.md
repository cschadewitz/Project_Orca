- **daemon:** Extend authenticated runtime maintenance with owner-bound drain and
  defer actions. Close new workflow/run/request admissions while allowing existing
  work and answers to finish, and require empty activity plus a complete unfinished
  run inventory before sealing the idle fence. Native installation remains disabled.
