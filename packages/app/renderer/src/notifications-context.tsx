/**
 * The React side of the daemon's push channel. `notifications.ts` is deliberately
 * React-free — it imports `@orca/protocol` and nothing else — so the sharing lives here,
 * next to `keyboard-context.tsx`, which does the same job for the keyboard map.
 *
 * One stream per window, created in `main.tsx` before React mounts and handed down: the
 * stream holds a single bridge subscription for as long as anything is listening, and a
 * stream per screen would mean one IPC listener each for frames they nearly all ignore.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";
import type { NotificationStream } from "./notifications.js";

const NotificationContext = createContext<NotificationStream | null>(null);

export function NotificationProvider({
  value,
  children,
}: {
  value: NotificationStream;
  children: ReactNode;
}): JSX.Element {
  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications(): NotificationStream {
  const stream = useContext(NotificationContext);
  if (!stream) throw new Error("useNotifications needs a <NotificationProvider> above it");
  return stream;
}
