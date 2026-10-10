/** Persistent launch session above surface navigation; push/reconnect invalidation, never polling. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import type { RetainedLaunch } from "../../../src/configuration-launch-contract.js";
import { useNotifications } from "../notifications-context.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { useUpdateDraft } from "../update-drafts.js";
import { runUrl } from "../route-table.js";
import { GuidedLaunchController, launchReceipt } from "./controller.js";
import type { LaunchContext } from "./contracts.js";
import { CONFIGURED_ROOT, launchContext, productionPorts, unwrap } from "./production-bindings.js";

interface Session {
  controller?: GuidedLaunchController;
  retained: readonly RetainedLaunch[];
  selected: string;
  select: (id: string) => void;
  message: string;
  refresh: () => void;
}
const Context = createContext<Session | undefined>(undefined);
export function GuidedLaunchProvider({
  active,
  onOpen,
  children,
}: {
  active: boolean;
  onOpen: (url: string) => void;
  children: ReactNode;
}): JSX.Element {
  const stream = useNotifications();
  const announce = useAnnounce();
  const owned = useRef<GuidedLaunchController | undefined>(undefined);
  const current = useRef<LaunchContext | undefined>(undefined);
  const selection = useRef("");
  const navigate = useRef(onOpen);
  navigate.current = onOpen;
  const revision = useRef(0);
  const [, change] = useReducer((v: number) => v + 1, 0);
  const [message, setMessage] = useState("Read the authorized target before launching.");
  const [retained, setRetained] = useState<readonly RetainedLaunch[]>([]);
  const refresh = useCallback(async () => {
    const bridge = window.orca.guidedLaunch;
    const token = ++revision.current;
    setRetained([]);
    selection.current = "";
    if (current.current && owned.current) {
      current.current = {
        ...current.current,
        unavailableReason: "Reading the current authorized connection. Your original draft is retained.",
      };
      owned.current.contextChanged(current.current);
    }
    if (!bridge || window.orca.connection.read().state !== "live") {
      setMessage(
        "Connect a writable local daemon, then configure and apply an explicit prepared project checkout. No work has been started.",
      );
      return;
    }
    try {
      const snapshot = unwrap(await bridge.snapshot());
      if (token !== revision.current) return;
      const target = window.orca.daemonConnection?.read();
      if (
        target &&
        (target.epoch !== snapshot.target.epoch ||
          !target.identity ||
          target.identity.workspaceId !== snapshot.target.workspaceId ||
          target.identity.instanceId !== snapshot.target.instanceId)
      )
        return;
      current.current = launchContext(snapshot);
      if (owned.current) owned.current.contextChanged(current.current);
      else
        owned.current = new GuidedLaunchController(
          current.current,
          { mode: "direct", rootId: CONFIGURED_ROOT, workflowId: "", vars: {}, title: "", body: "" },
          productionPorts(bridge, {
            current: () => current.current!,
            selectedIntent: () => selection.current,
            live: () => window.orca.connection.read().state === "live",
            announce,
            navigate: (receipt) => navigate.current(runUrl(receipt.runId)),
          }),
        );
      setMessage("");
      change();
      const handles = unwrap(await bridge.retained());
      if (token === revision.current) setRetained(handles);
    } catch {
      if (token === revision.current)
        setMessage(
          "Guided launch could not verify this target. Check connection, configuration and checkout, then read again. Your original draft is retained.",
        );
    }
  }, [announce]);
  useEffect(() => {
    if (!active && !owned.current) return;
    void refresh();
    const connectionOff = window.orca.connection.subscribe(() => {
      void refresh();
    });
    const targetOff = window.orca.daemonConnection?.subscribe(() => {
      void refresh();
    });
    const configOff = stream.on("config.changed", () => {
      void refresh();
    });
    const workflowOff = stream.on("workflows.changed", () => {
      void refresh();
    });
    return () => {
      revision.current++;
      connectionOff();
      targetOff?.();
      configOff();
      workflowOff();
    };
  }, [active, refresh, stream]);
  const controller = owned.current;
  useEffect(() => controller?.subscribe(change), [controller]);
  const state = controller?.read();
  const receipt = state?.result === undefined ? undefined : launchReceipt(state.result);
  const admitted = receipt?.state === "accepted" && (state?.draft.mode === "request") === "requestId" in receipt;
  useUpdateDraft(
    !!state &&
      (state.busy ||
        state.unresolvedReview !== undefined ||
        (state.intent !== undefined && !admitted) ||
        (state.intent === undefined && state.sequence > 0)),
  );
  const select = (id: string) => {
    selection.current = id;
    change();
  };
  return (
    <Context.Provider
      value={{
        ...(controller ? { controller } : {}),
        retained,
        selected: selection.current,
        select,
        message,
        refresh: () => {
          void refresh();
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useGuidedLaunch(): Session {
  const session = useContext(Context);
  if (!session) throw new Error("Guided launch requires its persistent session provider.");
  return session;
}
