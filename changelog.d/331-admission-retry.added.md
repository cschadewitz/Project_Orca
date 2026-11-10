Add the shared protected retry journal and Request/direct admission services for
client idempotency keys, including durable reservation, bounded contention,
quota refusal and original-work reconciliation. Writable, token-authenticated
daemons with admission retry configured expose `runs.admit`, `admissions.get`
and `admissions.reconcile` to authorized callers with `runs.start` authority;
`runs.start` uses the same durable admission path when configured.

Palette admission intents now persist encrypted before dispatch, recover after app restart, and require explicit confirmation before abandoning an intent for separate work. Authenticated principal/workspace guards prevent retries crossing scopes; unavailable secure storage fails closed.
