/**
 * The route table: one `orca://` URL in, one object out — and the same object whichever way
 * the URL arrived.
 *
 * `palette/jump.ts` is the recognising half (a bare run id or a pasted URL becomes the
 * canonical URL a person meant); this is the resolving half, and it is deliberately the
 * *only* one. A cold start's command line, macOS's `open-url`, a second launch's
 * `second-instance` and the palette all end here, because three resolvers would be three
 * behaviours and the palette's own entries are required to hand back canonical URLs
 * (docs/design/10-information-architecture.md, #206).
 *
 * A `Route` names a surface and what is selected on it. It does *not* resolve a step run id
 * or an artifact id: those need a `runs.get` that belongs to the surface holding the data,
 * and a route table that read from the daemon would be a second place the app fetches runs.
 *
 * Three things the information architecture's table got wrong, corrected here and in it:
 *
 * - **`orca://artifact/<name>@v<n>` names no run.** Versions are monotonic per (run, name),
 *   so the bare form addresses nothing — the canonical form carries `?run=`, which is what
 *   **Copy link** emits, and a bare name is a palette *search* rather than a link.
 * - **`orca://item/…` names a surface that does not exist yet** (Plan is v0.5.0). It
 *   resolves, selects its surface and lands on its unbuilt state with the id shown; it is
 *   not dropped and it is not an error. `orca://workflow/…` was in the same sentence until
 *   #177 built the viewer: it lands on Config, on the real surface, with `?run=` overlaying
 *   the run — while Config with no workflow named is still the unbuilt state, because
 *   Config's own screen is #180.
 * - **`orca://agent/<id>`** is added: the Agents surface shipped in v0.4.0 and the palette
 *   lists agents, and every palette entry has to return a canonical URL.
 * - **`orca://config` and `orca://config/permissions`** are added with the Config surface
 *   (#175). The surface shows two documents, and a link to "the permission sidecar" is a
 *   link to a different object than "the configuration" — so the document is the path,
 *   defaulting to the YAML. There is no third form: a link to one *field* would be a link
 *   into a file whose keys change, and the palette's config rows name documents.
 */
import type { ConfigDocument } from "@orca/protocol";
import type { SurfaceId } from "./chrome/surfaces.js";
import type { Crumb, CrumbType } from "./ui/index.js";

/** The scheme, once. */
export const ORCA_SCHEME = "orca:";

/** A step is addressed by node and attempt — `build.2` — because a step run id is opaque. */
export interface StepAddress {
  nodeId: string;
  /** Absent means "whichever attempt is current", which is what a run's own tree shows. */
  attempt?: number;
}

/**
 * Where a URL leads. Every variant carries the surface, so selecting one is the same line
 * of code for all of them and a new route cannot forget to name where it lives.
 */
export type Route =
  | { kind: "run"; surface: "runs"; runId: string; step?: StepAddress }
  | { kind: "gate"; surface: "attention"; inputId: string }
  | { kind: "item"; surface: "plan"; itemId: string }
  /** `orca://plan?mode=deps&focus=<id>` (#171): the Plan surface in a mode, something selected. */
  | { kind: "plan"; surface: "plan"; mode?: string; focus?: string }
  | { kind: "artifact"; surface: "runs"; name: string; version?: number; runId?: string }
  | { kind: "workflow"; surface: "config"; workflowId: string; runId?: string }
  | { kind: "agent"; surface: "agents"; agentId: string }
  | { kind: "config"; surface: "config"; document: ConfigDocument };

/** `build.2` — the node, and the attempt when one is named. */
function parseStep(segment: string): StepAddress {
  const dot = segment.lastIndexOf(".");
  const attempt = dot === -1 ? Number.NaN : Number(segment.slice(dot + 1));
  // A node id may contain dots of its own, so a trailing number is an attempt and anything
  // else is part of the name: `deploy.eu-west` is one node, `deploy.eu-west.2` is its
  // second attempt.
  return Number.isInteger(attempt) && attempt > 0 ? { nodeId: segment.slice(0, dot), attempt } : { nodeId: segment };
}

/** `spec.md@v3` — the name, and the version when one is pinned. */
function parseArtifact(segment: string): { name: string; version?: number } {
  const at = segment.lastIndexOf("@v");
  if (at === -1) return { name: segment };
  const version = Number(segment.slice(at + 2));
  return Number.isInteger(version) && version > 0 ? { name: segment.slice(0, at), version } : { name: segment };
}

/**
 * The object a URL names, or undefined when it names none.
 *
 * Undefined is not an error state a screen has to render as a failure: a URL this version
 * does not know is a newer app's, and the honest answer is to say so where the person can
 * see it rather than to open something that was not asked for.
 */
