/**
 * The JEV evaluation plugin. Its default export is what `plugins:` in orca.config.yaml loads:
 * an `OrcaPlugin` that registers `custom:jev-eval`, configured from the environment
 * (`TYPESAFE_API_KEY`, `ORCA_JEV_MODEL`, `TYPESAFE_BASE_URL`) at the moment a node runs, so
 * loading the plugin without credentials costs nothing and only an evaluation fails.
 */
import { definePlugin, type OrcaPlugin } from "@orca/engine";
import { jevEvalExecutor, type JevEvalOptions } from "./executor.js";

export function createJevEvalPlugin(options: JevEvalOptions = {}): OrcaPlugin {
  return definePlugin({
    name: "jev-eval",
    register(api) {
      api.executors.register(jevEvalExecutor(options));
    },
  });
}

/** The environment-configured plugin: `plugins: ["@orca/integrations/jev-eval"]`. */
export const jevEvalPlugin: OrcaPlugin = createJevEvalPlugin();

export default jevEvalPlugin;
