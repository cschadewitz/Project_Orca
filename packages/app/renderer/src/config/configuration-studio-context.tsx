/** The structured/raw session outlives surface navigation and shares the existing config read feed. */
import { createContext, useContext, useEffect, useReducer, useRef, type JSX, type ReactNode } from "react";
import type { ConfigFeed } from "./use-config.js";
import { ConfigurationStudio } from "./configuration-studio.js";
import { currentEditorTarget } from "./configuration-adapter.js";
import { useUpdateDraft } from "../update-drafts.js";
import { useAnnounce } from "../a11y/announce-context.js";

const StudioContext = createContext<{ studio?: ConfigurationStudio; version: number } | undefined>(undefined);
export function ConfigurationStudioProvider({
  feed,
  children,
}: {
  feed: ConfigFeed;
  children: ReactNode;
}): JSX.Element {
  const owned = useRef<ConfigurationStudio | undefined>(undefined);
  const [version, change] = useReducer((v: number) => v + 1, 0);
  const reload = useRef(feed.reload);
  reload.current = feed.reload;
  const announce = useAnnounce();
  const lastMessage = useRef<string | undefined>(undefined);
  if (!owned.current && feed.state.phase === "ready" && feed.state.target)
    owned.current = new ConfigurationStudio(feed.state.data, feed.state.target, window.orca, () => reload.current());
  const studio = owned.current;
  useUpdateDraft(studio?.retained ?? false);
  useEffect(() => {
    if (!studio) return;
    const unsubscribe = studio.subscribe(() => {
      change();
      const message = studio.state.message;
      if (message && message !== lastMessage.current) announce(message);
      lastMessage.current = message;
    });
    const targetOff = window.orca.daemonConnection?.subscribe(() => {
      if (feed.state.phase === "ready") studio.observe(feed.state.data, currentEditorTarget(window.orca));
    });
    const connectionOff = window.orca.connection.subscribe(() => change());
    return () => {
      unsubscribe();
      targetOff?.();
      connectionOff();
    };
  }, [studio, announce, feed.state]);
  useEffect(() => {
    if (studio && feed.state.phase === "ready") studio.observe(feed.state.data, feed.state.target);
  }, [studio, feed.state]);
  return <StudioContext.Provider value={{ ...(studio ? { studio } : {}), version }}>{children}</StudioContext.Provider>;
}
export function useConfigurationStudio(): ConfigurationStudio | undefined {
  return useContext(StudioContext)?.studio;
}
