/** Explicit opt-in launcher interface, with fixed sources and no ORCA/tunnel/credential dependency. */
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { MaintenanceBackend } from "./backend.js";
import { LinuxObservationAdapter } from "./linux-observer.js";
import { LIMITS } from "./policy.js";
import { createMaintenanceServer } from "./server.js";

export function serveLinuxMaintenanceStdio(options: { input?: Readable; output?: Writable } = {}) {
  const backend = new MaintenanceBackend(new LinuxObservationAdapter());
  return serveStdio(() => createMaintenanceServer(backend), {
    transport: new StdioServerTransport(options.input, options.output, { maxBufferSize: LIMITS.wireBufferBytes }),
    maxSubscriptions: 0,
    onerror: () => {},
  });
}
