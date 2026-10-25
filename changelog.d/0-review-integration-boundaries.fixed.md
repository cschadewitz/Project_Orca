- **agents:** Explicit config and permission-sidecar guards stay protected even when the
  configured store places them inside a workflow's writable area.
- **app:** A copied Mac update namespace with missing or torn enrollment cannot take over
  roots whose original namespace still exists. A confirmed reset removes enrollment before
  removing the last startup guard, so an interrupted reset can be retried or provisioned again.
