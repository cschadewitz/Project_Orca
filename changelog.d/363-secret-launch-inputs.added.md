- **engine:** a workflow can let the launcher choose which configured secret a step uses.
  Declare a launch input of `type: secret` and map it to an agent environment variable with
  the step's `secretEnv`. The launcher names the secret by id; the step's session reads it
  on the agent's host at session open under the run owner's grant, and the value never
  enters the prompt, the model or the store. Unknown ids, secrets bound to another host, and
  delegated steps are refused before the run starts.
