/** Validated authoring RPC caller for main's pinned IPC handoff; accepts only the closed method inventory. */
import { TEMPLATE_METHOD_CONTRACTS } from "@orca/protocol";
import type { TemplateMethod } from "../template-bridge.js";
import type { DaemonClient } from "./daemon-client.js";
export async function callTemplate(
  client: Pick<DaemonClient, "call">,
  method: TemplateMethod,
  params: unknown,
): Promise<unknown> {
  const contract = Object.hasOwn(TEMPLATE_METHOD_CONTRACTS, method) ? TEMPLATE_METHOD_CONTRACTS[method] : undefined;
  if (!contract) throw new Error("Template method unavailable.");
  const parsed = contract.params.parse(params);
  // The runtime discriminator binds params and result; no arbitrary generic renderer RPC.
  return client.call<unknown>(method, parsed, contract.result);
}
