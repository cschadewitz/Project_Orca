/** Typed IPC surface for authorized authoring; main/preload registration is owned by integration. */
import type { z } from "zod";
import type { TEMPLATE_METHOD_CONTRACTS } from "@orca/protocol";
import type { BridgeResult } from "./bridge.js";
export type TemplateMethod = keyof typeof TEMPLATE_METHOD_CONTRACTS;
export interface TemplateBridge {
  call<M extends TemplateMethod>(
    method: M,
    params: z.input<(typeof TEMPLATE_METHOD_CONTRACTS)[M]["params"]>,
  ): Promise<BridgeResult<z.output<(typeof TEMPLATE_METHOD_CONTRACTS)[M]["result"]>>>;
}
