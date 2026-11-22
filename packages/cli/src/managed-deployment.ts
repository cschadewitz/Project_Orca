/**
 * What `orca serve` reports about the managed server updater that launched it (#879).
 *
 * `orca-release.py` (Debian, docs/UPDATING.md) launches the managed daemon with the paths of
 * itself and of its deployment manifest, and the ring the deployment follows when it names
 * one. The daemon passes them on in `hello.deployment` so the app can run that updater over
 * the person's own SSH connection. Nothing here runs or reads the updater: these are strings
 * from the launching process, checked against the same schema the app checks them with, and
 * a daemon launched any other way has none of them and reports nothing.
 */
import { ManagedDeploymentSchema, type ManagedDeployment } from "@orca/protocol";

export const DEPLOYMENT_ADAPTER_ENV = "ORCA_DEPLOYMENT_ADAPTER";
export const DEPLOYMENT_MANIFEST_ENV = "ORCA_DEPLOYMENT_MANIFEST";
export const DEPLOYMENT_RING_ENV = "ORCA_DEPLOYMENT_RING";

/** The managed deployment from the launch environment, or `undefined` when there is none or it is malformed. */
export function managedDeployment(env: NodeJS.ProcessEnv): ManagedDeployment | undefined {
  const adapter = env[DEPLOYMENT_ADAPTER_ENV];
  const manifest = env[DEPLOYMENT_MANIFEST_ENV];
  if (!adapter || !manifest) return undefined;
  const ring = env[DEPLOYMENT_RING_ENV];
  const parsed = ManagedDeploymentSchema.safeParse({ kind: "managed", adapter, manifest, ...(ring ? { ring } : {}) });
  return parsed.success ? parsed.data : undefined;
}
