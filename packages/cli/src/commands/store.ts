/**
 * `orca store ...` - the store's own format (#566).
 *
 *   store format                 print the store's recorded format and what this ORCA would do
 *   store carry-forward          convert an older-format store, with every other ORCA stopped
 *
 * Ordinary startup never converts a store from an older format; it refuses with
 * STORE_FORMAT / CARRYOVER_REQUIRED and points here. `carry-forward` is the explicit, offline
 * step: it backs the whole store up into `format-backups/`, confirms nothing else wrote
 * meanwhile and that this ORCA can read everything, and only then stamps the current format.
 */
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import {
  carryStoreForward,
  enterStoreFormat,
  readStoreFormat,
  STORE_FORMAT_EPOCH,
  StoreFormatError,
} from "@orca/store";
import { assertNoUnownedFirstRunMutation } from "@orca/protocol/first-run-fence";
import { loadConfig } from "../bootstrap.js";
import { readOrcaVersion } from "../version.js";
import { storePrivacy } from "../store-privacy.js";
import type { CommandContext } from "./index.js";

export async function storeCommand(ctx: CommandContext): Promise<number> {
  const [sub = "format"] = ctx.positionals;
  const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
  const storeDir = resolve(configDir, config.storeDir);
  switch (sub) {
    case "format": {
      const marker = await readStoreFormat(storeDir);
      ctx.out(`store            ${storeDir}`);
      ctx.out(`recorded format  ${marker ? `${marker.epoch} (written by ORCA ${marker.writtenBy})` : "none"}`);
      ctx.out(`this ORCA        ${STORE_FORMAT_EPOCH} (ORCA ${readOrcaVersion()})`);
      try {
        const outcome = await enterStoreFormat(storeDir, { appVersion: readOrcaVersion(), mode: "read" });
        ctx.out(
          `on startup       ${outcome.status === "current" ? "opens in place" : `${outcome.status}: stamps the current format`}`,
        );
      } catch (error) {
        ctx.out(`on startup       refused: ${(error as Error).message}`);
        return 1;
      }
      return 0;
    }
    case "carry-forward": {
      refuseAppOwned(configDir, storeDir);
      const privacy = storePrivacy();
      const outcome = await carryStoreForward(storeDir, {
        appVersion: readOrcaVersion(),
        ...(privacy ? { privacy } : {}),
      });
      if (outcome.status === "carried")
        ctx.out(`carried ${storeDir} forward from ${outcome.from} to ${outcome.epoch}; backup in ${outcome.backup}`);
      else ctx.out(`${storeDir} is already in store format ${outcome.epoch}; nothing to do`);
      return 0;
    }
    default:
      throw new OrcaError("CONFIG_INVALID", `unknown store subcommand '${sub}' (format | carry-forward)`);
  }
}

/**
 * The desktop app's own workspaces are written only by the daemon the app launches, which holds
 * the workspace's first-run writer fence. This command cannot hold that fence, and the format
 * lock does not keep that daemon out, so it refuses there: the app carries its store forward
 * itself on the first start after an update (#897).
 */
function refuseAppOwned(configDir: string, storeDir: string): void {
  for (const path of [configDir, storeDir])
    try {
      assertNoUnownedFirstRunMutation(path);
    } catch {
      throw new StoreFormatError(
        "APP_OWNED",
        `${storeDir} belongs to the ORCA desktop app, which carries it forward itself after an update. This command cannot hold the app's write fence, so it changed nothing.`,
        storeDir,
      );
    }
}
