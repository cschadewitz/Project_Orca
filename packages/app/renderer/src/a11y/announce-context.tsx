/**
 * The React side of `announce.ts`: the channel distributed, and the one-line hook a
 * surface uses to put a sentence in the app's single live region.
 *
 * A surface that wants to announce something adds to the fold; it does not add a region
 * (AGENTS.md). `useAnnounce()` is that fold's front door for the things the daemon never
 * pushes — a save that landed, a save that was refused.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";
import { createAnnouncements, type Announcements } from "./announce.js";

/**
 * A channel with no announcer listening is not an error: a primitive test mounts one
 * component and nothing else, and a surface must not have to stand up the chrome to be
 * allowed to speak. The sentences go nowhere, which is exactly what "no region is mounted"
 * means.
 */
const AnnouncementsContext = createContext<Announcements>(createAnnouncements());

export function AnnouncementsProvider({
  value,
  children,
}: {
  value: Announcements;
  children: ReactNode;
}): JSX.Element {
  return <AnnouncementsContext.Provider value={value}>{children}</AnnouncementsContext.Provider>;
}

export function useAnnouncements(): Announcements {
  return useContext(AnnouncementsContext);
}

/** The only half of the channel a surface needs: say this. */
export function useAnnounce(): (sentence: string) => void {
  return useAnnouncements().say;
}
