- **agents:** Bound ACP permission callbacks to their original turn and invocation;
  cancellation, timeout and transport loss expire late answers. Explicit session loading
  checks agent capability and reports fresh-session fallbacks.
- **engine:** Added owner-local live permission decision primitives with exact identities,
  actor attribution and ordered standing-rule writes. Shared daemon/app activation is
  supplied as a separate integration patch under the runtime parallel contract.
