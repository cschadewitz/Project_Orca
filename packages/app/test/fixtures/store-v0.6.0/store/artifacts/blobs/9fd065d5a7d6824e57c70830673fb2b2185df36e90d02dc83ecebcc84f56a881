---
status: done
items:
  - slug: schema
    title: Database schema
    kind: task
    description: Add users table
    estimate: S
    dependsOn: []
    risks:
      - migration-downtime
  - slug: login-api
    title: Login API
    kind: feature
    description: POST /login
    estimate: M
    priority: high
    dependsOn:
      - schema
      - decision:session-store
  - slug: docs
    title: Docs
    kind: task
    description: Document auth
    estimate: XS
    dependsOn:
      - informs:login-api@spec
risks:
  - key: migration-downtime
    title: Schema migration locks the users table
    category: operational
    likelihood: 2
    impact: 4
    mitigation: Run the migration online
    affects:
      - schema
decisions:
  - key: session-store
    title: Where do sessions live?
    question: Signed cookies or a server-side store?
    options:
      - key: cookie
        name: Signed cookie
      - key: redis
        name: Redis session store
    blocks:
      - login-api
rationale: Vertical slices with one shared prerequisite and one architectural decision.
---
Demo breakdown.