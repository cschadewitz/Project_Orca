- **engine:** a workflow can let the launcher choose which configured secret a step uses.
  Declare a launch input of `type: secret` and map it to an agent environment variable with
  the step's `secretEnv`. The launcher names the secret by id, and the id is taken from the
  launch record, never from vars a step changes later. Each such step gets an agent process
  of its own, which reads the secret on the agent's host at open under the run owner's grant
  as it is then, so a revoked grant or a rotated value takes effect at the next step. The
  value never enters the prompt, the model or the store. Unknown ids, secrets bound to another
  host, and delegated steps are refused before the run starts.
