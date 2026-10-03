# Private MCP operator checklist

Execution checklist for the proposed design; **nothing here has been executed**. Use
[decision.md](decision.md) for the pinned source, current BLOCKED result and evidence
ledger. The five-document preparation is authorized; account changes and deployment
are not. This distinction comes from [#401](https://github.com/cschadewitz/Project_Orca/issues/401)
and [#391](https://github.com/cschadewitz/Project_Orca/issues/391).

Tags mark separate execution approvals: **CREDENTIAL**, **NETWORK**, **PERSISTENT ACCESS**,
and **DEPLOYMENT**. A future approval request must name the concrete target, scope,
lifetime, owner, affected settings and removal procedure. Do not ask Casey to approve
an unspecified installation. This checklist is the preparation for that request.

## Inventory and prepare without changing access

- [ ] Casey/Cal record P1–P4 in the decision ledger using non-secret evidence. Check the
  actual conversation's connection controls, not another account/client's controls.
- [ ] Host operator identifies a candidate host, OS/architecture, service account,
  private adapter endpoint, approved issuer and secret-delivery mechanism. Select
  colocation unless there is a concrete reason for the optional private hop.
- [ ] Implementation owner checks the dated official sources again and records any
  changed prerequisite. Obtain the tunnel client through the guide's release link;
  record the chosen version, immutable artifact checksum/provenance and compatibility
  results before proposing installation. Do not silently track new versions at restart.
- [ ] #327 owner prepares a synthetic read-only fixture, identity-mapping tests and the
  explicit permission provisioning path. No production data or owner token is needed.
- [ ] Casey reviews the exact existing-run envelope, including other/future runs of
  the approved root workflows. If unacceptable, retain P9 as blocked.

## Separately approved setup, in order

| Step | Execution approval | Operator and required result |
| --- | --- | --- |
| S1 | **PERSISTENT ACCESS** | Workspace/Platform administrators approve and configure only P2–P4's required roles, association and private connection. Record who can remove each. Missing product controls stop the setup. |
| S2 | **CREDENTIAL** | Platform administrator provisions the runtime credential using approved secret delivery. Keep it separate from MCP user and ORCA credentials; no secret in instructions, source, shell history, process arguments or evidence. |
| S3 | **CREDENTIAL**, **PERSISTENT ACCESS** | Application/ORCA administrator provisions the approved OAuth linkage, subject-to-principal mapping and finite-lived explicit read grant. Review both issuer and daemon revocation. The CLI preset limitation is in decision.md; never work around it with an owner preset. |
| S4 | **NETWORK** | Host operator verifies approved egress and private reachability, TLS trust and OAuth endpoints. Any proxy/firewall/ACL change or private hop needs an exact rule and rollback. Record listener observations proving no new public ingress. |
| S5 | **DEPLOYMENT** | Start only the approved fixture/adapter and client build, with one pinned private destination and restricted diagnostics. Use the selected release's documented diagnostics; record health separately from authentication and tool-call success. |
| S6 | **PERSISTENT ACCESS** | Casey connects the private app in the intended workspace; Cal inspects discovered tools in the existing conversation. Complete C1 before any claim of positive #391 feasibility. |
| S7 | **DEPLOYMENT**, **PERSISTENT ACCESS** | Only after a reviewed positive #391 decision, #392 may install the approved supervised service and test restart/reboot/recovery/removal. Freeze service/config ownership and secret access first. |

S5 can test transport against an authenticated synthetic endpoint while #327 is pending.
A fixture without user authentication can diagnose transport but cannot pass the
authenticated C1 gate. Failure to find a usable issuer or authenticate Cal stays blocked.

## Validation and evidence

- [ ] Run the reference-client matrix R1–R7 and actual-Cal C1 from
  [acceptance-plan.md](acceptance-plan.md). Mark unexecuted cases blocked/not run.
- [ ] For real ORCA, record build SHA, protocol version, selected target identity,
  scope, transport, fixture version and client release. Compare identity before data
  access, after reconnect and after adapter/daemon restart.
- [ ] Inspect diagnostics and evidence for credentials, raw launch inputs, private
  paths and protected content before sharing. Keep operational secrets only in the
  approved secret store. Do not expose the local admin interface publicly.
- [ ] #392 tests bounded reconnect, rotation and uncertain-response behavior with
  fixtures; #393 executes the full #327 matrix with separately authorized mutations.
  A healthy service is not evidence of a completed ORCA operation.

## Stop, revoke and remove

Include this teardown in the setup approval so the operator can remove precisely the
access created for the test. If scope changes, seek separate approval for the new action.

1. Record pending request/admission IDs and their honest state, then stop/disable the
   owned bridge service so it cannot restart and dispatch more calls. Do not replay an
   uncertain write. Stopping the bridge does not cancel an admitted ORCA run.
2. **CREDENTIAL / PERSISTENT ACCESS:** the app administrator unlinks/revokes the MCP
   connection and OAuth access, removes its subject mapping, and the ORCA administrator
   revokes its dedicated ORCA credentials. Test denial on a fresh call, existing session
   and replay. Preserve safe audit records; do not delete ORCA runs or stores.
3. **CREDENTIAL / PERSISTENT ACCESS:** the Platform administrator revokes the dedicated
   runtime key and removes the test tunnel/associations that this setup owns. Do not
   revoke unrelated applications' shared credentials or workspace roles. For shared
   resources, remove only this grant and verify this connection can no longer use it.
4. **DEPLOYMENT / NETWORK:** remove the owned service/configuration and secret material
   using the approved mechanism. Revert only rules added by S4. Leave unrelated tailnet
   membership, firewall policy, ORCA state and other services intact.
5. Verify no owned process/listener remains, old credentials are denied and Cal can no
   longer call the tool. Record cleanup evidence and any unresolved access; stopping a
   process alone is not credential revocation.

For an upgrade rollback, stop the service, preserve safe diagnostics, restore the previous
verified binary and non-secret configuration, and recheck identity/authentication before
resuming. Never restore revoked credentials or re-enable old broader grants from a backup.
The #392 owner must verify rollback compatibility and rehearse this procedure before
claiming an operational bridge.
