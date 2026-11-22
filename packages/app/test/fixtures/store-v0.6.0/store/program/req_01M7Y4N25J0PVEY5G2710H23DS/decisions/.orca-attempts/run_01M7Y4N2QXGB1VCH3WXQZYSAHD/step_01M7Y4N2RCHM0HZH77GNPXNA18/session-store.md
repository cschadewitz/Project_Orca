---
status: done
key: session-store
title: Where do sessions live?
scale: 10
criteria:
  - key: simplicity
    name: Simplicity
    weight: 3
  - key: revocation
    name: Revocation support
    weight: 1
options:
  - key: cookie
    name: Signed cookie
    scores:
      simplicity: 9
      revocation: 3
  - key: redis
    name: Redis
    scores:
      simplicity: 5
      revocation: 9
rationale: Simplicity wins for v1.
---
Matrix reasoning.