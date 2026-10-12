/**
 * `CanvasControls` — the small group of buttons in a graph canvas's corner: zoom out, the
 * zoom level (which is also the way back to 100%), zoom in, fit, and the two view toggles —
 * the layout direction and the minimap.
 *
 * **It holds no state.** Every button calls an action the canvas's `useCanvasView` already
 * gives the keys, so a press of `+` and a click on the plus are one zoom, and the level the
 * readout shows is the one the scene is drawn at. A second zoom state here would disagree
 * with the keyboard's the first time either was used.
 *
 * **An icon is never the only label** (the brand book's iconography rule). Each icon button
 * has its action as its accessible name and as its `title`, with the key beside it where it
 * has one — `Zoom in (+)` — so the tooltip teaches the key. The two toggles are named for
 * what they will do (`Lay out top to bottom`, `Hide the minimap`) rather than carrying
 * `aria-pressed`: their state is a direction, not an on and an off, and the name is where a
 * screen reader looks. The icons are inline SVG on the 16px grid at `icon-md` with the
 * `stroke-icon` stroke in `currentColor`; there is no icon library.
 *
 * **A group, not a toolbar.** `role="toolbar"` promises arrow-key roving focus inside it, and
 * these are six ordinary tab stops after the canvas — so it is a named `group`, which promises
 * nothing it does not do. It sits *outside* the canvas's keyboard scope, deliberately: inside
 * it, `Enter` on a focused button would be the canvas's `Enter` (expand the selected node, or
 * in the editor open it) and `Delete` the editor's delete, and the map would win.
 */
import type { JSX } from "react";
import type { LayoutDirection } from "../workflow/layout.js";
import { Button } from "./button.js";
import { ZOOM_MAX, ZOOM_MIN, canZoom, zoomPercent } from "./canvas-view.js";
import { directionLabel, minimapLabel } from "./use-graph-preferences.js";

export interface CanvasControlsProps {
  /** The group's accessible name: what these controls are the view of. */
  label: string;
  /** The scale the scene is drawn at, which the readout prints and the limits are checked against. */
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Back to 100% and no pan: `0`. */
  onRest: () => void;
  onFit: () => void;
  /** The direction the graph is laid out in now; the toggle is drawn only with its handler. */
  direction?: LayoutDirection;
  onToggleDirection?: () => void;
  /** Whether the minimap is showing; the toggle is drawn only with its handler. */
  minimap?: boolean;
  onToggleMinimap?: () => void;
}

export function CanvasControls({
  label,
  scale,
  onZoomIn,
  onZoomOut,
  onRest,
  onFit,
  direction = "horizontal",
  onToggleDirection,
  minimap = true,
  onToggleMinimap,
}: CanvasControlsProps): JSX.Element {
  const level = zoomPercent(scale);
  return (
    <div className="orca-canvasctl" role="group" aria-label={label}>
      <IconButton
        name="Zoom out"
        keyHint="-"
        icon="zoom-out"
        onClick={onZoomOut}
        disabledReason={
          canZoom(scale, -1) ? undefined : `Zoomed out as far as the canvas goes, ${zoomPercent(ZOOM_MIN)}`
        }
      />
      {/* The readout is a control as well as a number: it says the level, and pressing it is
          `0`. Its name leads with what it does and ends with what it shows, so the visible
          text is inside the accessible name (WCAG's label-in-name). */}
      <Button
        size="sm"
        tone="ghost"
        className="orca-canvasctl__level"
        aria-label={`Reset the zoom and the pan, now ${level}`}
        title="Reset the zoom and the pan (0)"
        onClick={onRest}
      >
        {level}
      </Button>
      <IconButton
        name="Zoom in"
        keyHint="+"
        icon="zoom-in"
        onClick={onZoomIn}
        disabledReason={canZoom(scale, 1) ? undefined : `Zoomed in as far as the canvas goes, ${zoomPercent(ZOOM_MAX)}`}
      />
      <span className="orca-canvasctl__rule" aria-hidden="true" />
      <IconButton name="Zoom to fit the whole graph" icon="fit" onClick={onFit} />
      {onToggleDirection && (
        <IconButton
          name={directionLabel(direction)}
          icon={direction === "horizontal" ? "to-vertical" : "to-horizontal"}
          onClick={onToggleDirection}
        />
      )}
      {onToggleMinimap && <IconButton name={minimapLabel(minimap)} icon="minimap" onClick={onToggleMinimap} />}
    </div>
  );
}

type IconKind = "zoom-in" | "zoom-out" | "fit" | "to-vertical" | "to-horizontal" | "minimap";

interface IconButtonProps {
  /** The accessible name and the tooltip: what pressing it does. */
  name: string;
  /** The key that does the same, for the tooltip. */
  keyHint?: string;
  icon: IconKind;
  onClick: () => void;
  /** Set when it cannot be pressed now, and why — the tooltip then says why instead. */
  disabledReason?: string | undefined;
}

function IconButton({ name, keyHint, icon, onClick, disabledReason }: IconButtonProps): JSX.Element {
  const disabled = disabledReason !== undefined;
  return (
    <Button
      size="sm"
      tone="ghost"
      className="orca-canvasctl__icon-btn"
      aria-label={name}
      /* Button puts the reason in the title only when it is disabled; this is the title in
         both states, so the tooltip is never empty. */
      title={disabled ? disabledReason : keyHint === undefined ? name : `${name} (${keyHint})`}
      disabled={disabled}
      {...(disabled ? { disabledReason } : {})}
      onClick={onClick}
    >
      <CanvasIcon kind={icon} />
    </Button>
  );
}

/**
 * The six icons, on the 16px grid. The direction icon draws the layout it switches *to* — two
 * boxes and the edge between them, stacked or side by side — because it sits beside a name
 * that says the same.
 */
function CanvasIcon({ kind }: { kind: IconKind }): JSX.Element {
  const shape = ((): JSX.Element => {
    switch (kind) {
      case "zoom-out":
        return <path d="M3.5 8 H12.5" />;
      case "zoom-in":
        return <path d="M3.5 8 H12.5 M8 3.5 V12.5" />;
      case "fit":
        return <path d="M2.5 6 V2.5 H6 M10 2.5 H13.5 V6 M13.5 10 V13.5 H10 M6 13.5 H2.5 V10" />;
      case "to-vertical":
        return (
          <>
            <rect x="4.5" y="1.5" width="7" height="4" rx="1" />
            <rect x="4.5" y="10.5" width="7" height="4" rx="1" />
            <path d="M8 5.5 V10.5" />
          </>
        );
      case "to-horizontal":
        return (
          <>
            <rect x="1.5" y="4.5" width="4" height="7" rx="1" />
            <rect x="10.5" y="4.5" width="4" height="7" rx="1" />
            <path d="M5.5 8 H10.5" />
          </>
        );
      case "minimap":
        return (
          <>
            <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
            <rect x="8.5" y="8.5" width="4" height="3" />
          </>
        );
    }
  })();
  return (
    <svg className="orca-canvasctl__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {shape}
    </svg>
  );
}
