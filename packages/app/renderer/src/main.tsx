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
import { createNotificationStream } from "./notifications.js";
import { NotificationProvider } from "./notifications-context.js";
import { PaletteSourceRegistry, PaletteSourceProvider } from "./palette/sources.js";
import { createAnnouncements } from "./a11y/announce.js";
import { AnnouncementsProvider } from "./a11y/announce-context.js";
import { Routes } from "./routes.js";

const keyboard = new KeyboardMap(window.orca.platform);
keyboard.listen(window);
const announcements = createAnnouncements();
const appearance = installAppearance(window, window.orca.preferences, keyboard, announcements.say);
/* All three outlive any one screen and none of them is React state: the layer stack is what
   Esc reads, the source registry is what the palette reads, and the notification stream is
   one bridge subscription shared by every screen that listens (see notifications.ts). */
const layers = new LayerStack();
const paletteSources = new PaletteSourceRegistry();
const notifications = createNotificationStream(window.orca.notifications);
const root = document.getElementById("root");
if (!root) throw new Error("renderer/index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <KeyboardProvider value={keyboard}>
      <LayerStackProvider value={layers}>
        <PaletteSourceProvider value={paletteSources}>
          <NotificationProvider value={notifications}>
            <AppearanceProvider value={appearance}>
              <AnnouncementsProvider value={announcements}>
                <Routes />
              </AnnouncementsProvider>
            </AppearanceProvider>
          </NotificationProvider>
        </PaletteSourceProvider>
      </LayerStackProvider>
    </KeyboardProvider>
  </StrictMode>,
);
