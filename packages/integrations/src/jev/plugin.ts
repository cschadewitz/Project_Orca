/**
 * The JEV evaluation plugin. Its default export is what `plugins:` in orca.config.yaml loads:
 * an `OrcaPlugin` that registers `custom:jev-eval`, configured from the environment
 * (`TYPESAFE_API_KEY`, `ORCA_JEV_MODEL`, `TYPESAFE_BASE_URL`) at the moment a node runs, so
 * loading the plugin without credentials costs nothing and only an evaluation fails.
 */
import { definePlugin, type OrcaPlugin } from "@orca/engine";
import { jevEvalExecutor, type JevEvalOptions } from "./executor.js";
import {
  createJevEvalRestorationAdapter,
  createJevRestorationBridge,
  type JevRestorationBridge,
  type JevRestorationContext,
} from "./restoration.js";

export * from "./restoration.js";

export function createJevEvalPlugin(options: JevEvalOptions = {}): OrcaPlugin {
  return definePlugin({
    name: "jev-eval",
    register(api) {
      api.executors.register(jevEvalExecutor(options));
    },
  });
}

/**
 * Explicit provisional integration seam for #394. A verified bridge must wire capture and
 * isolated candidate restoration; the default export cannot claim that support yet.
 */
export function createRestorableJevEvalPlugin(
  options: JevEvalOptions,
  context: JevRestorationContext,
  bridge: JevRestorationBridge = createJevRestorationBridge(context),
): OrcaPlugin {
  const adapter = createJevEvalRestorationAdapter(options, context);
  const captured = adapter.capture();
  if (!captured.ok) throw new Error(`JEV restoration ${captured.reason}: ${captured.remediation}`);
  const restored = adapter.restore(captured.value);
  if (!restored.ok) throw new Error(`JEV restoration ${restored.reason}: ${restored.remediation}`);
  return bridge.attach(
    definePlugin({
      name: "jev-eval",
      register(api) {
        api.executors.register(restored.value);
      },
    }),
    adapter,
  );
}

/** The environment-configured plugin: `plugins: ["@orca/integrations/jev-eval"]`. */
export const jevEvalPlugin: OrcaPlugin = createJevEvalPlugin();

export default jevEvalPlugin;
