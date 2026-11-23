/**
 * One read feed and persistent draft owners, mounted above the surface switch.
 *
 * ConfigurationStudioProvider owns the current target-bound structured/raw config session.
 * The existing feed retains permission-sidecar drafts and the legacy preview editor.
 *
 * `use-config.ts` holds both documents, both drafts, `expectedRevision` and the
 * `CONFIG_STALE` conflict. It used to be called by whoever needed it — the Config surface,
 * and the Agents surface's policy panel (#176) — which meant the state lived inside a
 * component that unmounts: going to Runs and back threw away what a person had typed, and
 * two callers on screen at once would have been two answers to "what is unsaved".
 *
 * So the hook runs once, here, and both consumers read it through the context:
 *
 * - **a draft survives navigation.** Config is unmounted by `App`'s surface switch like
 *   every other screen; the draft and the change count it is counted from are not.
 * - **one `config.get`.** The provider reads on mount and then listens for
 *   `config.changed`, exactly as before — it is now one read for the app rather than one
 *   per mounting of a screen.
 * - **closing the policy panel no longer discards the grant edits it was holding**, because
 *   the panel was the only thing holding them and now it is not.
 *
 * The cost is the honest one: an app that never opens Config still makes that one
 * `config.get`. A read of two small files at startup is a better trade than a draft that
 * disappears when somebody looks at a run.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";
import { useConfigFeed, type ConfigFeed } from "./use-config.js";
import { ConfigurationStudioProvider } from "./configuration-studio-context.js";
import { TemplateStudioProvider } from "../template-authoring/context.js";

const ConfigContext = createContext<ConfigFeed | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }): JSX.Element {
  const feed = useConfigFeed();
  return (
    <ConfigContext.Provider value={feed}>
      <ConfigurationStudioProvider feed={feed}>
        <TemplateStudioProvider feed={feed}>{children}</TemplateStudioProvider>
      </ConfigurationStudioProvider>
    </ConfigContext.Provider>
  );
}

/**
 * The app's one configuration feed. It throws rather than falling back to a private one:
 * a second draft model that nobody can see is the bug this provider exists to prevent.
 */
/** The feed when a provider is mounted, for a surface that only reads it as a hint (#335). */
export function useOptionalConfig(): ConfigFeed | null {
  return useContext(ConfigContext);
}

export function useConfig(): ConfigFeed {
  const feed = useContext(ConfigContext);
  if (!feed) throw new Error("useConfig needs a <ConfigProvider> above it");
  return feed;
}
