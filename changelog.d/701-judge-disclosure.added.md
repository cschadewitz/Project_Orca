- **cli:** `orca auth issue --judge-disclosure` records the owner's approval that a credential's
  runs may send action evidence to the plain-language rule judge configured under
  `review.plainRules.judge`: that destination, provider and model only. No preset includes it, and
  changing the judge's destination, provider or model needs a new grant (its timeout and daily call
  limit do not). Revoking or expiring the
  credential stops the next send. The judge is still not switched on.
