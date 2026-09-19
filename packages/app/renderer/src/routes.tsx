/**
 * What the renderer mounts. Not a router — there is one screen and one dev-only page, and
 * a router is its own decision (#148 owns the shell the screens hang off).
 *
 * `#preview` opens the primitive gallery. It is reachable only in a dev build: in a
 * production build Vite replaces `import.meta.env.DEV` with `false`, so both the branch
 * and the dynamic `import()` inside it are dead code and the preview never reaches the
 * bundle — which is why the import is written this way rather than at the top of the file.
 */
import { Suspense, lazy, useSyncExternalStore, type JSX } from "react";
import { App } from "./App.js";
import { StateView } from "./ui/index.js";

const Preview = import.meta.env.DEV ? lazy(() => import("./preview/preview.js")) : undefined;

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const route = (): string => window.location.hash;

export function Routes(): JSX.Element {
  const hash = useSyncExternalStore(subscribe, route, route);

  if (Preview !== undefined && hash === "#preview") {
    return (
      <Suspense fallback={<StateView kind="loading" title="Loading the primitive preview" />}>
        <Preview />
      </Suspense>
    );
  }
  return <App />;
}
