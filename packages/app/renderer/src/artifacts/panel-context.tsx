/**
 * What the docked panel is showing, held at App level rather than inside a surface.
 *
 * The seam this exists for: an artifact chip on a step, the panel's open state and the
 * panel's contents are one act — clicking the chip has to put the artifact in the panel
 * *and* open the panel — and the chip and the panel are in different subtrees. A surface
 * that owned the state could only ever open the panel from itself, and there are already
 * three other callers coming: the attention surface's gate cards show the artifacts a
 * decision is about, the run tree's steps show what they produced, and `orca://artifact/
 * spec.md@v3` (#165) has to land on the panel from the route table, which is above every
 * surface. So the state is above every surface too.
 *
 * The target is `{ runId, name, version, compareWith? }` — an *address*, not an artifact.
 * `artifacts.list` by run and name gives the versions and `artifacts.get` gives the body,
 * so the panel can be opened by something that only has a name and a version (which is
 * exactly what a deep link has) rather than only by something holding an `ArtifactView`.
 * `version` is required for the same reason: "the latest" is a different thing five minutes
 * later, and a panel that silently moved would be a panel nobody could cite.
 *
 * Opening the docked panel itself is the chrome's, so the provider takes `onOpen` and calls
 * it. That keeps `App.tsx` to one wrap and keeps this file out of the business of knowing
 * whether the panel is a grid column or an overlay today.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

/** The artifact the docked panel is showing, as an address the wire can resolve. */
export interface ArtifactTarget {
  runId: string;
  /** The logical name within the run (`spec`, `review-2`) — what `artifacts.list` groups by. */
  name: string;
  version: number;
  /** When set, the body renders as a diff against this version of the same name. */
  compareWith?: number;
}

export interface ArtifactPanelController {
  /** What the panel is showing, or `undefined` when nothing has been opened. */
  target: ArtifactTarget | undefined;
  /** Show this artifact, opening the docked panel if it is closed. */
  open: (target: ArtifactTarget) => void;
  /** Step to another version of the artifact already open. `[` / `]` and the version menu. */
  select: (version: number) => void;
  /** Diff against this version, or `undefined` to go back to the body. */
  compare: (version: number | undefined) => void;
  /** Forget the artifact. The panel stays open on its empty state; `⌘\` closes the panel. */
  clear: () => void;
}

const PanelContext = createContext<ArtifactPanelController | null>(null);

export interface ArtifactPanelProviderProps {
  children: ReactNode;
  /** Called when something asks for an artifact: the chrome opens the docked panel. */
  onOpen?: () => void;
}

export function ArtifactPanelProvider({ children, onOpen }: ArtifactPanelProviderProps): JSX.Element {
  const [target, setTarget] = useState<ArtifactTarget | undefined>(undefined);

  /* Through a ref so the controller keeps one identity: it is in a context, and a new
     object on every render of the chrome would re-render every consumer below it. */
  const open = useRef(onOpen);
  open.current = onOpen;

  const openTarget = useCallback((next: ArtifactTarget) => {
    setTarget(next);
    open.current?.();
  }, []);

  const select = useCallback((version: number) => {
    // A version step drops the comparison: `[` twice should walk the history, not
    // accumulate a diff against a version the person has since left behind.
    setTarget((current) => (current ? { runId: current.runId, name: current.name, version } : current));
  }, []);

  const compare = useCallback((version: number | undefined) => {
    setTarget((current) =>
      current
        ? {
            runId: current.runId,
            name: current.name,
            version: current.version,
            ...(version === undefined ? {} : { compareWith: version }),
          }
        : current,
    );
  }, []);

  const clear = useCallback(() => setTarget(undefined), []);

  const value = useMemo<ArtifactPanelController>(
    () => ({ target, open: openTarget, select, compare, clear }),
    [target, openTarget, select, compare, clear],
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/**
 * The controller. Throws without a provider, because a chip that cannot open the panel is
 * a chip that does nothing when clicked — a failure worth having loudly.
 */
export function useArtifactPanel(): ArtifactPanelController {
  const controller = useContext(PanelContext);
  if (!controller) throw new Error("useArtifactPanel needs an <ArtifactPanelProvider> above it");
  return controller;
}

/**
 * The controller if there is one. For a component that must still render in a tree with no
 * provider — `#preview`, a primitive test — and that only needs the panel once something
 * is clicked.
 */
export function useOptionalArtifactPanel(): ArtifactPanelController | null {
  return useContext(PanelContext);
}
