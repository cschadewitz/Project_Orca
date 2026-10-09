/** Retain template drafts above Config navigation, reusing its invalidations and the one announcement channel. */
import { createContext, useContext, useEffect, useReducer, useRef, type JSX, type ReactNode } from "react";
import type { ConfigFeed } from "../config/use-config.js";
import { currentEditorTarget, sameEditorTarget } from "../config/configuration-adapter.js";
import { useUpdateDraft } from "../update-drafts.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { useNotifications } from "../notifications-context.js";
import { TemplateAdapter } from "./adapter.js";
import { TemplateAuthoringController } from "./controller.js";
import type { AuthoringSnapshot } from "./model.js";
export interface TemplateStudio {
  adapter: TemplateAdapter;
  controller: TemplateAuthoringController;
  current: AuthoringSnapshot;
  refresh(): Promise<void>;
}
const Context = createContext<{ studio?: TemplateStudio; error?: string; version: number }>({ version: 0 });
export function TemplateStudioProvider({ feed, children }: { feed: ConfigFeed; children: ReactNode }): JSX.Element {
  const owned = useRef<TemplateStudio | undefined>(undefined);
  const error = useRef<string | undefined>(undefined);
  const ticket = useRef(0);
  const [version, change] = useReducer((value: number) => value + 1, 0);
  const announce = useAnnounce();
  const stream = useNotifications();
  const lastMessage = useRef<string | undefined>(undefined);
  const source = feed.state;
  useUpdateDraft(
    Boolean(
      owned.current &&
      (owned.current.controller.getSnapshot().edits.length || owned.current.controller.getSnapshot().busy),
    ),
  );
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const target = currentEditorTarget(window.orca);
      const transport = window.orca.templates;
      const connection = window.orca.connection.read();
      const old = owned.current;
      if (old) old.refresh = refresh;
      if (old && (!sameEditorTarget(target, old.adapter.target) || !connection.methods?.includes("templates.get"))) {
        old.current = {
          ...old.current,
          target: target ?? { workspaceId: "", instanceId: "", epoch: -1 },
          assets: old.current.assets.map((asset) => ({ ...asset, source: { state: "withheld" } })),
          writeReason: "Source authority or daemon target changed. Restore access and reconcile.",
        };
        old.controller.observe(old.current);
        change();
        return;
      }
      if (!target || !transport || connection.state !== "live" || !connection.methods?.includes("templates.get"))
        return;
      const operation = ++ticket.current;
      try {
        const adapter = old?.adapter ?? new TemplateAdapter(target, window.orca, transport);
        adapter.onAuthorityRefusal = () => {
          const held = owned.current;
          if (!alive || !held) return;
          held.current = {
            ...held.current,
            assets: held.current.assets.map((asset) => ({ ...asset, source: { state: "withheld" } })),
            writeReason: "Source authority was refused. Restore access and read current sources.",
          };
          held.controller.observe(held.current);
          change();
        };
        const snapshot = await adapter.read();
        if (!alive || operation !== ticket.current) return;
        if (old) {
          old.current = snapshot;
          const state = old.controller.getSnapshot();
          const ownPendingSave =
            state.busy &&
            state.saving &&
            snapshot.generation === state.base.generation &&
            snapshot.contextRevision === state.base.contextRevision &&
            snapshot.writeReason === state.base.writeReason &&
            state.edits.length === 1 &&
            snapshot.assets.every((asset) => {
              const edit = state.edits.find((item) => item.key === asset.key);
              const before = state.base.assets.find((item) => item.key === asset.key);
              return (
                asset.source.state === "available" &&
                (edit
                  ? asset.source.text === edit.text
                  : before?.source.state === "available" && asset.source.text === before.source.text)
              );
            }) &&
            state.base.assets.every((asset) => snapshot.assets.some((current) => current.key === asset.key)) &&
            state.edits.every((edit) =>
              snapshot.assets.some(
                (asset) =>
                  asset.key === edit.key && asset.source.state === "available" && asset.source.text === edit.text,
              ),
            );
          if (ownPendingSave) {
            /* The exact source echo can precede its receipt; keep the pending operation alive. */
          } else if (state.edits.length || state.busy || state.blocked) old.controller.observe(snapshot);
          else old.controller.reconcile(snapshot, false);
        } else
          owned.current = {
            adapter,
            controller: new TemplateAuthoringController(snapshot, adapter),
            current: snapshot,
            refresh,
          };
        error.current = undefined;
        change();
      } catch {
        if (!alive || operation !== ticket.current) return;
        error.current = "Template catalog unavailable. Restore source authority and read current state before editing.";
        if (old) {
          old.current = {
            ...old.current,
            assets: old.current.assets.map((asset) => ({ ...asset, source: { state: "withheld" } })),
            writeReason: error.current,
          };
          old.controller.observe(old.current);
        }
        change();
      }
    };
    void refresh();
    const connectionOff = window.orca.connection.subscribe(() => {
      void refresh();
    });
    const targetOff = window.orca.daemonConnection?.subscribe(() => {
      void refresh();
    });
    const sourceOff = stream.on("config.changed", (params) => {
      if (params.document === "config") void refresh();
    });
    return () => {
      alive = false;
      ticket.current++;
      connectionOff();
      targetOff?.();
      sourceOff();
    };
  }, [source, stream]);
  const studio = owned.current;
  useEffect(() => {
    if (!studio) return;
    return studio.controller.subscribe(() => {
      change();
      const state = studio.controller.getSnapshot();
      const message = state.blocked ?? state.message;
      if (message && message !== lastMessage.current) announce(message);
      lastMessage.current = message;
    });
  }, [studio, announce]);
  return (
    <Context.Provider
      value={{ ...(studio ? { studio } : {}), ...(error.current ? { error: error.current } : {}), version }}
    >
      {children}
    </Context.Provider>
  );
}
export function useTemplateStudio() {
  return useContext(Context);
}
