/** Authenticated scoped permission adapter; private command authority stays in the daemon. */
import { SCOPED_PERMISSION_CONTRACTS, type ScopedPermissionMethod } from "@orca/protocol";
import type { DaemonClient } from "./daemon-client.js";
export async function callScopedPermission(
  client: Pick<DaemonClient, "call">,
  method: ScopedPermissionMethod,
  params: unknown,
): Promise<unknown> {
  const contract = Object.hasOwn(SCOPED_PERMISSION_CONTRACTS, method) ? SCOPED_PERMISSION_CONTRACTS[method] : undefined;
  if (!contract) throw new Error("Scoped permission method unavailable.");
  return client.call<unknown>(method, contract.params.parse(params), contract.result);
}
