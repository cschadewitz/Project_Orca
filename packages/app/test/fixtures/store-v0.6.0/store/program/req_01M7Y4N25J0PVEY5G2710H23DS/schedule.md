---
status: done
computedAt: 2026-11-21T04:08:26.427Z
strategy: critical-path
ready:
  - slug: schema
    score: 7.6
    reasons:
      - unblocks 1 item (login-api)
      - on the critical path (length 3)
      - "exposed to medium risk: migration-downtime"
  - slug: docs
    score: 1.5
    reasons: []
running: []
waiting:
  - slug: login-api
    on:
      - waiting for schema to be done (currently pending)
held: []
unschedulable: []
done: []
failed: []
waves:
  - - schema
    - docs
  - - login-api
criticalPath:
  - schema
  - login-api
criticalPathLength: 3
cycles: []
risk:
  open: 2
  highestLevel: high
  byLevel:
    low: 0
    medium: 1
    high: 1
    critical: 0
  top:
    - key: token-leak
      level: high
      score: 10
    - key: migration-downtime
      level: medium
      score: 8
openDecisions: []
---
# Schedule for plan `demo`

Computed 2026-11-21T04:08:26.424Z with strategy **critical-path** (risk appetite: high).

## Ready (dispatch order)

1. `schema` (score 7.6) - unblocks 1 item (login-api); on the critical path (length 3); exposed to medium risk: migration-downtime
2. `docs` (score 1.5)

## Waiting

- `login-api`: waiting for schema to be done (currently pending)

## Waves

1. `schema`, `docs`
2. `login-api`

Critical path (3): `schema` -> `login-api`

## Risks

| risk | level | L x I | status | affects | mitigation |
| --- | --- | --- | --- | --- | --- |
| migration-downtime | medium | 2 x 4 | open | schema | Run the migration online |
| token-leak | high | 2 x 5 | open | login-api | Redact in logger |

## Decisions

### session-store: Where do sessions live? (decided = cookie)

Signed cookies or a server-side store?

| option | Simplicity (w3) | Revocation support (w1) | score |
| --- | --- | --- | --- |
| **Signed cookie** | 9 | 3 | 7.5 |
| Redis | 5 | 9 | 6 |

Recommended: **cookie** (clear, margin 0.15); pivotal criteria: simplicity

Rationale: Simplicity wins for v1.

Blocks: login-api


## Dependency graph

```mermaid
flowchart LR
  wi_01M7Y4N2FEP02284GR1X5MZ93Y["schema<br/><small>pending</small>"]:::pending
  wi_01M7Y4N2FEB9B6JRDH72BKHGMZ["login-api<br/><small>pending</small>"]:::pending
  wi_01M7Y4N2FEW0KDSP52EJ2M09VW["docs<br/><small>pending</small>"]:::pending
  dec_6N0D4VZ3831E5E1CES5NCHHPQZ{"decision: session-store<br/><small>decided = cookie</small>"}:::decision
  wi_01M7Y4N2FEB9B6JRDH72BKHGMZ --> dec_6N0D4VZ3831E5E1CES5NCHHPQZ
  wi_01M7Y4N2FEB9B6JRDH72BKHGMZ --> wi_01M7Y4N2FEP02284GR1X5MZ93Y
  wi_01M7Y4N2FEW0KDSP52EJ2M09VW -. informs .-> wi_01M7Y4N2FEB9B6JRDH72BKHGMZ
  classDef pending fill:#f4f4f5,stroke:#a1a1aa
  classDef ready fill:#dbeafe,stroke:#3b82f6
  classDef running fill:#fef3c7,stroke:#f59e0b
  classDef blocked fill:#fee2e2,stroke:#ef4444
  classDef done fill:#dcfce7,stroke:#22c55e
  classDef failed fill:#fecaca,stroke:#b91c1c
  classDef decision fill:#ede9fe,stroke:#8b5cf6
  classDef external fill:#e5e7eb,stroke:#6b7280,stroke-dasharray: 4 2
```
