/**
 * The bits of the renderer that `main.tsx` installs above React — the keyboard map, the
 * layer stack, the palette source registry and appearance — assembled for a test.
 *
 * The other two halves of the renderer test kit live next door and are worth knowing about
 * before writing a screen test:
 *
 * - `themes.tsx` — mount a component in both themes and assert on the colour the real
 *   `tokens.css` resolves it to (docs/design/RULES.md rule 7);
 * - `fake-bridge.ts` — a `window.orca` that answers `hello`, the eight read methods and
 *   daemon notifications from `fixtures.ts`. `installBridge` below is the short way in.
 */
import { render, type RenderResult } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import type { HelloResult } from "@orca/protocol";
import { App } from "../src/App.js";
import { AppearanceProvider } from "../src/appearance-context.js";
import { installAppearance, type AppearanceStore } from "../src/appearance.js";
import { KeyboardMap } from "../src/keyboard-map.js";
import { KeyboardProvider } from "../src/keyboard-context.js";
import { LayerStack } from "../src/layers.js";
import { LayerStackProvider } from "../src/layers-context.js";
import { createNotificationStream, type NotificationSource, type NotificationStream } from "../src/notifications.js";
import { NotificationProvider } from "../src/notifications-context.js";
import { PaletteSourceProvider, PaletteSourceRegistry } from "../src/palette/sources.js";
import { ArtifactPanelProvider } from "../src/artifacts/panel-context.js";
import type { BridgeResult } from "../../src/bridge.js";
import { DEFAULT_PREFERENCES, mergePreferences, type Preferences } from "../../src/preferences/schema.js";
import { fakeBridge, type FakeBridge, type FakeBridgeOptions } from "./fake-bridge.js";

export const LIVE: BridgeResult<HelloResult> = {
  ok: true,
  result: { protocol: { major: 1, minor: 0 }, orcaVersion: "0.2.0-test", capabilities: [] },
};

/** Preferences that never touch disk; the chrome only reads them through `Appearance`. */
export function memoryStore(): AppearanceStore {
  let preferences: Preferences = DEFAULT_PREFERENCES;
  return {
    read: () => preferences,
    write: (patch) => {
      preferences = mergePreferences(preferences, patch);
      return Promise.resolve({ ok: true, result: preferences });
    },
  };
}

export function stubMatchMedia(width: number): void {
  const matchMedia = (query: string): MediaQueryList => {
    const threshold = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches = threshold ? width <= Number(threshold[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
}

/**
 * A fake bridge on `window.orca`, with the read methods answering from `fixtures.ts`.
 * Call the returned `install` result — see `fake-bridge.ts` — in `afterEach` to put back
 * whatever was there; a test that only needs the handshake can use `stubBridge` instead.
 */
export function installBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const fake = fakeBridge(options);
  fake.install();
  return fake;
}

/**
 * The handshake only, for the chrome tests: everything else keeps the fixture answers. The
 * fake is returned so a chrome test can still push a notification or read `calls`.
 */
export function stubBridge(hello: () => Promise<BridgeResult<HelloResult>>, platform = "darwin"): FakeBridge {
  const fake = fakeBridge({ platform });
  fake.script({ hello });
  fake.install();
  return fake;
}

export interface Harness {
  keyboard: KeyboardMap;
  layers: LayerStack;
  paletteSources: PaletteSourceRegistry;
  /** The push channel the surfaces listen on; `FakeBridge.notify` is what feeds it. */
  notifications: NotificationStream;
  dispose: () => void;
  /** The providers `main.tsx` wraps the app in, around whatever is being tested. */
  Providers: (props: { children: ReactNode }) => JSX.Element;
}

/** A source that never pushes, for a harness built before any bridge was installed. */
const SILENT: NotificationSource = { subscribe: () => () => {} };

/**
 * Everything `main.tsx` builds before `createRoot`. Call `dispose` in `afterEach`.
 *
 * Install the bridge first (`installBridge` / `stubBridge`) when the test needs
 * notifications: the stream is built over `window.orca.notifications` here, exactly as
 * `main.tsx` builds it, and a harness created before there is a bridge gets a silent source
 * rather than throwing — a primitive test that only needs the keyboard map should not have
 * to stand up a daemon.
 */
export function harness(platform = "darwin"): Harness {
  const keyboard = new KeyboardMap(platform);
  const layers = new LayerStack();
  const paletteSources = new PaletteSourceRegistry();
  const notifications = createNotificationStream((window as Partial<Window>).orca?.notifications ?? SILENT);
  const appearance = installAppearance(window, memoryStore(), keyboard);
  const unlisten = keyboard.listen(window);

  return {
    keyboard,
    layers,
    paletteSources,
    notifications,
    dispose: () => {
      unlisten();
      appearance.dispose();
    },
    Providers: ({ children }) => (
      <KeyboardProvider value={keyboard}>
        <LayerStackProvider value={layers}>
          <PaletteSourceProvider value={paletteSources}>
            <NotificationProvider value={notifications}>
              <AppearanceProvider value={appearance}>
                {/* `App` wraps every surface in this, so a surface test has to as well: a
                    step's artifact chip asks the context to put an artifact in the docked
                    panel, and the context throws rather than silently doing nothing when
                    nothing is above it. `onOpen` is the chrome's and is omitted here —
                    opening the panel is what a test of the panel asserts, not what a test
                    of a surface does. */}
                <ArtifactPanelProvider>{children}</ArtifactPanelProvider>
              </AppearanceProvider>
            </NotificationProvider>
          </PaletteSourceProvider>
        </LayerStackProvider>
      </KeyboardProvider>
    ),
  };
}

/** The whole chrome, mounted the way `main.tsx` mounts it. */
export function renderChrome(h: Harness): RenderResult {
  const { Providers } = h;
  return render(
    <Providers>
      <App />
    </Providers>,
  );
}
