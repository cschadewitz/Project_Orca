/**
 * Where the palette's navigation and search rows come from.
 *
 * Commands come from the keyboard map; objects do not. Recent runs, work items, agents,
 * config files and workflows — and search over step names, event text and artifact
 * contents — belong to the surfaces that hold that data, so each surface registers a
 * source here for as long as it is mounted, the same shape as a shortcut registration.
 *
 * Three are registered as of #206 — recent runs, agents, and search over step and artifact
 * names — and they are registered beside the palette itself (`object-sources.tsx`) because
 * they are reads of the *store* rather than views of a surface's state. A source that *is* a
 * view of what a surface holds still belongs to that surface, which is what this hook is
 * for; both kinds file their rows the same way.
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type JSX, type ReactNode } from "react";
import type { PaletteEntry } from "./entries.js";

/** What a source returns: entries without a section — the registry files them by its own. */
export type SourceEntry = Omit<PaletteEntry, "section">;

export interface PaletteSource {
  /** Unique; also the prefix the registry puts on each entry's id. */
  id: string;
  section: "navigation" | "search";
  /**
   * The rows for `query`. May be async — a search over the daemon is a round trip — in
   * which case a result that arrives after the query moved on is dropped by the caller.
   */
  entries: (query: string) => readonly SourceEntry[] | Promise<readonly SourceEntry[]>;
}

export class PaletteSourceRegistry {
  private sources: readonly PaletteSource[] = [];
  private readonly listeners = new Set<() => void>();

  register(source: PaletteSource): () => void {
    const taken = this.sources.find((s) => s.id === source.id);
    if (taken) throw new Error(`palette source ${source.id} is already registered`);
    this.sources = [...this.sources, source];
    this.listeners.forEach((l) => l());
    return () => {
      this.sources = this.sources.filter((s) => s !== source);
      this.listeners.forEach((l) => l());
    };
  }

  /** A stable snapshot: `useSyncExternalStore` compares it by identity. */
  list(): readonly PaletteSource[] {
    return this.sources;
  }

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };
}

const SourceContext = createContext<PaletteSourceRegistry | null>(null);

export function PaletteSourceProvider({
  value,
  children,
}: {
  value: PaletteSourceRegistry;
  children: ReactNode;
}): JSX.Element {
  return <SourceContext.Provider value={value}>{children}</SourceContext.Provider>;
}

export function usePaletteSourceRegistry(): PaletteSourceRegistry {
  const registry = useContext(SourceContext);
  if (!registry) throw new Error("the palette needs a <PaletteSourceProvider> above it");
  return registry;
}

/** The registered sources, re-read when one mounts or unmounts. */
export function usePaletteSources(): readonly PaletteSource[] {
  const registry = usePaletteSourceRegistry();
  return useSyncExternalStore(registry.subscribe, () => registry.list());
}

/**
 * Contribute a source for as long as the calling component is mounted. `entries` is read
 * through a ref, so a surface may pass a closure over its current data without
 * re-registering on every render.
 */
export function usePaletteSource(
  id: string,
  section: PaletteSource["section"],
  entries: PaletteSource["entries"],
): void {
  const registry = usePaletteSourceRegistry();
  const current = useRef(entries);
  current.current = entries;

  useEffect(
    () => registry.register({ id, section, entries: (query) => current.current(query) }),
    [registry, id, section],
  );
}
