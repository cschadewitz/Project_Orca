/**
 * The bits of the renderer that `main.tsx` installs above React — the keyboard map, the
 * layer stack, the palette source registry and appearance — assembled for a test.
 *
 * The other two halves of the renderer test kit live next door and are worth knowing about
 * before writing a screen test:
 *
 * - `themes.tsx` — mount a component in both themes and assert on the colour the real
 *   `tokens.css` resolves it to (docs/design/RULES.md rule 7);
 * - `fake-bridge.ts` — a `window.orca` that answers `hello`, the five read methods and
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
import { PaletteSourceProvider, PaletteSourceRegistry } from "../src/palette/sources.js";
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

/** The handshake only, for the chrome tests: everything else keeps the fixture answers. */
export function stubBridge(hello: () => Promise<BridgeResult<HelloResult>>, platform = "darwin"): void {
  const fake = fakeBridge({ platform });
  fake.script({ hello });
  fake.install();
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
