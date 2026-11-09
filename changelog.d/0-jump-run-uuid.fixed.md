- **app:** Typing or pasting a run id into the command palette now jumps to runs admitted
  through a request or a direct launch, whose ids are `run_` and a UUID. Only the 26-character
  form was recognised, so the runs started from the app were the ones that could not be
  found by id. A bare UUID without `run_` is still not taken for a run.
