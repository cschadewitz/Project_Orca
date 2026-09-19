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
import { Routes } from "./routes.js";

const keyboard = new KeyboardMap(window.orca.platform);
keyboard.listen(window);
const appearance = installAppearance(window, window.orca.preferences, keyboard);

const root = document.getElementById("root");
if (!root) throw new Error("renderer/index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <AppearanceProvider value={appearance}>
      <Routes />
    </AppearanceProvider>
  </StrictMode>,
);
