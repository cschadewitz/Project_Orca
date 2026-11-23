- **agents:** a session with the Claude ACP adapter older than 0.109.1 is refused unless the
  agent sets `nativeToolHook: off`, and a call Claude would have run from its own allow
  rules may now be asked about, or denied, by ORCA's policy (#704).
