/**
 * The bits of the renderer that `main.tsx` installs above React — the keyboard map, the
 * layer stack, the palette source registry and appearance — assembled for a test.
 *
 * Deliberately small. The full renderer harness (dual-theme rendering, fake preload
 * bridge fixtures, coverage thresholds for packages/app) is #154; this is what the chrome
 * and the palette need to be rendered at all, in one place so the two test files do not
 * drift apart.
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
import { PaletteSourceProvider, PaletteSourceRegistry } from "../src/palette/sources.js";
import type { BridgeResult } from "../../src/bridge.js";
import { DEFAULT_PREFERENCES, mergePreferences, type Preferences } from "../../src/preferences/schema.js";

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

export function stubBridge(hello: () => Promise<BridgeResult<HelloResult>>, platform = "darwin"): void {
  const bridge = { platform, hello, preferences: { read: () => DEFAULT_PREFERENCES, write: () => {} } };
  Object.defineProperty(window, "orca", { configurable: true, writable: true, value: bridge });
}

export interface Harness {
  keyboard: KeyboardMap;
  layers: LayerStack;
  paletteSources: PaletteSourceRegistry;
  dispose: () => void;
  /** The providers `main.tsx` wraps the app in, around whatever is being tested. */
  Providers: (props: { children: ReactNode }) => JSX.Element;
}

/** Everything `main.tsx` builds before `createRoot`. Call `dispose` in `afterEach`. */
export function harness(platform = "darwin"): Harness {
  const keyboard = new KeyboardMap(platform);
  const layers = new LayerStack();
  const paletteSources = new PaletteSourceRegistry();
  const appearance = installAppearance(window, memoryStore(), keyboard);
  const unlisten = keyboard.listen(window);

  return {
    keyboard,
    layers,
    paletteSources,
    dispose: () => {
      unlisten();
      appearance.dispose();
    },
    Providers: ({ children }) => (
      <KeyboardProvider value={keyboard}>
        <LayerStackProvider value={layers}>
          <PaletteSourceProvider value={paletteSources}>
            <AppearanceProvider value={appearance}>{children}</AppearanceProvider>
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
