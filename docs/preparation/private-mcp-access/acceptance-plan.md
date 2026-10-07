# Private MCP acceptance and evidence plan

This plan separates reference-client conformance, actual-Cal feasibility and full ORCA
operator acceptance. The scenarios below retain the **2026-10-02 planning baseline**;
their original NOT RUN status is not a present connection diagnosis. Actual Cal discovery,
historical worker/cutover evidence and the remaining exact-call/authority/capacity gates are
reconciled in the [7 October bounded actual-Cal matrix](actual-cal-matrix.md). Use that
handoff for present execution and record partial evidence separately from completed criteria.
Follow the [operator checklist](operator-checklist.md) before any setup.

## Evidence record

For each case record pass/fail/blocked, UTC time, operator, linked approval, expected and
actual result, safe error code, and cleanup result. Include:

- ORCA source/build SHA (or explicitly `synthetic fixture, no ORCA`), fixture revision,
  tunnel-client version/checksum, host platform and MCP transport/version;
- actual Cal surface/version and conversation evidence reference, target workspace and
  deployment identity using approved non-secret identifiers, connection/tool names;
- authentication mode, verified principal and credential **ID only**, effective operation
  grants/resource scope, and safe request/event IDs that correlate the observed call;
- freshness, pagination/truncation observations and any unsupported capability.

Keep credentials, OAuth codes, authorization headers, raw private addresses/paths,
protected storage and personal project data out of the report. Screenshots/transcripts
must be reduced to the safe fields above. Fixture data must be synthetic.

## Reference-client and bridge checks

These cases belong to #327 server tests / #392 lifecycle tests. They can run with faithful
synthetic auth fixtures and do not establish Cal access.

| ID | Exercise | Required result |
| --- | --- | --- |
| R1 | Initialize, discover and call the fixture through a reference MCP client, then through the tunnel | Expected versioned tools and fixed target identity; no admin/write tools; success attributed to the verified test principal. Separate local and tunneled results. |
| R2 | Missing, malformed, expired, revoked and wrong-audience/issuer credentials; forged actor/identity headers | Fail closed at the relevant layer; no daemon dispatch as an owner/shared fallback. Existing sessions and fresh sessions both lose access. Unknown subjects/targets cannot acquire a mapping. |
| R3 | Existing unowned run, owned run, another root workflow, denied/nonexistent run, descendant, denied artifact, empty and large pages | Allowed existing history is visible under the explicit grant; denied and nonexistent targets have indistinguishable external results. Counts, graph/provenance links, notifications and continuation pages reveal no protected content. |
| R4 | Drop network, kill bridge, restart adapter/daemon, change endpoint/target | Bounded recovery, honest unavailable/unknown status, identity recheck and no target substitution. Old cursors are reauthorized; revoked access cannot retrieve buffered output. |
| R5 | Lost read response; later, lost admission response and restart before/after acknowledgement | Reads can be retried under current authority. Before #331 is integrated, uncertain writes are not replayed. Afterwards the same scoped key/payload returns original IDs, changed payload conflicts, and a deliberate new run needs a new key. No adapter-local deduplication substitute. |
| R6 | Pending durable input versus live callback across disconnect, owner death and restart | No automatic answer. Duplicate/stale/mismatched/expired/unauthorized answers have no effect. A dead live callback never becomes a durable gate. Full proof waits for #237 integration. |
| R7 | Rotate/revoke each credential layer, reboot supervised host, upgrade/rollback, full removal; scan synthetic secret canaries | Access remains bounded, old credentials fail, owned services stop after removal, and logs/results contain no canaries. Tunnel health alone never reports tool or run completion. |

For R3, grant additional read classes only when the corresponding safe projection exists.
Raw `config.get` and broad plan access are not a way to make a restricted test pass.
The tests must assert no side effects on authorization/preflight failures, not just
check error wording.

## Actual Cal capability proof for #391

**C1 is the minimum positive feasibility evidence.** Casey/Cal must perform it from the
existing conversation/tool environment, with the connection actually selected there.

1. With approved setup, expose a single authenticated fixture read (proposed name
   `private_access_probe`; this is not an existing ORCA tool). Accept only a bounded
   non-secret nonce. Return that nonce, a fixed synthetic target ID and fixture revision.
   No file, shell, URL, ORCA mutation or personal-data access is available.
2. Record the tools that Cal actually discovers and the product's authentication/linking
   result. An app appearing in settings is insufficient if the conversation cannot use it.
3. Give Cal an explicit request to call the fixture with a fresh nonce. Record the actual
   tool invocation/result and matching safe server correlation under the authenticated
   test principal. A prose claim of success or a cached response is not proof.
4. Repeat after a controlled tunnel interruption and restoration; record unavailable
   behavior and a fresh successful read. Revoke/unlink and verify a new nonce cannot be
   served, including from the old session. Restore access only under the approved plan.
5. If the tool cannot be selected or called in that surface, record which prerequisite
   failed and its smallest next action. Do not substitute this coding session, Inspector,
   a CLI, a different ChatGPT surface or a Responses API invocation.

C1 can precede #327 because it uses a fixture. It proves that fixture's authenticated
private path, not production ORCA identity, resource authorization or operator behavior.
#391 also requires review of the proposed ORCA mapping before a positive decision.

## Actual ORCA proof for #393

After #391 is positive, #392 operational acceptance is met and #327's integrated surface
is ready, rerun a harmless authenticated discovery/read against the intended ORCA target
from Cal. Then record one result per original **Cal-facing acceptance** checkbox in
[#327](https://github.com/cschadewitz/Project_Orca/issues/327), using these evidence IDs:

| ID | Original #327 criterion | Deployment-specific evidence required |
| --- | --- | --- |
| C2 | First authenticated harmless read | Actual tool names, verified target/build/protocol, effective grants and safe result from Cal; fixture C1 is not this result. |
| C3 | Investigate pre-existing run | Authorized hierarchy, failed attempt, event pages, final artifacts and effective versioned configuration, with stable IDs; compare history beyond one response. |
| C4 | Preflight, Request and direct workflow | Invalid/stale input creates nothing; valid explicitly authorized flows return distinct stable admission IDs and terminal results. Configuration/version guards are preserved. |
| C5 | Cancel/recover and admission retries | Selected target only; supported recovery, uncertain-response replay under #331 and deliberate rerun remain distinct across adapter restart. Do not invent `runs.retry`. |
| C6 | Pending gate | Exact authorized one-time answer and recorded actor; duplicate, stale, expired and unauthorized attempts have no effect; live owner lifetime preserved. |
| C7 | Safe failures and data handling | Narrow/read-only grants, revocation, wrong workspace, denied artifact, unavailable daemon, truncated pages and secret canaries; prompt-like fixture text cannot induce a write. |
| C8 | Actual tool selection and confirmation | Direct requests, follow-ups using returned IDs and unsupported requests from Cal; record product gaps as blocked. Tool access does not imply standing permission. |

Each mutation class in C4–C6 needs separate user authority and a dedicated test workspace.
Attach safe results to the original criteria rather than closing #327 from a reference
client pass. #393 owns execution and evidence; this plan does not mark any parent criterion
complete or waive a missing safe projection, authority check or integrated foundation.
