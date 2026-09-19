/// <reference lib="dom" />
/**
 * Density is one attribute, `data-density="compact"`, on a surface root. `components.css`
 * rebinds `--row-h` under it and changes nothing else; absent means comfortable. A surface
 * root is any element carrying `data-surface="<id>"`, and the id is what the preference is
 * remembered by, so the run tree can be compact while the config form stays comfortable.
 */
import type { Density } from "@orca/design";

export const SURFACE_ATTRIBUTE = "data-surface";
export const DENSITY_ATTRIBUTE = "data-density";

export function surfaceId(surface: Element): string {
  const id = surface.getAttribute(SURFACE_ATTRIBUTE);
  if (!id) throw new Error("not a surface root: no data-surface attribute");
  return id;
}

export function densityOf(surface: Element): Density {
  return surface.getAttribute(DENSITY_ATTRIBUTE) === "compact" ? "compact" : "comfortable";
}

export function applyDensity(surface: Element, density: Density): void {
  if (density === "compact") surface.setAttribute(DENSITY_ATTRIBUTE, "compact");
  else surface.removeAttribute(DENSITY_ATTRIBUTE);
}

/** Give every surface root under `scope` the density remembered for its id. */
export function applyDensities(scope: ParentNode, remembered: Readonly<Record<string, Density>>): void {
  for (const surface of scope.querySelectorAll(`[${SURFACE_ATTRIBUTE}]`)) {
    applyDensity(surface, remembered[surfaceId(surface)] ?? "comfortable");
  }
}

/**
 * The surface ⌘⇧D acts on: the one containing focus, or — when focus is nowhere in
 * particular, as on a freshly opened window — the first surface in the document, so the
 * shortcut never does nothing while a surface is on screen.
 */
export function focusedSurface(doc: Document): Element | null {
  return doc.activeElement?.closest(`[${SURFACE_ATTRIBUTE}]`) ?? doc.querySelector(`[${SURFACE_ATTRIBUTE}]`);
}

export function toggleDensity(surface: Element): Density {
  const next: Density = densityOf(surface) === "compact" ? "comfortable" : "compact";
  applyDensity(surface, next);
  return next;
}
