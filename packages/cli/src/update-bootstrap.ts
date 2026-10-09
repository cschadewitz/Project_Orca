/** Participating CLI lifetime ownership, before any bootstrap/migration/auth writer. */
import {
  configuredUpdateWriterRoots,
  enterUpdateWriter,
  updateAdmissionOpen,
  updateExistingWorkAllowed,
  type UpdateWriterLease,
  enrollUpdateWindowRoots,
} from "@orca/protocol/update-window";
import { resolve, isAbsolute, basename } from "node:path";
import { createRequire } from "node:module";

const attempt = process.env.ORCA_UPDATE_ATTEMPT;
const token = process.env.ORCA_UPDATE_LAUNCH;
const managedControl = process.env.ORCA_MANAGED_UPDATE_CONTROL;
const managedAddon = process.env.ORCA_MANAGED_UPDATE_ADDON;
delete process.env.ORCA_UPDATE_ATTEMPT;
delete process.env.ORCA_UPDATE_LAUNCH;
delete process.env.ORCA_MANAGED_UPDATE_CONTROL;
delete process.env.ORCA_MANAGED_UPDATE_ADDON;
const launch = attempt && token ? { attempt, token } : undefined;
const invalid = Boolean(attempt || token) && !launch;
const owners = new Map<string, Promise<UpdateWriterLease | undefined>>();
const activeOwners = new Map<string, UpdateWriterLease>();
/** Live dispatch must observe durable closure before the runtime-drain RPC arrives. */
export function configuredUpdateAdmissionOpen(): boolean {
  if (launch || invalid) return false;
  for (const [root, lease] of activeOwners) if (!lease.check() || !updateAdmissionOpen(root)) return false;
  return true;
}
export function configuredUpdateExistingWorkOpen(): boolean {
  if (invalid || (launch && !activeOwners.size)) return false;
  for (const [root, lease] of activeOwners)
    if (!lease.check() || (!launch && !updateExistingWorkAllowed(root))) return false;
  return true;
}
export const isClosedUpdateBootstrap = () => Boolean(launch);
export function assertClosedUpdateCommand(command: string, flags: Record<string, unknown>): void {
  if (
    invalid ||
    (launch && (command !== "serve" || !flags["read-only"] || !flags["no-resume"] || flags["unauthenticated-loopback"]))
  )
    throw new Error("Closed replacement bootstrap requires authenticated read-only validation");
}
export async function enterConfiguredUpdateBootstrap(configDir: string, storeDir: string): Promise<void> {
  if (managedControl || managedAddon) {
    if (
      launch ||
      process.platform !== "darwin" ||
      !managedControl ||
      !managedAddon ||
      !isAbsolute(managedControl) ||
      resolve(managedControl) !== managedControl ||
      !isAbsolute(managedAddon) ||
      basename(managedAddon) !== "diagnostics_storage.node"
    )
      throw new Error("Managed update enrollment unavailable");
    // Main supplies the packaged fixed native location. No fallback, download or child
    // inheritance; unsupported external launchers cannot enroll roots by omission.
    const backend = createRequire(import.meta.url)(managedAddon) as Record<string, unknown>;
    const own = (key: string) => Object.getOwnPropertyDescriptor(backend, key)?.value as unknown;
    const flush = own("flushDescriptorSync");
    if (
      own("abi") !== 1 ||
      own("platform") !== "darwin" ||
      own("replacementStorage") !== 1 ||
      typeof flush !== "function"
    )
      throw new Error("Managed update enrollment unavailable");
    await enrollUpdateWindowRoots(managedControl, [resolve(configDir), resolve(storeDir)], {
      fileSync: flush as (fd: number) => void,
    });
  }
  await enterCommandUpdateBootstrap([configDir, storeDir]);
}
export async function closedUpdateOwnsConfiguredRoots(configDir: string, storeDir: string): Promise<boolean> {
  if (!launch) return false;
  const roots = configuredUpdateWriterRoots([configDir, storeDir]);
  if (!roots.length) return false;
  for (const root of roots) {
    const lease = await owners.get(root);
    if (!lease?.check()) return false;
  }
  return true;
}
export async function enterCommandUpdateBootstrap(paths: readonly string[]): Promise<void> {
  if (invalid) throw new Error("Closed replacement bootstrap unavailable");
  const roots = configuredUpdateWriterRoots(paths.map((path) => resolve(path)));
  for (const root of roots) {
    let operation = owners.get(root);
    if (!operation) {
      operation = enterUpdateWriter(root, launch);
      owners.set(root, operation);
    }
    const lease = await operation;
    if (!lease?.check()) throw new Error("Protected replacement writer unavailable");
    activeOwners.set(root, lease);
  }
  if (launch && !roots.length) throw new Error("Protected replacement writer unavailable");
  // No release API is returned to the runtime. Kernel slots survive until process exit.
}
