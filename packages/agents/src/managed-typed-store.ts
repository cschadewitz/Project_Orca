/** Internal retained owner identity. No marker/JSON/client input manufactures a binding. */
import { isDeepStrictEqual } from "node:util";
import { OrcaError } from "@orca/core";
import {
  createInactiveTypedSidecarStore,
  retainedTypedSidecarOwner,
  type InactiveTypedSidecarOwner,
  type InactiveTypedSidecarStore,
} from "./typed-sidecar.js";

declare const bindingBrand: unique symbol;
export interface ManagedTypedStoreBinding {
  readonly [bindingBrand]: true;
  readonly store: InactiveTypedSidecarStore;
  readonly workspaceRef: string;
  readonly rootBindingRef: string;
  readonly enrollmentRef: string;
  /** Retained original owner assertion, never a cached read or parsed marker. */
  assertCurrent(this: void): undefined;
}
export type ManagedTypedStoreAvailability =
  | { readonly available: false; readonly reason: "trusted-linux-owner-unavailable" }
  | {
      readonly available: true;
      readonly contract: "orca-typed-sidecar-v1";
      readonly binding: ManagedTypedStoreBinding;
      readonly store: InactiveTypedSidecarStore;
    };
export type ManagedTypedStoreProvider = () => Promise<ManagedTypedStoreAvailability>;
export const unavailableManagedTypedStore: ManagedTypedStoreProvider = () =>
  Promise.resolve({ available: false, reason: "trusted-linux-owner-unavailable" });

const bindings = new WeakMap<InactiveTypedSidecarOwner, ManagedTypedStoreBinding>();
const issued = new WeakSet<object>();
export function assertManagedTypedStoreBinding(binding: ManagedTypedStoreBinding): undefined {
  if (!issued.has(binding) || binding.assertCurrent() !== undefined) unavailable();
  return undefined;
}
function unavailable(): never {
  throw new OrcaError("NOT_SUPPORTED", "original managed typed owner unavailable");
}
/** Only the original trusted owner may supply its synchronous lifetime assertion.
 * Marker is a consistency binding, never proof of ownership. Identity alone is cached.
 */
export function managedTypedStoreProvider(owner: InactiveTypedSidecarOwner): ManagedTypedStoreProvider {
  const { marker: original, assertCurrent, checkCurrent } = retainedTypedSidecarOwner(owner);
  if (original.state !== "enrolled") unavailable();
  const store = createInactiveTypedSidecarStore(owner);
  let binding = bindings.get(owner);
  if (!binding) {
    binding = Object.freeze({
      store,
      workspaceRef: original.workspaceRef,
      rootBindingRef: original.rootBindingRef,
      enrollmentRef: original.enrollmentRef,
      assertCurrent,
    }) as ManagedTypedStoreBinding;
    issued.add(binding);
    bindings.set(owner, binding);
  }
  if (
    binding.store !== store ||
    !isDeepStrictEqual(
      [binding.workspaceRef, binding.rootBindingRef, binding.enrollmentRef],
      [original.workspaceRef, original.rootBindingRef, original.enrollmentRef],
    )
  )
    unavailable();
  const retained = binding;
  return async () => {
    try {
      assertManagedTypedStoreBinding(retained);
      // Policy reads/mutations perform their own fresh byte/lock checks. Do not
      // attempt an unlocked read here while the same retained writer holds its lock.
      await checkCurrent();
      assertManagedTypedStoreBinding(retained);
      return { available: true, contract: "orca-typed-sidecar-v1", binding: retained, store };
    } catch {
      return { available: false, reason: "trusted-linux-owner-unavailable" };
    }
  };
}
