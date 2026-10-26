/** Authenticated scoped permission adapter; private command authority stays in the daemon. */
import type { z } from "zod";
import type { SCOPED_PERMISSION_CONTRACTS, ScopedPermissionMethod } from "@orca/protocol";
import type { BridgeResult } from "./bridge.js";
export interface ScopedPermissionBridge {
  call<M extends ScopedPermissionMethod>(
    method: M,
    params: z.input<(typeof SCOPED_PERMISSION_CONTRACTS)[M]["params"]>,
  ): Promise<BridgeResult<z.output<(typeof SCOPED_PERMISSION_CONTRACTS)[M]["result"]>>>;
}
