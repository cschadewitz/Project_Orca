Add the shared protected retry journal and Request/direct admission services for
client idempotency keys, including durable reservation, bounded contention,
quota refusal and original-work reconciliation. The #331 handoff includes a
separate integration patch for prompt `runs.admit`, legacy `runs.start`, current
authorization and client wiring; these capabilities are not enabled by the
feature modules alone.

Palette admission intents now persist encrypted before dispatch, recover after app restart, and require explicit confirmation before abandoning an intent for separate work. Authenticated principal/workspace guards prevent retries crossing scopes; unavailable secure storage fails closed.
