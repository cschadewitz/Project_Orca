/**
 * What the renderer mounts: the window chrome, or the dev-only primitive gallery. Not a
 * router — which surface the chrome shows is its own state (`App.tsx`), and a URL-driven
 * router is a decision the surfaces can make when they have something to address.
 *
 * `#preview` opens the primitive gallery and `#type` the type and glyph proof surface
 * (#194). Both are reachable only in a dev build: in a production build Vite replaces
 * `import.meta.env.DEV` with `false`, so each branch and the dynamic `import()` inside it
 * are dead code and neither surface reaches the bundle — which is why the imports are
 * written this way rather than at the top of the file.
 */
import { Suspense, lazy, useSyncExternalStore, type JSX } from "react";
import { App } from "./App.js";
import { StateView } from "./ui/index.js";

const Preview = import.meta.env.DEV ? lazy(() => import("./preview/preview.js")) : undefined;
const TypeProof = import.meta.env.DEV ? lazy(() => import("./preview/type-proof.js")) : undefined;
const ResourcesPreview = import.meta.env.DEV ? lazy(() => import("./preview/resources.js")) : undefined;

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const route = (): string => window.location.hash;

export function Routes(): JSX.Element {
  const hash = useSyncExternalStore(subscribe, route, route);

  if (ResourcesPreview !== undefined && hash === "#resources") {
    return (
      <Suspense fallback={<StateView kind="loading" title="Loading resource fixtures" />}>
        <ResourcesPreview />
      </Suspense>
    );
  }
  if (Preview !== undefined && hash === "#preview") {
    return (
      <Suspense fallback={<StateView kind="loading" title="Loading the primitive preview" />}>
        <Preview />
      </Suspense>
    );
  }
  if (TypeProof !== undefined && hash === "#type") {
    return (
      <Suspense fallback={<StateView kind="loading" title="Loading the type proof" />}>
        <TypeProof />
      </Suspense>
    );
  }
  return <App />;
}