export function resolveRoute(url: string): Route | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol.toLowerCase() !== ORCA_SCHEME) return undefined;

  // The object *type* is the URL's host, which the parser has already lower-cased for us;
  // the id is the path, which it has left exactly as it was written.
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  const [first, second, third] = segments.map(decodeURIComponent);
  const run = parsed.searchParams.get("run") ?? undefined;

  switch (parsed.host) {
    case "run": {
      if (first === undefined) return undefined;
      if (second === "step" && third !== undefined) {
        return { kind: "run", surface: "runs", runId: first, step: parseStep(third) };
      }
      return { kind: "run", surface: "runs", runId: first };
    }
    case "gate":
      return first === undefined ? undefined : { kind: "gate", surface: "attention", inputId: first };
    case "item":
      return first === undefined ? undefined : { kind: "item", surface: "plan", itemId: first };
    case "plan": {
      /* The plan is the surface's object, so the host names it and the query says how it is
         shown. A path after it is a link this version does not know. */
      if (first !== undefined) return undefined;
      const mode = parsed.searchParams.get("mode") ?? undefined;
      const focus = parsed.searchParams.get("focus") ?? undefined;
      return {
        kind: "plan",
        surface: "plan",
        ...(mode !== undefined ? { mode } : {}),
        ...(focus !== undefined ? { focus } : {}),
      };
    }
    case "artifact": {
      if (first === undefined) return undefined;
      const { name, version } = parseArtifact(first);
      return {
        kind: "artifact",
        surface: "runs",
        name,
        ...(version !== undefined ? { version } : {}),
        ...(run !== undefined ? { runId: run } : {}),
      };
    }
    case "workflow":
      return first === undefined
        ? undefined
        : { kind: "workflow", surface: "config", workflowId: first, ...(run !== undefined ? { runId: run } : {}) };
    case "agent":
      return first === undefined ? undefined : { kind: "agent", surface: "agents", agentId: first };
    case "config":
      /* The bare URL is the YAML, which is what "the configuration" means to everybody who
         is not thinking about ADR 0009. An unrecognised second segment resolves to nothing
         rather than silently landing on the YAML: `orca://config/agents` is somebody
         expecting a link this app does not have. */
      if (first === undefined) return { kind: "config", surface: "config", document: "config" };
      return first === "permissions" || first === "config"
        ? { kind: "config", surface: "config", document: first }
        : undefined;
    default:
      return undefined;
  }
}

/** The surface a route lands on — `App` selects it whether or not the object resolves. */
export const surfaceFor = (route: Route): SurfaceId => route.surface;

/* ---------- the canonical URLs, which are what Copy link and the palette emit ---------- */

const path = (type: string, id: string): string => `orca://${type}/${encodeURIComponent(id)}`;

export const runUrl = (runId: string): string => path("run", runId);

export const stepUrl = (runId: string, nodeId: string, attempt?: number): string =>
  `${runUrl(runId)}/step/${encodeURIComponent(attempt === undefined ? nodeId : `${nodeId}.${attempt}`)}`;

export const gateUrl = (inputId: string): string => path("gate", inputId);

export const itemUrl = (itemId: string): string => path("item", itemId);

/** The Plan surface in a mode, optionally focused on an item or a node (#171). */
export function planUrl(mode?: string, focus?: string): string {
  const query = new URLSearchParams();
  if (mode !== undefined) query.set("mode", mode);
  if (focus !== undefined) query.set("focus", focus);
  const text = query.toString();
  return text === "" ? "orca://plan" : `orca://plan?${text}`;
}

export const agentUrl = (agentId: string): string => path("agent", agentId);

/** The Config surface. The YAML is the bare URL; the ADR 0009 sidecar names itself. */
export const configUrl = (document: ConfigDocument = "config"): string =>
  document === "config" ? "orca://config" : path("config", document);

/**
 * An artifact always carries its run. A version is monotonic per (run, name), so
 * `spec.md@v3` on its own names as many artifacts as there are runs that produced one.
 */
export const artifactUrl = (runId: string, name: string, version?: number): string =>
  `orca://artifact/${encodeURIComponent(version === undefined ? name : `${name}@v${version}`)}?run=${encodeURIComponent(runId)}`;

export const workflowUrl = (workflowId: string, runId?: string): string =>
  runId === undefined
    ? path("workflow", workflowId)
    : `${path("workflow", workflowId)}?run=${encodeURIComponent(runId)}`;

