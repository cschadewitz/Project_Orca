/** One opaque daemon boot identity, shared by every transport. */
import { randomUUID } from "node:crypto";
/** Construct once per startDaemon, then share across HTTP and WebSocket hello. */
export function createDaemonIdentity(workspaceId: string): { workspaceId: string; instanceId: string } {
  return { workspaceId, instanceId: randomUUID() };
}
