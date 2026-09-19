/**
 * The renderer's entry point: load the design system's CSS layer, then mount React.
 *
 * Import order is the cascade order the README states — tokens first (the custom
 * properties everything else references), then the component layer, then whatever this
 * app adds on top. Vite emits one stylesheet in this order for the build and injects the
 * same order in dev, so there is no separate `<link>` list to keep in step.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@orca/design/css/tokens.css";
import "@orca/design/css/components.css";
import "./app.css";
import { Routes } from "./routes.js";

const root = document.getElementById("root");
if (!root) throw new Error("renderer/index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <Routes />
  </StrictMode>,
);
