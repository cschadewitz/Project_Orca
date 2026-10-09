/** Workspace-transition routes: recheck caller lifetime before writes/activation, never against the old epoch afterward. */
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { BridgeResult } from "../../bridge.js";
import type { FirstRunStatus } from "../../first-run-contract.js";
import type { FirstRunSetup } from "./setup.js";
import { FirstRunOwnershipRefusal } from "./ownership.js";

export function installFirstRunIPC(
  setup: FirstRunSetup,
  boundary: {
    ipc: Pick<IpcMain, "handle">;
    ready(): Promise<void>;
    held(): boolean;
    /** Retain app writer ownership through asynchronous receipt/configuration writes. */
    run?<T>(work: () => Promise<T>): Promise<T>;
    /** Capture both the current document/frame and connection epoch. */
    capture(event: IpcMainInvokeEvent, epoch: number): () => void;
    connect(assertCurrent: () => void): Promise<FirstRunStatus>;
  },
): void {
  const register = (
    method: string,
    schema: z.ZodType,
    run: (value: unknown, check: () => void) => Promise<FirstRunStatus>,
  ) => {
    boundary.ipc.handle(
      `orca:workspace.firstRun.${method}`,
      async (event, input: unknown, epoch: number): Promise<BridgeResult<FirstRunStatus>> => {
        try {
          const check = boundary.capture(event, epoch);
          check();
          if (boundary.held()) throw new Error("Update window preparation is in progress");
          const value = schema.parse(input);
          await boundary.ready();
          check();
          if (boundary.held()) throw new Error("Update window preparation is in progress");
          const result = await (boundary.run ? boundary.run(() => run(value, check)) : run(value, check));
          if (method !== "connect") check();
          return { ok: true, result };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "AGENT_TRANSPORT",
              message:
                error instanceof FirstRunOwnershipRefusal
                  ? error.message
                  : "Project setup was refused. Check the current window, directory ownership, access and Git before retrying. Existing files were preserved.",
            },
          };
        }
      },
    );
  };
  register("status", z.undefined(), () => setup.status());
  register("choose", z.undefined(), (_value, check) => setup.choose(check));
  register("prepare", z.string().uuid(), (value, check) => setup.prepare(value as string, check));
  register("prepareRecovery", z.undefined(), (_value, check) => setup.prepareRecovery(check));
  register("reconcileRecovery", z.string().uuid(), (value, check) => setup.reconcileRecovery(value as string, check));
  register("reviewConfiguration", z.undefined(), (_value, check) => setup.reviewConfiguration(check));
  register("bindConfiguration", z.string().uuid(), (value, check) => setup.bindConfiguration(value as string, check));
  register("connect", z.undefined(), (_value, check) => boundary.connect(check));
}

/** Cold startup always verifies the receipt, while explicit remote/environment choices retain precedence. */
export async function startFirstRunWorkspace(
  setup: FirstRunSetup,
  boundary: {
    explicitTarget: boolean;
    connectExplicit(): Promise<void>;
    assertCurrent(): void;
  },
): Promise<void> {
  const status = await setup.status();
  boundary.assertCurrent();
  if (boundary.explicitTarget || status.state !== "prepared") await boundary.connectExplicit();
  else await setup.connect(() => boundary.assertCurrent());
}
