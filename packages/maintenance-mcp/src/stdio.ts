/** SDK stdio only. No listener, credentials, host access, launcher or automatic activation. */
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { MaintenanceBackend } from "./backend.js";
import { LIMITS } from "./policy.js";
import { createMaintenanceServer } from "./server.js";

export function serveMaintenanceStdio(options: { input?: Readable; output?: Writable } = {}) {
  const backend = new MaintenanceBackend();
  return serveStdio(() => createMaintenanceServer(backend), {
    transport: new StdioServerTransport(options.input, options.output, { maxBufferSize: LIMITS.wireBufferBytes }),
    maxSubscriptions: 0,
    // SDK exceptions may include untrusted message bodies. Do not persist or echo them.
    onerror: () => {},
  });
}
