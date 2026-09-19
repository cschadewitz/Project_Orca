/**
 * The renderer's entry point: load the design system's CSS layer, apply the persisted
 * theme and density, then mount React.
 *
 * Import order is the cascade order the README states — tokens first (the custom
 * properties everything else references), then the component layer, then whatever this
 * app adds on top. Vite emits one stylesheet in this order for the build and injects the
 * same order in dev, so there is no separate `<link>` list to keep in step.
 *
 * Appearance is installed before `render`, not in an effect: an effect runs after the first
 * commit, and a window opened in dark would paint the OS theme for a frame first.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@orca/design/css/tokens.css";
import "@orca/design/css/components.css";
import "./app.css";
import { installAppearance } from "./appearance.js";
import { AppearanceProvider } from "./appearance-context.js";
import { KeyboardMap } from "./keyboard-map.js";
import { KeyboardProvider } from "./keyboard-context.js";
import { LayerStack } from "./layers.js";
import { LayerStackProvider } from "./layers-context.js";
import { PaletteSourceRegistry, PaletteSourceProvider } from "./palette/sources.js";
import { Routes } from "./routes.js";

const keyboard = new KeyboardMap(window.orca.platform);
keyboard.listen(window);
const appearance = installAppearance(window, window.orca.preferences, keyboard);
/* Both outlive any one screen and neither is React state: the layer stack is what Esc
   reads, and the source registry is what the palette reads. */
const layers = new LayerStack();
const paletteSources = new PaletteSourceRegistry();

const root = document.getElementById("root");
if (!root) throw new Error("renderer/index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <KeyboardProvider value={keyboard}>
      <LayerStackProvider value={layers}>
        <PaletteSourceProvider value={paletteSources}>
          <AppearanceProvider value={appearance}>
            <Routes />
          </AppearanceProvider>
        </PaletteSourceProvider>
      </LayerStackProvider>
    </KeyboardProvider>
  </StrictMode>,
);
