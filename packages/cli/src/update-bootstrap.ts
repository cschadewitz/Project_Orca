/** Participating CLI lifetime ownership, before any bootstrap/migration/auth writer. */
import { configuredUpdateWriterRoots, enterUpdateWriter, type UpdateWriterLease } from "@orca/protocol/update-window";
import { resolve } from "node:path";

const attempt = process.env.ORCA_UPDATE_ATTEMPT;
const token = process.env.ORCA_UPDATE_LAUNCH;
delete process.env.ORCA_UPDATE_ATTEMPT;
delete process.env.ORCA_UPDATE_LAUNCH;
const launch = attempt && token ? { attempt, token } : undefined;
const invalid = Boolean(attempt || token) && !launch;
const owners = new Map<string, Promise<UpdateWriterLease | undefined>>();
export const isClosedUpdateBootstrap = () => Boolean(launch);
export function assertClosedUpdateCommand(command: string, flags: Record<string, unknown>): void {
  if (
    invalid ||
    (launch && (command !== "serve" || !flags["read-only"] || !flags["no-resume"] || flags["unauthenticated-loopback"]))
  )
    throw new Error("Closed replacement bootstrap requires authenticated read-only validation");
}
export async function enterConfiguredUpdateBootstrap(configDir: string, storeDir: string): Promise<void> {
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
  }
  if (launch && !roots.length) throw new Error("Protected replacement writer unavailable");
  // No release API is returned to the runtime. Kernel slots survive until process exit.
}
