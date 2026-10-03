# Private MCP access: preparation decision

This is the decision entry point for [#401](https://github.com/cschadewitz/Project_Orca/issues/401),
the preparation child of [#391](https://github.com/cschadewitz/Project_Orca/issues/391).
Prepared and official guidance checked on **2026-10-02 UTC**, against main commit
**`7abc2342aa672ee9d2f10d565ca4f8eb546184df`** after fetching `origin/main`.

**Recommendation: BLOCKED for actual Cal access and deployment; proceed with review
of the Secure MCP Tunnel candidate and the isolated probe plan.** No account settings,
credentials, network rules or services were changed. No connection or tool call through
Cal was observed. This preparation can complete without completing #391 or #327.

Read next: [connection design](connection-design.md), [operator checklist](operator-checklist.md),
[acceptance plan](acceptance-plan.md), and [implementation handoff](handoff.md).

## Dated official evidence

These sources were opened on 2026-10-02. They establish a documented product route,
not access in Casey's account. Recheck them before execution; no installed release is
asserted here.

| Source | Relevant documented behavior |
| --- | --- |
| [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) | An outbound client reaches a private MCP server over HTTP or stdio. Creation/editing needs Platform Tunnels Read + Manage; running/selecting needs Read + Use. Developer mode is a separate workspace permission. Associate the target ChatGPT workspace as well as the owning Platform organization; personal accounts use their personal organization. An enterprise association that cannot be verified may require OpenAI review. Egress is HTTPS to `api.openai.com:443` (`mtls.api.openai.com:443` for control-plane mTLS). |
| [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) | Developer-mode connection offers Tunnel selection and discovered-tool review. Inspector checks precede product testing. Availability depends on account/workspace policy. |
| [Authenticate users](https://developers.openai.com/plugins/build/auth) | Authenticated MCP uses OAuth 2.1, protected-resource and authorization-server discovery, resource binding and PKCE. The resource server validates tokens per request. This is not ORCA's existing opaque bearer-token protocol. |
| [Private MCP design explanation](https://developers.openai.com/blog/connect-private-mcp-servers-to-openai-products), published 2026-06-26 | MCP OAuth discovery can traverse the tunnel, but a private authorization server still must be reachable by the component performing OAuth. A tunnel is not general network connectivity. |
| [Plugin management: desktop-only plugins](https://learn.chatgpt.com/docs/enterprise/plugin-management#desktop-only-plugins) | Imported MCP configurations remain desktop-only, including configurations containing remote HTTPS URLs. Importing one does not establish access in Cal's existing conversation. |

## Prerequisite evidence ledger

`Observed` means inspected in this task; `unknown` means no target-environment evidence;
`blocked` identifies a required next step. No unknown below counts as a pass.

| ID | Prerequisite | Status and evidence | Who resolves it / smallest next step |
| --- | --- | --- | --- |
| P1 | Exact Cal surface and existing conversation | **Unknown.** Issue #391 identifies the intended assistant, but provides no client version, surface or enabled-tool observation. This coding session is not Cal proof. | Casey/Cal record the actual product surface/version and whether that conversation can select the connection. |
| P2 | Target account plan and workspace policy | **Unknown.** No account or admin settings inspected. Do not infer eligibility from a generic plan name. | Casey/workspace admin verify developer-mode and private app permissions under the current policy. |
| P3 | Owning Platform organization and tunnel roles | **Unknown.** No organization, role or runtime credential inspected. | Casey/Platform admin verify the distinct creation and runtime roles in the source table. |
| P4 | Workspace association and Tunnel control | **Unknown.** No association or available-tunnel list observed. | Admin verifies the intended organization/workspace pairing; Cal verifies the connection control in P1. If missing, record the exact product/permission gap. |
| P5 | Approved bridge host and private endpoint | **Unknown.** Repository worktree location proves neither deployment location nor private routing. | Casey selects colocated host by default; approve a private hop only if needed. |
| P6 | Egress, TLS and authorization-server reachability | **Unknown.** Reading public docs from this workspace is not a bridge network test. | Host operator records DNS/TLS/egress and OAuth reachability from the actual participating components. |
| P7 | Supported client build and transport | **Unknown.** No tunnel binary installed or tested. | Implementation owner records selected release, source/checksum, host platform and HTTP compatibility. |
| P8 | Authenticated user-to-ORCA binding | **Blocked on design verification.** Main has bearer authentication, not a proven Cal OAuth-to-principal mapping. | #327 owner verifies the chain in [connection design](connection-design.md); Casey approves the issuer, subject mapping and scope. |
| P9 | Access to selected existing runs | **Observed limitation; grant unapproved.** Main offers root-workflow filtering plus `all`/`owned`, not a run-ID allowlist. | Casey approves the exact workflow-wide read envelope or keeps this blocked; see the scope decision below. |
| P10 | Setup authority and harmless actual-Cal call | **Blocked pending separate setup approval and P1–P8.** No probe executed. | Casey authorizes the concrete setup and Cal performs C1 in the [acceptance plan](acceptance-plan.md). |

## Repository evidence and scope decision

The [integrated runtime foundation](../../runtime-foundation-integration.md) is on the
pinned main commit. [Principal definitions](../../../packages/daemon/src/auth/principal.ts),
[resource checks](../../../packages/daemon/src/auth/resources.ts),
[credential lifecycle](../../../packages/daemon/src/auth/credentials.ts), and
[transport enforcement](../../../packages/daemon/src/auth/transport.ts) are shipped
foundations even though the broader #328 issue remains open.

For initial inspection, propose an explicit credential with only `runs.read`,
`artifacts.read` and `workflows.read`, scope `workflows: [approved root workflow IDs]`,
`runs: "all"`, and a finite expiry. This includes pre-existing/unowned runs and descendants
of those roots. It also includes **every other run, including future runs, of those root
workflows**. Casey must approve that actual envelope. A request for selected run IDs only
remains blocked on a finer scope contract under #327/#328; filtering in the UI is not
authorization. An isolated test workspace is suitable for the probe but does not substitute
for access to the user's selected production history.

The `client` preset is owned-runs-only by default and grants writes. The `viewer` preset
includes workspace-wide `plan.read` and `agents.read`; narrowing its workflow scope is
refused. Neither is the proposed grant. The library accepts explicit permission lists,
but [the CLI](../../../packages/cli/src/commands/auth.ts) currently accepts presets only.
An approved provisioning implementation is needed; do not invent a CLI flag, edit the
credential store by hand, or borrow the bootstrap owner token.

[PR #397](https://github.com/cschadewitz/Project_Orca/pull/397) was **open, unmerged** when
inspected on 2026-10-02. Its Request/generation/target/live-gate integration is pending,
not a main dependency imported by this preparation. In particular, do not claim its
authenticated target identity or safe configuration projection already exists here.
No inbound MCP implementation was found in the pinned source; #327 owns that work.

## Decision gates

- **GO for #391 only:** P1–P10 have safe evidence, the identity/scope review passes, and
  Cal's actual conversation performs the authenticated fixture read C1. This permits
  proposing #392 setup; it does not itself authorize deployment or any ORCA mutation.
- **BLOCKED (current):** an account, client, identity, network or approval prerequisite
  is unknown/missing. Record its owner and next action. Documentation or Inspector
  success cannot upgrade this result.
- **NO-GO for this candidate:** the actual surface cannot consume the private connection,
  or the route cannot preserve verified identity and current resource authorization.
  Return the evidence to Casey. Do not substitute a public listener, owner credential,
  imported plugin, Responses API script, desktop CLI or temporary Cal Tailscale session.

The complete operator contract remains [#327](https://github.com/cschadewitz/Project_Orca/issues/327).
The harmless fixture proof in #391 and the full ORCA proof in
[#393](https://github.com/cschadewitz/Project_Orca/issues/393) are separate milestones of evidence.
