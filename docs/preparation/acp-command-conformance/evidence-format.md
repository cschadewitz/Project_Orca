# Safe evidence v1

Use [evidence-v1.schema.json](evidence-v1.schema.json) for one case record. Closed
fields and enumerated aliases prevent arbitrary commands, paths, environment,
host names or receipts from being put into the public packet. Validate **before**
publishing, and inspect prose/logs separately; a schema cannot sanitize attachments.
Do not publish raw transcripts, ACP payloads, protected-store records, credential
identifiers, command environment, actual paths, internal host identities or receipt
contents. Even hashes of private commands/payloads are excluded.

Each record names a test/review head and evidence class. Source pins map public
release source; they never mean the installed artifact was verified. Synthetic
identities use aliases, never the random IDs from a fixture or a real deployment.
Keep private exact-lifetime correspondence under the already authorized protected
owner; do not export it into this preparation packet.
The optional identity object is for synthetic aliases only. Later real-provider
and actual-Cal public records omit it; private correspondence remains protected.

| Observation | Meaning |
| --- | --- |
| requested | Synthetic peer or authorized native caller requested a decision; no approval implied |
| surfaced | Existing input/projection carried the ask to the observer; does not mean exact-command evidence was sufficient |
| allowed / rejected | An offered decision was selected; automatic policy and human selection must be distinguished by evidence class/case |
| delivered | Response reached the originating synthetic callback, or separately observed real callback; acknowledgement alone is insufficient |
| executed | Positive independent effect observation; synthetic memory counter is labeled synthetic and never proves actual execution |
| expired | Original owner/turn/invocation cannot accept another answer |
| blocked | Policy, missing evidence, unavailable source or missing authorization prevents acceptance/testing |
| unsupported | The path/option cannot meet this one-command contract; no fallback grant |

Observations are cumulative facts, not a single success state. A rejected response
can be delivered but never implies execution authorization. An expired callback
may have a previously recorded allowed answer; this does not revive it. A lost
response with uncertain delivery is `unknown`, then read the original state. Do
not append `delivered` or `executed` by inference, or repeat the answer to get proof.

Example (illustrative, not an execution receipt):

```json
{
  "version": 1,
  "caseId": "S02",
  "evidenceClass": "synthetic",
  "orcaHead": "794e64344e3d6edb64e80c5920f722ff381fa4a5",
  "providerRelease": "0.159.1",
  "adapterRelease": "2.1.1",
  "action": "fixture-print-marker",
  "identity": {
    "run": "synthetic-run-1",
    "step": "synthetic-step-1",
    "request": "synthetic-request-1",
    "instance": "synthetic-instance-1",
    "session": "synthetic-session-1",
    "turn": "synthetic-turn-1",
    "invocation": "synthetic-invocation-1"
  },
  "observations": ["requested", "surfaced", "blocked"],
  "result": "blocked",
  "reason": "operator-context-omitted"
}
```

The example uses the source baseline to show the format; it is not a claimed test
head. Published synthetic results use the preparation commit given by the PR.
Use `not-run` with an empty observation array when nothing was exercised.
Use `native-routing-unknown`, `native-source-unavailable`,
`installed-artifact-unverified`, `managed-sandbox-denied`,
`command-binding-incomplete` or `separate-authorization-required` as appropriate.
