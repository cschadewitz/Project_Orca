/** Workspace-transition routes: recheck caller lifetime before writes/activation, never against the old epoch afterward. */
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { BridgeResult } from "../../bridge.js";
import type { FirstRunStatus } from "../../first-run-contract.js";
import type { FirstRunSetup } from "./setup.js";
import { FirstRunOwnershipRefusal } from "./ownership.js";
import { FirstRunRefusal, PRESERVED } from "./refusal.js";

const UPDATE_HELD = `An app update is being prepared, so setup is paused. Retry once the update finishes or is cancelled. ${PRESERVED}`;
const CALLER_CHANGED = `This window or its workspace connection changed while setup was working. Read setup again, then retry. ${PRESERVED}`;
const UNEXPECTED = `Project setup was refused for a reason it could not identify. Read setup again, then retry or choose a fresh empty workspace. ${PRESERVED}`;

/**
 * What the person sees when a setup route refuses. Setup's own refusals were written for the screen and pass as they
 * are; so does the ownership refusal. Anything else is a raw failure whose text may hold paths or tool output, and it
 * is replaced, never shown.
 */
export function refusalMessage(error: unknown): string {
  if (error instanceof FirstRunOwnershipRefusal || error instanceof FirstRunRefusal) return error.message;
  return UNEXPECTED;
}

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
          const captured = boundary.capture(event, epoch);
          // The caller's window, connection epoch or update reservation moved: a reason the person can act on.
          const check = () => {
            try {
              captured();
            } catch (error) {
              if (error instanceof FirstRunOwnershipRefusal || error instanceof FirstRunRefusal) throw error;
              throw new FirstRunRefusal(CALLER_CHANGED, { cause: error });
            }
          };
          check();
          if (boundary.held()) throw new FirstRunRefusal(UPDATE_HELD);
          const parsed = schema.safeParse(input);
          if (!parsed.success)
            throw new FirstRunRefusal(
              `This setup request no longer matches what is on screen. Read setup again. ${PRESERVED}`,
            );
          const value: unknown = parsed.data;
          await boundary.ready();
          check();
          if (boundary.held()) throw new FirstRunRefusal(UPDATE_HELD);
          const result = await (boundary.run ? boundary.run(() => run(value, check)) : run(value, check));
          if (method !== "connect") check();
          return { ok: true, result };
        } catch (error) {
          return {
            ok: false,
            error: { code: "AGENT_TRANSPORT", message: refusalMessage(error) },
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
  register("endPreviousSession", z.string().uuid(), (value, check) => setup.endPreviousSession(value as string, check));
  register("reviewConfiguration", z.undefined(), (_value, check) => setup.reviewConfiguration(check));
  register("cancelConfigurationReview", z.undefined(), (_value, check) => setup.cancelConfigurationReview(check));
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