/**
 * The URL for a crumb in the object header, which is what **Copy link** copies and what
 * clicking a crumb opens.
 *
 * A step crumb is the one that cannot be written as a link from the crumb alone: its id is
 * a step *run* id and the canonical form is node-and-attempt within a run, so the run's
 * crumb has to be in hand — which it always is, because the trail is request ▸ item ▸ run ▸
 * step and a step crumb never appears without the run above it. A crumb type with no
 * canonical URL answers undefined, which is what leaves it plain text rather than a link
 * that goes nowhere — `request` is the only one left, because nothing addresses a request.
 */
export function urlForCrumb(crumbs: readonly Crumb[], crumb: Crumb): string | undefined {
  const runId = crumbs.find((c) => c.type === "run")?.id;
  const forType: Partial<Record<CrumbType, () => string | undefined>> = {
    run: () => runUrl(crumb.id),
    item: () => itemUrl(crumb.id),
    workflow: () => workflowUrl(crumb.id),
    agent: () => agentUrl(crumb.id),
    /* The Config surface's crumb is one of its two documents, and the crumb's label is the
       file name — which is how the sidecar is told from the YAML without putting an
       absolute path in a URL that would then differ between two checkouts of one repo. */
    config: () => configUrl(crumb.label.endsWith(".json") ? "permissions" : "config"),
    // The label is the node id (`runs-surface.tsx` builds the crumb from `StepView.nodeId`),
    // and the attempt is already part of that label where there is more than one.
    step: () => (runId === undefined ? undefined : stepUrl(runId, crumb.label)),
  };
  return forType[crumb.type]?.();
}

/**
 * The URL behind a crumb's counterpart, or undefined when the app cannot name the object
 * from what the header holds.
 *
 * Two of the four the spec lists are addressable now, by two different routes, and the
 * difference is worth keeping straight:
 *
 * - **the work item a run claims** is the crumb above it, because the trail *is* request ▸
 *   work item ▸ run ▸ step. Nothing has to be carried for it.
 * - **the workflow a run executes** is not in the trail — a `RunSummaryView` has a
 *   `workflowId` and the breadcrumb does not — so the surface that built the crumb puts it
 *   in `counterpartIds` and this reads it back (#177). The run is carried through as `?run=`,
 *   which is what makes the menu item open the viewer *with the run overlaid* rather than
 *   the bare definition.
 *
 * The other two — the runs that attempted a work item, a work item's dependencies — are
 * queries over data no crumb holds, and they belong to the Plan surface that will answer
 * them. Undefined is what makes those items say so rather than silently doing nothing.
 */
export function counterpartUrl(
  crumbs: readonly Crumb[],
  crumb: Crumb,
  counterpart: { id: string },
): string | undefined {
  /* A work item's dependencies are the graph mode focused on it (#171). */
  if (crumb.type === "item" && counterpart.id === "dependencies") return planUrl("deps", crumb.id);
  if (crumb.type !== "run") return undefined;
  if (counterpart.id === "claimed-item") {
    const item = crumbs.find((c) => c.type === "item");
    return item ? itemUrl(item.id) : undefined;
  }
  if (counterpart.id === "workflow") {
    const workflowId = crumb.counterpartIds?.["workflow"];
    return workflowId === undefined ? undefined : workflowUrl(workflowId, crumb.id);
  }
  return undefined;
}

/**
 * What the disconnected landing says it is holding. A deep link to an object the daemon
 * cannot currently produce "lands on the object's screen in its disconnected state with the
 * id shown, never on a blank window or a generic error"
 * (docs/design/10-information-architecture.md), and this is the id and the word for it.
 */
export function describeRoute(route: Route): { type: string; id: string } {
  switch (route.kind) {
    case "run":
      return route.step
        ? {
            type: "step",
            id: route.step.attempt === undefined ? route.step.nodeId : `${route.step.nodeId}.${route.step.attempt}`,
          }
        : { type: "run", id: route.runId };
    case "gate":
      return { type: "gate", id: route.inputId };
    case "item":
      return { type: "work item", id: route.itemId };
    case "plan":
      return route.focus !== undefined
        ? { type: route.mode === "deps" ? "dependencies of" : "plan item", id: route.focus }
        : { type: "plan view", id: route.mode ?? "schedule" };
    case "artifact":
      return { type: "artifact", id: route.version === undefined ? route.name : `${route.name}@v${route.version}` };
    case "workflow":
      return { type: "workflow", id: route.workflowId };
    case "agent":
      return { type: "agent", id: route.agentId };
    case "config":
      return route.document === "permissions"
        ? { type: "document", id: "orca.permissions.json" }
        : { type: "document", id: "orca.config.yaml" };
  }
}
